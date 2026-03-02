use crate::app::App;
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crate::tabs::common::{format_bytes_per_sec, now_ms, progress_percent};
use crate::widgets::{
    compute_scrollbar_metrics, contains, handle_scrollbar_down, handle_scrollbar_drag, mouse_in,
    modal_geometry, draw_modal_shell, render_scrollbar, Button, MultiSelectState,
    MultiSelectTableController, ScrollbarDownResult, TableHitTestSpec,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Gauge, Paragraph, Row, Table, TableState},
    Frame,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub struct DownloadsTab {
    entries: Vec<DownloadRow>,
    table_state: TableState,
    selection: MultiSelectState<i64>,
    last_viewport_rows: usize,
    hovered: DownloadsHovered,
    last_error: Option<String>,
    live: BTreeMap<DownloadKey, LiveDownload>,
    add: DownloadsAddState,

    drag_select_start: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsHovered {
    None,
    Refresh,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsAddFocus {
    Topic,
    MerkleRoot,
    Destination,
    Start,
    Abort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsAddHovered {
    None,
    Start,
    Abort,
}

#[derive(Debug, Clone)]
struct DownloadsAddTopicRow {
    name: String,
    peers: u64,
}

#[derive(Debug, Clone)]
struct DownloadsAddState {
    open: bool,
    focus: DownloadsAddFocus,
    topics: Vec<DownloadsAddTopicRow>,
    topics_state: TableState,
    topics_scrollbar_drag: Option<usize>,
    merkle_root: String,
    destination: String,
    hovered: DownloadsAddHovered,
}

#[derive(Debug, Clone)]
struct DownloadRow {
    id: i64,
    topic: String,
    merkle_root: String,
    output_path: String,
    completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DownloadKey {
    topic: String,
    merkle_root: String,
    output_path: String,
}

#[derive(Debug, Clone)]
struct LiveDownload {
    verified: u64,
    total: u64,
    bytes: u64,
    last_ts: u64,
    last_bytes: u64,
    speed_bps: u64,
    completed: bool,
    error: Option<String>,
}

impl DownloadsTab {
    pub fn new() -> Self {
        let mut table_state = TableState::default();
        table_state.select(Some(0));

        let mut topics_state = TableState::default();
        topics_state.select(Some(0));

        Self {
            entries: Vec::new(),
            table_state,
            selection: MultiSelectState::default(),
            last_viewport_rows: 10,
            hovered: DownloadsHovered::None,
            last_error: None,
            live: BTreeMap::new(),
            add: DownloadsAddState {
                open: false,
                focus: DownloadsAddFocus::Topic,
                topics: Vec::new(),
                topics_state,
                topics_scrollbar_drag: None,
                merkle_root: String::new(),
                destination: String::new(),
                hovered: DownloadsAddHovered::None,
            },

            drag_select_start: None,
        }
    }

    pub fn is_modal_open(&self) -> bool {
        self.add.open
    }

    pub fn add_open(&mut self, ipc: &mut IpcClient) {
        self.add.open = true;
        self.add.focus = DownloadsAddFocus::Topic;
        self.add.hovered = DownloadsAddHovered::None;
        self.add.topics_scrollbar_drag = None;
        self.add.merkle_root.clear();
        self.add.destination.clear();

        self.add.topics_state = TableState::default();
        self.add.topics_state.select(Some(0));

        self.add.topics = fetch_topics(ipc);
        if self.add.topics.is_empty() {
            self.add.topics_state.select(None);
        }
        self.last_error = None;
    }

    pub fn add_open_prefill(&mut self, ipc: &mut IpcClient, topic: String, merkle_root: String) {
        self.add_open(ipc);
        self.add.merkle_root = merkle_root;

        if let Some(idx) = self.add.topics.iter().position(|t| t.name == topic) {
            self.add.topics_state.select(Some(idx));
        }

        self.add.focus = DownloadsAddFocus::Destination;
    }

    pub fn add_cancel(&mut self) {
        self.add.open = false;
    }

    pub fn add_confirm(&mut self, ipc: &mut IpcClient) {
        if !self.add.open {
            return;
        }
        let Some(topic) = self
            .add
            .topics_state
            .selected()
            .and_then(|i| self.add.topics.get(i))
            .map(|t| t.name.clone())
        else {
            self.last_error = Some("topic required".to_string());
            return;
        };

        let root = self.add.merkle_root.trim().to_string();
        if root.is_empty() {
            self.last_error = Some("merkle root required".to_string());
            return;
        }
        let dest = self.add.destination.trim().to_string();
        if dest.is_empty() {
            self.last_error = Some("destination required".to_string());
            return;
        }

        let params = serde_json::json!({
            "topic": topic,
            "merkleRoot": root,
            "outputPath": dest,
        });
        match ipc.rpc("downloads.start", params) {
            Ok(_) => {
                self.add.open = false;
                self.last_error = None;
                self.refresh(ipc);
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn on_downloads_progress(&mut self, v: Value) {
        let topic = v
            .get("topic")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let merkle_root = v
            .get("merkleRoot")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let output_path = v
            .get("outputPath")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if topic.is_empty() || merkle_root.is_empty() || output_path.is_empty() {
            return;
        }

        let verified = v.get("verified").and_then(|x| x.as_u64()).unwrap_or(0);
        let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
        let bytes = v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0);
        let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);

        let key = DownloadKey {
            topic,
            merkle_root,
            output_path,
        };

        let entry = self.live.entry(key).or_insert(LiveDownload {
            verified,
            total,
            bytes,
            last_ts: ts,
            last_bytes: bytes,
            speed_bps: 0,
            completed: false,
            error: None,
        });

        let dt_ms = ts.saturating_sub(entry.last_ts).max(1);
        let db = bytes.saturating_sub(entry.last_bytes);
        let speed = (db.saturating_mul(1000)).saturating_div(dt_ms);

        entry.verified = verified;
        entry.total = total;
        entry.bytes = bytes;
        entry.last_ts = ts;
        entry.last_bytes = bytes;
        entry.speed_bps = speed;
        entry.completed = false;
        entry.error = None;
    }

    pub fn on_downloads_complete(&mut self, v: Value) {
        if let Some(k) = parse_download_key(&v) {
            let e = self.live.entry(k).or_insert(LiveDownload {
                verified: 0,
                total: 0,
                bytes: 0,
                last_ts: now_ms(),
                last_bytes: 0,
                speed_bps: 0,
                completed: true,
                error: None,
            });
            e.completed = true;
            e.error = None;
            e.speed_bps = 0;
            e.last_ts = now_ms();
        }
    }

    pub fn on_downloads_error(&mut self, v: Value) {
        if let Some(k) = parse_download_key(&v) {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("error")
                .to_string();
            let e = self.live.entry(k).or_insert(LiveDownload {
                verified: 0,
                total: 0,
                bytes: 0,
                last_ts: now_ms(),
                last_bytes: 0,
                speed_bps: 0,
                completed: false,
                error: Some(msg.clone()),
            });
            e.completed = false;
            e.error = Some(msg);
            e.speed_bps = 0;
            e.last_ts = now_ms();
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("downloads.list", serde_json::json!({})) {
            Ok(v) => {
                let arr = v.as_array().cloned().unwrap_or_default();
                self.entries = arr
                    .iter()
                    .filter_map(|it| {
                        Some(DownloadRow {
                            id: it.get("id")?.as_i64()?,
                            topic: it
                                .get("topic_name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            merkle_root: it
                                .get("merkle_root")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            output_path: it
                                .get("output_path")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            completed_at: it.get("completed_at").and_then(|x| x.as_i64()),
                        })
                    })
                    .collect();

                if self.entries.is_empty() {
                    self.table_state.select(None);
                } else if self.table_state.selected().is_none() {
                    self.table_state.select(Some(0));
                }

                let existing: BTreeSet<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.retain_existing(&existing);

                let existing_live: BTreeSet<DownloadKey> = self
                    .entries
                    .iter()
                    .map(|e| DownloadKey {
                        topic: e.topic.clone(),
                        merkle_root: e.merkle_root.clone(),
                        output_path: e.output_path.clone(),
                    })
                    .collect();
                self.live.retain(|k, _| existing_live.contains(k));
                self.last_error = None;
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    fn draw_add_modal(&mut self, f: &mut Frame, area: Rect) {
        let inner = draw_modal_shell(f, 80, 80, area, "Add download");
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints(
                [
                    Constraint::Min(6),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                ]
                .as_ref(),
            )
            .split(inner);

        let topic_border = if self.add.focus == DownloadsAddFocus::Topic {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let header = Row::new(vec!["Topic", "Peers"]).style(Style::default().fg(Color::Yellow));
        let rows = self
            .add
            .topics
            .iter()
            .map(|t| Row::new(vec![t.name.clone(), t.peers.to_string()]));
        let show_scrollbar =
            self.add.topics.len() > chunks[0].height.saturating_sub(3).max(1) as usize;
        let mut topics_area = chunks[0];
        if show_scrollbar {
            topics_area.width = topics_area.width.saturating_sub(1);
        }

        let table = Table::new(rows, [Constraint::Min(10), Constraint::Length(6)])
            .header(header)
            .block(
                Block::default()
                    .title("Topic")
                    .borders(Borders::ALL)
                    .border_style(topic_border),
            )
            .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow))
            .style(Style::default());
        f.render_stateful_widget(table, topics_area, &mut self.add.topics_state);

        if let Some(metrics) =
            compute_scrollbar_metrics(chunks[0], 1, self.add.topics.len(), self.add.topics_state.offset())
        {
            render_scrollbar(f, metrics);
        }

        let mr_border = if self.add.focus == DownloadsAddFocus::MerkleRoot {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let mr = Paragraph::new(Line::from(self.add.merkle_root.clone())).block(
            Block::default()
                .title("Merkle root")
                .borders(Borders::ALL)
                .border_style(mr_border),
        );
        f.render_widget(mr, chunks[1]);

        let dst_border = if self.add.focus == DownloadsAddFocus::Destination {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let dst = Paragraph::new(Line::from(self.add.destination.clone())).block(
            Block::default()
                .title("Destination path")
                .borders(Borders::ALL)
                .border_style(dst_border),
        );
        f.render_widget(dst, chunks[2]);

        let btns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(12), Constraint::Length(12), Constraint::Min(10)].as_ref())
            .split(chunks[3]);

        let start_btn = Button {
            label: "Start".to_string(),
            enabled: true,
        };
        start_btn.draw(f, btns[0], self.add.hovered == DownloadsAddHovered::Start);

        let abort_btn = Button {
            label: "Abort".to_string(),
            enabled: true,
        };
        abort_btn.draw(f, btns[1], self.add.hovered == DownloadsAddHovered::Abort);

        let hint = Paragraph::new(Text::from(vec![Line::from(
            "Tab/Shift+Tab switch fields | Enter confirm | Esc abort",
        )]))
        .block(Block::default().borders(Borders::ALL));
        f.render_widget(hint, btns[2]);
    }
}

impl Tab for DownloadsTab {
    fn id(&self) -> TabId {
        TabId::Downloads
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        let list_area = chunks[0];
        let footer_area = chunks[1];

        self.last_viewport_rows = list_area.height.saturating_sub(3).max(1) as usize;

        let header = Row::new(vec![
            "Sel",
            "Topic",
            "Root",
            "Progress",
            "Speed",
            "Output",
            "Done",
        ])
        .style(Style::default().fg(Color::Yellow));

        let now = now_ms();
        let rows = self.entries.iter().map(|e| {
            let mark = if self.selection.is_selected(&e.id) { "[x]" } else { "[ ]" };
            let root = if e.merkle_root.len() > 12 {
                e.merkle_root[..12].to_string()
            } else {
                e.merkle_root.clone()
            };
            let done = if e.completed_at.is_some() { "yes" } else { "" };

            let lk = DownloadKey {
                topic: e.topic.clone(),
                merkle_root: e.merkle_root.clone(),
                output_path: e.output_path.clone(),
            };

            let (speed, status, row_style) = if e.completed_at.is_some() {
                ("".to_string(), "complete".to_string(), Style::default())
            } else if let Some(l) = self.live.get(&lk) {
                if l.error.is_some() {
                    ("".to_string(), "error".to_string(), Style::default())
                } else if l.completed {
                    ("".to_string(), "complete".to_string(), Style::default())
                } else {
                    let stalled = now.saturating_sub(l.last_ts) > 3000;
                    let status = if stalled {
                        "paused".to_string()
                    } else {
                        "downloading".to_string()
                    };
                    let sp = if stalled {
                        "".to_string()
                    } else {
                        format_bytes_per_sec(l.speed_bps)
                    };
                    (sp, status, Style::default())
                }
            } else {
                ("".to_string(), "queued".to_string(), Style::default())
            };

            Row::new(vec![
                mark.to_string(),
                e.topic.clone(),
                root,
                "".to_string(),
                speed,
                status,
                e.output_path.clone(),
                done.to_string(),
            ])
            .style(row_style)
        });

        let constraints = [
            Constraint::Length(4),
            Constraint::Length(12),
            Constraint::Length(14),
            Constraint::Length(18),
            Constraint::Length(10),
            Constraint::Length(12),
            Constraint::Min(10),
            Constraint::Length(6),
        ];

        let table = Table::new(rows, constraints)
            .header(header)
            .block(Block::default().title("Downloads").borders(Borders::ALL))
            .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        f.render_stateful_widget(table, list_area, &mut self.table_state);

        // Gauge overlay: Ratatui tables are text-only, so we render gauges on top of the
        // Progress column after rendering the table.
        let inner = list_area.inner(Margin { vertical: 1, horizontal: 1 });
        if inner.height >= 2 && inner.width >= 2 {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(constraints)
                .split(inner);
            let progress_col = cols.get(3).cloned().unwrap_or(Rect::default());

            let viewport_rows = inner.height.saturating_sub(1).max(1) as usize;
            let offset = self.table_state.offset();

            for (rel, row_idx) in (offset..self.entries.len()).take(viewport_rows).enumerate() {
                let Some(e) = self.entries.get(row_idx) else { continue };
                let lk = DownloadKey {
                    topic: e.topic.clone(),
                    merkle_root: e.merkle_root.clone(),
                    output_path: e.output_path.clone(),
                };

                let (pct, label, color) = if e.completed_at.is_some() {
                    (100, "Complete".to_string(), Color::Green)
                } else if let Some(l) = self.live.get(&lk) {
                    if l.error.is_some() {
                        (
                            progress_percent(l.verified, l.total),
                            "Verification error".to_string(),
                            Color::Red,
                        )
                    } else if l.completed {
                        (100, "Complete".to_string(), Color::Green)
                    } else {
                        let stalled = now.saturating_sub(l.last_ts) > 3000;
                        if stalled {
                            (
                                progress_percent(l.verified, l.total),
                                "Paused".to_string(),
                                Color::DarkGray,
                            )
                        } else {
                            (
                                progress_percent(l.verified, l.total),
                                "Downloading".to_string(),
                                Color::White,
                            )
                        }
                    }
                } else {
                    (0, "Queued".to_string(), Color::Gray)
                };

                let y = progress_col.y.saturating_add(1).saturating_add(rel as u16);
                if y >= progress_col.y.saturating_add(progress_col.height) {
                    break;
                }

                let gauge_area = Rect {
                    x: progress_col.x,
                    y,
                    width: progress_col.width,
                    height: 1,
                };

                if gauge_area.width >= 3 {
                    let ratio = (pct.min(100) as f64) / 100.0;
                    let g = Gauge::default()
                        .gauge_style(Style::default().fg(color).bg(Color::Black))
                        .ratio(ratio)
                        .label(Span::raw(label));
                    f.render_widget(g, gauge_area);
                }
            }
        }

        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(12)].as_ref())
            .split(footer_area);

        let mut footer_lines: Vec<Line> = vec![Line::from(
            "Keys: n new | r refresh | R resume | tab/space toggle | Ctrl-click toggle | Shift-click range | drag-select resets | Ctrl+A all | c clear | j/k move | PgUp/PgDn",
        )];
        if let Some(e) = &self.last_error {
            footer_lines.push(Line::from(format!("Error: {}", e)));
        }

        let footer = Paragraph::new(Text::from(footer_lines))
            .block(Block::default().title("Actions").borders(Borders::ALL));
        f.render_widget(footer, footer_chunks[0]);

        let refresh_btn = Button {
            label: "Refresh".to_string(),
            enabled: true,
        };
        refresh_btn.draw(f, footer_chunks[1], self.hovered == DownloadsHovered::Refresh);

        let resume_btn = Button {
            label: "Resume".to_string(),
            enabled: true,
        };
        resume_btn.draw(f, footer_chunks[2], self.hovered == DownloadsHovered::Resume);

        if self.add.open {
            self.draw_add_modal(f, area);
        }
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        if self.add.open {
            match key.code {
                KeyCode::Esc => return UiCommand::DownloadsAddCancel,
                KeyCode::Tab => {
                    self.add.focus = match self.add.focus {
                        DownloadsAddFocus::Topic => DownloadsAddFocus::MerkleRoot,
                        DownloadsAddFocus::MerkleRoot => DownloadsAddFocus::Destination,
                        DownloadsAddFocus::Destination => DownloadsAddFocus::Start,
                        DownloadsAddFocus::Start => DownloadsAddFocus::Abort,
                        DownloadsAddFocus::Abort => DownloadsAddFocus::Topic,
                    };
                }
                KeyCode::BackTab => {
                    self.add.focus = match self.add.focus {
                        DownloadsAddFocus::Topic => DownloadsAddFocus::Abort,
                        DownloadsAddFocus::MerkleRoot => DownloadsAddFocus::Topic,
                        DownloadsAddFocus::Destination => DownloadsAddFocus::MerkleRoot,
                        DownloadsAddFocus::Start => DownloadsAddFocus::Destination,
                        DownloadsAddFocus::Abort => DownloadsAddFocus::Start,
                    };
                }
                KeyCode::Enter => match self.add.focus {
                    DownloadsAddFocus::Start => return UiCommand::DownloadsAddConfirm,
                    DownloadsAddFocus::Abort => return UiCommand::DownloadsAddCancel,
                    _ => {}
                },
                KeyCode::Up => {
                    if self.add.focus == DownloadsAddFocus::Topic {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => i.saturating_sub(1),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                        }
                    }
                }
                KeyCode::Down => {
                    if self.add.focus == DownloadsAddFocus::Topic {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => (i + 1).min(self.add.topics.len().saturating_sub(1)),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                        }
                    }
                }
                KeyCode::Backspace => {
                    if self.add.focus == DownloadsAddFocus::MerkleRoot {
                        self.add.merkle_root.pop();
                    } else if self.add.focus == DownloadsAddFocus::Destination {
                        self.add.destination.pop();
                    }
                }
                KeyCode::Char(c) => {
                    if self.add.focus == DownloadsAddFocus::MerkleRoot {
                        self.add.merkle_root.push(c);
                    } else if self.add.focus == DownloadsAddFocus::Destination {
                        self.add.destination.push(c);
                    }
                }
                _ => {}
            }
            return UiCommand::None;
        }

        match key.code {
            KeyCode::Char('n') => return UiCommand::DownloadsAddOpen,
            KeyCode::Char('r') => return UiCommand::DownloadsRefresh,
            KeyCode::Char('R') => return UiCommand::DownloadsResume,
            KeyCode::Char('j') | KeyCode::Down => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                };
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::PageDown | KeyCode::Char('J') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.last_viewport_rows)
                    .min(self.entries.len().saturating_sub(1));
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.last_viewport_rows);
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::Tab | KeyCode::Char(' ') => {
                if let Some(i) = self.table_state.selected() {
                    if let Some(e) = self.entries.get(i) {
                        self.selection.toggle(e.id, i);
                    }
                }
            }
            KeyCode::Char('c') => {
                self.selection.clear();
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.select_all(&keys);
            }
            KeyCode::Char('A') => {
                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.select_all(&keys);
            }
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        if self.add.open {
            let (popup, inner) = modal_geometry(80, 80, area);
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints(
                    [
                        Constraint::Min(6),
                        Constraint::Length(3),
                        Constraint::Length(3),
                        Constraint::Length(3),
                    ]
                    .as_ref(),
                )
                .split(inner);

            let topic_scrollbar_metrics = compute_scrollbar_metrics(
                chunks[0],
                1,
                self.add.topics.len(),
                self.add.topics_state.offset(),
            );

            let topics_table_ctrl = MultiSelectTableController::new(TableHitTestSpec::bordered(1));

            let btns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(12), Constraint::Length(12), Constraint::Min(10)].as_ref())
                .split(chunks[3]);

            if mouse_in(btns[0], &mouse) {
                self.add.hovered = DownloadsAddHovered::Start;
            } else if mouse_in(btns[1], &mouse) {
                self.add.hovered = DownloadsAddHovered::Abort;
            } else {
                self.add.hovered = DownloadsAddHovered::None;
            }

            if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
                if !contains(popup, mouse.column, mouse.row) {
                    return UiCommand::DownloadsAddCancel;
                }
                if let Some(metrics) = topic_scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.add.topics_scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.add.topics_state.offset_mut() = offset;
                                self.add.topics_state.select(Some(
                                    offset.min(self.add.topics.len().saturating_sub(1)),
                                ));
                                self.add.focus = DownloadsAddFocus::Topic;
                                return UiCommand::None;
                            }
                        }
                    }
                }

                if mouse_in(chunks[1], &mouse) {
                    self.add.focus = DownloadsAddFocus::MerkleRoot;
                    return UiCommand::None;
                }
                if mouse_in(chunks[2], &mouse) {
                    self.add.focus = DownloadsAddFocus::Destination;
                    return UiCommand::None;
                }

                if let Some(idx) = topics_table_ctrl.hit_test_index(
                    chunks[0],
                    &mouse,
                    self.add.topics_state.offset(),
                    self.add.topics.len(),
                ) {
                    self.add.focus = DownloadsAddFocus::Topic;
                    self.add.topics_state.select(Some(idx));
                    return UiCommand::None;
                }

                if mouse_in(btns[0], &mouse) {
                    self.add.focus = DownloadsAddFocus::Start;
                    return UiCommand::DownloadsAddConfirm;
                }
                if mouse_in(btns[1], &mouse) {
                    self.add.focus = DownloadsAddFocus::Abort;
                    return UiCommand::DownloadsAddCancel;
                }
            }

            match mouse.kind {
                MouseEventKind::Drag(MouseButton::Left) => {
                    if let (Some(grab), Some(metrics)) =
                        (self.add.topics_scrollbar_drag, topic_scrollbar_metrics)
                    {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.add.topics_state.offset_mut() = target;
                        self.add.topics_state.select(Some(
                            target.min(self.add.topics.len().saturating_sub(1)),
                        ));
                        self.add.focus = DownloadsAddFocus::Topic;
                    }
                }
                MouseEventKind::Up(MouseButton::Left) => {
                    self.add.topics_scrollbar_drag = None;
                }
                MouseEventKind::ScrollDown => {
                    if mouse_in(chunks[0], &mouse) {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => (i + 1).min(self.add.topics.len().saturating_sub(1)),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                            self.add.focus = DownloadsAddFocus::Topic;
                        }
                    }
                }
                MouseEventKind::ScrollUp => {
                    if mouse_in(chunks[0], &mouse) {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => i.saturating_sub(1),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                            self.add.focus = DownloadsAddFocus::Topic;
                        }
                    }
                }
                _ => {}
            }

            return UiCommand::None;
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        let list_area = chunks[0];
        let footer_area = chunks[1];
        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(12)].as_ref())
            .split(footer_area);

        if mouse_in(footer_chunks[1], &mouse) {
            self.hovered = DownloadsHovered::Refresh;
        } else if mouse_in(footer_chunks[2], &mouse) {
            self.hovered = DownloadsHovered::Resume;
        } else {
            self.hovered = DownloadsHovered::None;
        }

        let list_table_ctrl = MultiSelectTableController::new(TableHitTestSpec {
            checkbox_width: 4,
            checkbox_rel_x_bias: 1,
            ..TableHitTestSpec::bordered(1)
        });

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if mouse_in(footer_chunks[1], &mouse) {
                    return UiCommand::DownloadsRefresh;
                }

                if mouse_in(footer_chunks[2], &mouse) {
                    return UiCommand::DownloadsResume;
                }

                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                let _ = list_table_ctrl.click_from_mouse(
                    list_area,
                    &mouse,
                    self.table_state.offset(),
                    &keys,
                    &mut self.table_state,
                    &mut self.selection,
                    &mut self.drag_select_start,
                );
            }

            MouseEventKind::Drag(MouseButton::Left) => {
                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                let _ = list_table_ctrl.drag_from_mouse(
                    list_area,
                    &mouse,
                    self.table_state.offset(),
                    &keys,
                    &mut self.table_state,
                    &mut self.selection,
                    &mut self.drag_select_start,
                );
            }

            MouseEventKind::Up(MouseButton::Left) => {
                self.drag_select_start = None;
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                    };
                    if !self.entries.is_empty() {
                        self.table_state.select(Some(next));
                        self.selection.set_anchor(Some(next));
                    }
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => i.saturating_sub(1),
                    };
                    if !self.entries.is_empty() {
                        self.table_state.select(Some(next));
                        self.selection.set_anchor(Some(next));
                    }
                }
            }
            _ => {}
        }

        UiCommand::None
    }
}

fn fetch_topics(ipc: &mut IpcClient) -> Vec<DownloadsAddTopicRow> {
    let mut out: Vec<DownloadsAddTopicRow> = Vec::new();
    let Ok(v) = ipc.rpc("topic.list", serde_json::json!({})) else {
        return out;
    };
    let Some(arr) = v.as_array() else {
        return out;
    };
    for t in arr {
        let name = t
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let peers = t.get("peers").and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(DownloadsAddTopicRow { name, peers });
    }
    out
}

fn parse_download_key(v: &Value) -> Option<DownloadKey> {
    let topic = v.get("topic")?.as_str()?.to_string();
    let merkle_root = v.get("merkleRoot")?.as_str()?.to_string();
    let output_path = v.get("outputPath")?.as_str()?.to_string();
    if topic.is_empty() || merkle_root.is_empty() || output_path.is_empty() {
        return None;
    }
    Some(DownloadKey {
        topic,
        merkle_root,
        output_path,
    })
}
