use crate::app::App;
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crate::widgets::{
    contains, handle_scrollbar_down, handle_scrollbar_drag, mouse_in, render_scrollbar, Button,
    MultiSelectState, MultiSelectTableController, ScrollbarDownResult, TableHitTestSpec, TextInput,
    TextInputAction,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph, Row, Table, TableState},
    Frame,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Instant;

pub struct BrowseTab {
    endpoint: String,
    topics: Vec<BrowseTopicRow>,
    topics_state: TableState,
    topics_sel: MultiSelectState<String>,
    topics_viewport_rows: usize,
    topics_drag_select_start: Option<usize>,

    query: TextInput,
    focus: BrowseFocus,

    results: Vec<BrowseResultRow>,
    cache: BTreeMap<String, Vec<BrowseResultRow>>,
    results_state: TableState,
    results_sel: MultiSelectState<String>,
    results_scrollbar_drag: Option<usize>,
    results_viewport_rows: usize,
    results_drag_select_start: Option<usize>,

    browse_rx: Receiver<(u64, Result<Value, String>)>,
    browse_req_id: u64,
    browse_busy: Option<(String, Instant)>,

    last_error: Option<String>,
    hovered: BrowseHovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowseFocus {
    Topics,
    Search,
    Results,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowseHovered {
    None,
    Refresh,
    Download,
}

#[derive(Debug, Clone)]
struct BrowseTopicRow {
    name: String,
    joined: bool,
    peers: u64,
}

#[derive(Debug, Clone)]
struct BrowseResultRow {
    topic: String,
    name: String,
    merkle_root: String,
    size: Option<u64>,
    chunk_count: Option<u64>,
}

impl BrowseTab {
    pub fn new(endpoint: String) -> Self {
        let mut topics_state = TableState::default();
        topics_state.select(Some(0));

        let mut results_state = TableState::default();
        results_state.select(Some(0));

        let (_tx, rx) = mpsc::channel::<(u64, Result<Value, String>)>();
        Self {
            endpoint,
            topics: Vec::new(),
            topics_state,
            topics_sel: MultiSelectState::default(),
            topics_viewport_rows: 10,
            topics_drag_select_start: None,

            query: TextInput::new(),
            focus: BrowseFocus::Topics,

            results: Vec::new(),
            cache: BTreeMap::new(),
            results_state,
            results_sel: MultiSelectState::default(),
            results_scrollbar_drag: None,
            results_viewport_rows: 10,
            results_drag_select_start: None,

            browse_rx: rx,
            browse_req_id: 0,
            browse_busy: None,

            last_error: None,
            hovered: BrowseHovered::None,
        }
    }

    pub fn is_text_input_active(&self) -> bool {
        self.focus == BrowseFocus::Search
    }

    pub fn poll_async(&mut self) {
        while let Ok((req_id, res)) = self.browse_rx.try_recv() {
            if req_id != self.browse_req_id {
                continue;
            }

            self.browse_busy = None;
            match res {
                Ok(v) => {
                    self.cache = parse_browse_cache(&v);
                    self.rebuild_results_from_cache();
                    self.last_error = None;
                }
                Err(e) => {
                    self.last_error = Some(e);
                }
            }
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("network.overview", serde_json::json!({})) {
            Ok(v) => {
                let topics = v
                    .get("topics")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default();

                // Only show currently connected topics.
                self.topics = topics
                    .iter()
                    .filter_map(|t| {
                        let name = t.get("name")?.as_str()?.to_string();
                        let joined = t.get("joined").and_then(|x| x.as_bool()).unwrap_or(false);
                        let peers = t.get("peers").and_then(|x| x.as_u64()).unwrap_or(0);
                        if peers == 0 {
                            return None;
                        }
                        Some(BrowseTopicRow { name, joined, peers })
                    })
                    .collect();

                let existing: BTreeSet<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                self.topics_sel.retain_existing(&existing);

                // Select all connected topics by default (only when the user has not made a
                // selection yet).
                if self.topics_sel.selected().is_empty() {
                    let keys: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                    self.topics_sel.select_all(&keys);
                    self.topics_sel.set_anchor(self.topics_state.selected());
                }

                if self.topics.is_empty() {
                    self.topics_state.select(None);
                } else if self.topics_state.selected().is_none() {
                    self.topics_state.select(Some(0));
                }
                self.last_error = None;

                // Rebuild visible results if topic selection changed due to retain/default.
                self.rebuild_results_from_cache();
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn browse_prefetch(&mut self) {
        self.browse_reload_all_connected();
    }

    pub fn browse_refresh(&mut self, _ipc: &mut IpcClient) {
        self.browse_reload_all_connected();
    }

    fn browse_reload_all_connected(&mut self) {
        // Async: browse all connected topics and cache results per topic.
        let topics: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
        if topics.is_empty() {
            self.last_error = Some("no connected topics".to_string());
            return;
        }

        let endpoint = self.endpoint.clone();
        let (tx, rx): (Sender<(u64, Result<Value, String>)>, Receiver<(u64, Result<Value, String>)>) =
            mpsc::channel();
        self.browse_rx = rx;

        self.browse_req_id = self.browse_req_id.wrapping_add(1);
        let req_id = self.browse_req_id;
        self.browse_busy = Some((format!("browsing {} topic(s)", topics.len()), Instant::now()));
        self.last_error = None;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;

                let mut out: BTreeMap<String, Vec<Value>> = BTreeMap::new();
                for name in topics {
                    match c.rpc("browse.topic", serde_json::json!({"name": name, "timeout": 5000}))
                    {
                        Ok(v) => {
                            if let Some(arr) = v.as_array() {
                                out.insert(name, arr.iter().cloned().collect());
                            }
                        }
                        Err(e) => {
                            let _ = e;
                        }
                    }
                }

                Ok::<Value, String>(serde_json::to_value(out).map_err(|e| e.to_string())?)
            })();
            let _ = tx.send((req_id, res));
        });
    }

    pub fn download_selected(&mut self, _ipc: &mut IpcClient) {
        // Action is routed via UiCommand from on_key/on_mouse.
        let _ = _ipc;
    }

    fn selected_download_target(&self) -> Option<(String, String)> {
        if let Some(root) = self.results_sel.selected().iter().next() {
            if let Some(r) = self.results.iter().find(|x| &x.merkle_root == root) {
                return Some((r.topic.clone(), r.merkle_root.clone()));
            }
        }

        let idx = self.results_state.selected()?;
        let r = self.results.get(idx)?;
        Some((r.topic.clone(), r.merkle_root.clone()))
    }

    fn page_down(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let cur = self.topics_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.topics_viewport_rows)
                    .min(self.topics.len().saturating_sub(1));
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let cur = self.results_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.results_viewport_rows)
                    .min(self.results.len().saturating_sub(1));
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn page_up(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let cur = self.topics_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.topics_viewport_rows);
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let cur = self.results_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.results_viewport_rows);
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn rebuild_results_from_cache(&mut self) {
        let selected_topics: BTreeSet<String> = self.topics_sel.selected().iter().cloned().collect();
        let mut out: Vec<BrowseResultRow> = Vec::new();
        for (topic, rows) in &self.cache {
            if !selected_topics.contains(topic) {
                continue;
            }
            out.extend(rows.iter().cloned());
        }

        // Dedup across topics by merkle root.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        out.retain(|r| {
            if r.merkle_root.is_empty() || seen.contains(&r.merkle_root) {
                return false;
            }
            seen.insert(r.merkle_root.clone());
            true
        });

        let q = self.query.value().trim().to_lowercase();
        if !q.is_empty() {
            out.retain(|r| {
                r.name.to_lowercase().contains(&q)
                    || r.topic.to_lowercase().contains(&q)
                    || r.merkle_root.to_lowercase().contains(&q)
            });
        }

        self.results = out;

        if self.results.is_empty() {
            self.results_state.select(None);
        } else if self.results_state.selected().is_none() {
            self.results_state.select(Some(0));
        } else if let Some(sel) = self.results_state.selected() {
            self.results_state.select(Some(sel.min(self.results.len().saturating_sub(1))));
        }

        let existing: BTreeSet<String> = self.results.iter().map(|r| r.merkle_root.clone()).collect();
        self.results_sel.retain_existing(&existing);
    }

    fn toggle_topic_current(&mut self) {
        let Some(idx) = self.topics_state.selected() else {
            return;
        };
        let Some(t) = self.topics.get(idx) else {
            return;
        };
        self.topics_sel.toggle(t.name.clone(), idx);
        self.rebuild_results_from_cache();
    }

    fn toggle_result_current(&mut self) {
        let Some(idx) = self.results_state.selected() else {
            return;
        };
        let Some(r) = self.results.get(idx) else {
            return;
        };
        self.results_sel.toggle(r.merkle_root.clone(), idx);
    }

    fn nav_down(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let next = match self.topics_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                };
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let next = match self.results_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.results.len().saturating_sub(1)),
                };
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn nav_up(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let next = match self.topics_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let next = match self.results_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }
}

impl Tab for BrowseTab {
    fn id(&self) -> TabId {
        TabId::Browse
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(35), Constraint::Percentage(65)].as_ref())
            .split(chunks[0]);

        // Topics table
        self.topics_viewport_rows = main[0].height.saturating_sub(3).max(1) as usize;
        let topic_header = Row::new(vec!["Sel", "Topic", "Joined", "Peers"])
            .style(Style::default().fg(Color::Yellow));
        let topic_rows = self.topics.iter().map(|t| {
            let mark = if self.topics_sel.is_selected(&t.name) { "[x]" } else { "[ ]" };
            let joined = if t.joined { "yes" } else { "no" };
            Row::new(vec![
                mark.to_string(),
                t.name.clone(),
                joined.to_string(),
                t.peers.to_string(),
            ])
        });
        let topic_table_style = if self.focus == BrowseFocus::Topics {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let topics_table = Table::new(
            topic_rows,
            [
                Constraint::Length(4),
                Constraint::Min(10),
                Constraint::Length(6),
                Constraint::Length(6),
            ],
        )
        .header(topic_header)
        .block(
            Block::default()
                .title("Topics")
                .borders(Borders::ALL)
                .border_style(topic_table_style),
        )
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));
        f.render_stateful_widget(topics_table, main[0], &mut self.topics_state);

        // Public content area (search + results)
        let public_style = if self.focus == BrowseFocus::Search || self.focus == BrowseFocus::Results {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let public_block = Block::default()
            .title("Public content")
            .borders(Borders::ALL)
            .border_style(public_style);
        f.render_widget(public_block.clone(), main[1]);

        let public_inner = main[1].inner(Margin { vertical: 1, horizontal: 1 });
        let public_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(5)].as_ref())
            .split(public_inner);
        self.query.draw(f, public_chunks[0], "Search (/)", self.focus == BrowseFocus::Search);

        // Results table
        self.results_viewport_rows = public_chunks[1].height.saturating_sub(2).max(1) as usize;
        let results_header = Row::new(vec!["Sel", "Topic", "Name", "Size", "Chunks", "Root"])
            .style(Style::default().fg(Color::Yellow));
        let result_rows = self.results.iter().map(|r| {
            let mark = if self.results_sel.is_selected(&r.merkle_root) {
                "[x]"
            } else {
                "[ ]"
            };
            let size = r.size.map(|s| s.to_string()).unwrap_or_else(|| "".to_string());
            let chunks = r.chunk_count.map(|c| c.to_string()).unwrap_or_else(|| "".to_string());
            let root = if r.merkle_root.len() > 12 {
                r.merkle_root[..12].to_string()
            } else {
                r.merkle_root.clone()
            };
            Row::new(vec![
                mark.to_string(),
                r.topic.clone(),
                r.name.clone(),
                size,
                chunks,
                root,
            ])
        });
        let results_table = Table::new(
            result_rows,
            [
                Constraint::Length(4),
                Constraint::Length(10),
                Constraint::Min(10),
                Constraint::Length(12),
                Constraint::Length(8),
                Constraint::Length(14),
            ],
        )
        .header(results_header)
        .block(Block::default().borders(Borders::NONE))
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        let show_scrollbar = self.results.len() > self.results_viewport_rows;
        let mut results_area = public_chunks[1];
        if show_scrollbar {
            results_area.width = results_area.width.saturating_sub(1);
        }
        f.render_stateful_widget(results_table, results_area, &mut self.results_state);
        let results_table_ctrl = MultiSelectTableController::new(TableHitTestSpec {
            header_rows: 1,
            inner_margin: Margin {
                vertical: 0,
                horizontal: 0,
            },
            hit_y_shift: 0,
            hit_extra_height: 0,
            checkbox_width: 4,
            checkbox_rel_x_bias: 0,
        });
        if let Some(metrics) = results_table_ctrl.scrollbar_metrics(
            public_chunks[1],
            self.results.len(),
            self.results_state.offset(),
        ) {
            render_scrollbar(f, metrics);
        }

        // Footer actions
        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(14)].as_ref())
            .split(chunks[1]);

        let mut footer_lines: Vec<Line> = vec![Line::from(
            "Keys: / focus search | tab/space toggle | Ctrl-click toggle | Shift-click range | drag-select resets | Ctrl+A all | c clear | r browse | Enter download | PgUp/PgDn",
        )];
        if let Some((msg, started)) = &self.browse_busy {
            let secs = started.elapsed().as_secs_f32();
            footer_lines.push(Line::from(format!("Busy: {} ({:.1}s)", msg, secs)));
        }
        if let Some(e) = &self.last_error {
            footer_lines.push(Line::from(format!("Error: {}", e)));
        }
        let footer = Paragraph::new(Text::from(footer_lines))
            .block(Block::default().title("Browse").borders(Borders::ALL));
        f.render_widget(footer, footer_chunks[0]);

        let refresh_btn = Button {
            label: "Refresh".to_string(),
            enabled: true,
        };
        refresh_btn.draw(f, footer_chunks[1], self.hovered == BrowseHovered::Refresh);

        let download_btn = Button {
            label: "Download".to_string(),
            enabled: !self.results_sel.selected().is_empty() || self.results_state.selected().is_some(),
        };
        download_btn.draw(f, footer_chunks[2], self.hovered == BrowseHovered::Download);
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        match key.code {
            KeyCode::Char('/') => {
                self.focus = BrowseFocus::Search;
            }
            KeyCode::Left | KeyCode::Char('h') => {
                if self.focus != BrowseFocus::Search {
                    self.focus = BrowseFocus::Topics;
                }
            }
            KeyCode::Right | KeyCode::Char('l') => {
                if self.focus != BrowseFocus::Search {
                    self.focus = BrowseFocus::Results;
                }
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.nav_down();
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.nav_up();
            }
            KeyCode::PageDown | KeyCode::Char('J') => {
                self.page_down();
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                self.page_up();
            }
            KeyCode::Esc => {
                if self.focus == BrowseFocus::Search {
                    match self.query.handle_key(key) {
                        TextInputAction::Changed => self.rebuild_results_from_cache(),
                        TextInputAction::Cancel => {
                            if !self.query.value().is_empty() {
                                self.query.clear();
                                self.rebuild_results_from_cache();
                            } else {
                                self.focus = BrowseFocus::Results;
                            }
                        }
                        _ => {}
                    }
                } else {
                    self.focus = BrowseFocus::Results;
                }
            }
            KeyCode::Tab | KeyCode::Char(' ') => match self.focus {
                BrowseFocus::Topics => {
                    self.toggle_topic_current();
                }
                BrowseFocus::Results => {
                    self.toggle_result_current();
                }
                BrowseFocus::Search => {}
            },
            KeyCode::Char('c') => match self.focus {
                BrowseFocus::Topics => {
                    self.topics_sel.clear();
                    self.rebuild_results_from_cache();
                }
                BrowseFocus::Results => {
                    self.results_sel.clear();
                }
                BrowseFocus::Search => {}
            },
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => match self.focus {
                BrowseFocus::Topics => {
                    let keys: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                    self.topics_sel.select_all(&keys);
                    self.rebuild_results_from_cache();
                }
                BrowseFocus::Results => {
                    let keys: Vec<String> = self.results.iter().map(|r| r.merkle_root.clone()).collect();
                    self.results_sel.select_all(&keys);
                }
                BrowseFocus::Search => {}
            },
            KeyCode::Char('r') => return UiCommand::BrowseRefresh,
            KeyCode::Enter => {
                if let Some((topic, merkle_root)) = self.selected_download_target() {
                    return UiCommand::DownloadsAddOpenPrefill { topic, merkle_root };
                }
                self.last_error = Some("no browse items selected".to_string());
                return UiCommand::None;
            }

            KeyCode::Backspace => {
                if self.focus == BrowseFocus::Search {
                    if matches!(self.query.handle_key(key), TextInputAction::Changed) {
                        self.rebuild_results_from_cache();
                    }
                }
            }
            KeyCode::Char(_) => {
                if self.focus == BrowseFocus::Search {
                    if matches!(self.query.handle_key(key), TextInputAction::Changed) {
                        self.rebuild_results_from_cache();
                    }
                }
            }
            _ => {}
        }

        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);
        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(35), Constraint::Percentage(65)].as_ref())
            .split(chunks[0]);

        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(14)].as_ref())
            .split(chunks[1]);

        let topics_area = main[0];
        let public_inner = main[1].inner(Margin { vertical: 1, horizontal: 1 });
        let public_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(5)].as_ref())
            .split(public_inner);
        let search_area = public_chunks[0];
        let results_area = public_chunks[1];

        let topics_table_ctrl = MultiSelectTableController::new(TableHitTestSpec {
            checkbox_width: 4,
            ..TableHitTestSpec::bordered(1)
        });
        let results_table_ctrl = MultiSelectTableController::new(TableHitTestSpec {
            header_rows: 1,
            inner_margin: Margin {
                vertical: 0,
                horizontal: 0,
            },
            hit_y_shift: 0,
            hit_extra_height: 0,
            checkbox_width: 4,
            checkbox_rel_x_bias: 0,
        });

        if mouse_in(footer_chunks[1], &mouse) {
            self.hovered = BrowseHovered::Refresh;
        } else if mouse_in(footer_chunks[2], &mouse) {
            self.hovered = BrowseHovered::Download;
        } else {
            self.hovered = BrowseHovered::None;
        }

        let scrollbar_metrics =
            results_table_ctrl.scrollbar_metrics(results_area, self.results.len(), self.results_state.offset());

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // Focus blocks by clicking anywhere inside them.
                if mouse_in(search_area, &mouse) {
                    self.focus = BrowseFocus::Search;
                    return UiCommand::None;
                } else if mouse_in(results_area, &mouse) {
                    self.focus = BrowseFocus::Results;
                } else if mouse_in(topics_area, &mouse) {
                    self.focus = BrowseFocus::Topics;
                }

                if mouse_in(footer_chunks[1], &mouse) {
                    return UiCommand::BrowseRefresh;
                }
                if mouse_in(footer_chunks[2], &mouse) {
                    if let Some((topic, merkle_root)) = self.selected_download_target() {
                        return UiCommand::DownloadsAddOpenPrefill { topic, merkle_root };
                    }
                    self.last_error = Some("no browse items selected".to_string());
                    return UiCommand::None;
                }

                let topic_keys: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                if topics_table_ctrl
                    .click_from_mouse(
                        topics_area,
                        &mouse,
                        self.topics_state.offset(),
                        &topic_keys,
                        &mut self.topics_state,
                        &mut self.topics_sel,
                        &mut self.topics_drag_select_start,
                    )
                    .is_some()
                {
                    self.focus = BrowseFocus::Topics;
                    self.rebuild_results_from_cache();
                    return UiCommand::None;
                }

                // Scrollbar interactions.
                if let Some(metrics) = scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.results_scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.results_state.offset_mut() = offset;
                                self.results_state.select(Some(
                                    offset.min(self.results.len().saturating_sub(1)),
                                ));
                                self.results_sel.set_anchor(self.results_state.selected());
                                return UiCommand::None;
                            }
                        }
                    }
                }

                let result_keys: Vec<String> = self
                    .results
                    .iter()
                    .map(|r| r.merkle_root.clone())
                    .collect();
                if results_table_ctrl
                    .click_from_mouse(
                        results_area,
                        &mouse,
                        self.results_state.offset(),
                        &result_keys,
                        &mut self.results_state,
                        &mut self.results_sel,
                        &mut self.results_drag_select_start,
                    )
                    .is_some()
                {
                    self.focus = BrowseFocus::Results;
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(grab) = self.results_scrollbar_drag {
                    if let Some(metrics) = scrollbar_metrics {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.results_state.offset_mut() = target;
                        self.results_state.select(Some(
                            target.min(self.results.len().saturating_sub(1)),
                        ));
                        self.results_sel.set_anchor(self.results_state.selected());
                        return UiCommand::None;
                    }
                }

                // Drag-select in topics behaves like shift-select, but resets prior selection.
                let topic_keys: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                if topics_table_ctrl
                    .drag_from_mouse(
                        topics_area,
                        &mouse,
                        self.topics_state.offset(),
                        &topic_keys,
                        &mut self.topics_state,
                        &mut self.topics_sel,
                        &mut self.topics_drag_select_start,
                    )
                    .is_some()
                {
                    self.rebuild_results_from_cache();
                    return UiCommand::None;
                }

                // Drag-select in results behaves like shift-select, but resets prior selection.
                let result_keys: Vec<String> = self
                    .results
                    .iter()
                    .map(|r| r.merkle_root.clone())
                    .collect();
                if results_table_ctrl
                    .drag_from_mouse(
                        results_area,
                        &mouse,
                        self.results_state.offset(),
                        &result_keys,
                        &mut self.results_state,
                        &mut self.results_sel,
                        &mut self.results_drag_select_start,
                    )
                    .is_some()
                {
                    return UiCommand::None;
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.results_scrollbar_drag = None;
                self.topics_drag_select_start = None;
                self.results_drag_select_start = None;
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(results_area, &mouse) {
                    self.focus = BrowseFocus::Results;
                    self.nav_down();
                } else if mouse_in(topics_area, &mouse) {
                    self.focus = BrowseFocus::Topics;
                    self.nav_down();
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(results_area, &mouse) {
                    self.focus = BrowseFocus::Results;
                    self.nav_up();
                } else if mouse_in(topics_area, &mouse) {
                    self.focus = BrowseFocus::Topics;
                    self.nav_up();
                }
            }
            _ => {}
        }

        UiCommand::None
    }
}

fn parse_browse_cache(v: &Value) -> BTreeMap<String, Vec<BrowseResultRow>> {
    let mut out: BTreeMap<String, Vec<BrowseResultRow>> = BTreeMap::new();

    let Some(obj) = v.as_object() else {
        return out;
    };

    for (topic, val) in obj {
        let arr = val.as_array().cloned().unwrap_or_default();
        let rows: Vec<BrowseResultRow> = arr
            .iter()
            .filter_map(|it| {
                Some(BrowseResultRow {
                    topic: topic.clone(),
                    name: it
                        .get("name")
                        .and_then(|x| x.as_str())
                        .or_else(|| it.get("path").and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string(),
                    merkle_root: it
                        .get("merkleRoot")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    size: it.get("size").and_then(|x| x.as_u64()),
                    chunk_count: it.get("chunkCount").and_then(|x| x.as_u64()),
                })
            })
            .filter(|r| !r.merkle_root.is_empty())
            .collect();
        out.insert(topic.clone(), rows);
    }

    out
}
