use crate::app::App;
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Clear, Paragraph, Row, Table, TableState},
    Frame,
};
use serde_json::Value;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use crate::widgets::{
    contains, compute_scrollbar_metrics, handle_scrollbar_down, handle_scrollbar_drag, mouse_in,
    render_scrollbar, Button, ScrollbarDownResult,
};

#[derive(Debug, Clone)]
pub struct TopicRow {
    pub name: String,
    pub key: Option<String>,
    pub auto_join: Option<bool>,
    pub last_joined_at: Option<i64>,
    pub joined: bool,
    pub peers: u64,
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Percentage((100 - percent_y) / 2),
                Constraint::Percentage(percent_y),
                Constraint::Percentage((100 - percent_y) / 2),
            ]
            .as_ref(),
        )
        .split(r);

    let vertical = popup_layout[1];
    let horizontal_layout = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage((100 - percent_x) / 2),
                Constraint::Percentage(percent_x),
                Constraint::Percentage((100 - percent_x) / 2),
            ]
            .as_ref(),
        )
        .split(vertical);

    horizontal_layout[1]
}

pub struct NetworkTab {
    topics: Vec<TopicRow>,
    table_state: TableState,
    last_error: Option<String>,
    hovered: Hovered,

    endpoint: String,

    join_leave_rx: Receiver<(u64, JoinLeaveMsg)>,
    join_leave_req_id: u64,
    join_leave_busy: Option<String>,

    // Cached viewport size (in rows) from the last draw. Used for scrollbar math.
    last_viewport_rows: usize,
    // Scrollbar thumb drag grab offset.
    scrollbar_drag: Option<usize>,

    topic_new: TopicNewState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hovered {
    None,
    Join,
    Leave,
    New,
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopicNewFocus {
    Name,
    AutoJoin,
    PasswordToggle,
    Password,
    Save,
    Abort,
}

#[derive(Debug, Clone)]
struct TopicNewState {
    open: bool,
    focus: TopicNewFocus,
    name: String,
    auto_join: bool,
    password_enabled: bool,
    password: String,
}

#[derive(Debug, Clone)]
enum JoinLeaveMsg {
    Done { overview: Value },
    Error { message: String },
}

impl NetworkTab {
    pub fn new(endpoint: String) -> Self {
        let mut table_state = TableState::default();
        table_state.select(Some(0));

        let (_tx, rx) = mpsc::channel::<(u64, JoinLeaveMsg)>();
        Self {
            topics: Vec::new(),
            table_state,
            last_error: None,
            hovered: Hovered::None,
            endpoint,
            join_leave_rx: rx,
            join_leave_req_id: 0,
            join_leave_busy: None,
            last_viewport_rows: 10,
            scrollbar_drag: None,
            topic_new: TopicNewState {
                open: false,
                focus: TopicNewFocus::Name,
                name: String::new(),
                auto_join: true,
                password_enabled: false,
                password: String::new(),
            },
        }
    }

    pub fn poll_async(&mut self) {
        while let Ok((req_id, msg)) = self.join_leave_rx.try_recv() {
            if req_id != self.join_leave_req_id {
                continue;
            }

            match msg {
                JoinLeaveMsg::Done { overview } => {
                    self.topics = parse_overview_topics(&overview);
                    if self.topics.is_empty() {
                        self.table_state.select(None);
                    } else if self.table_state.selected().is_none() {
                        self.table_state.select(Some(0));
                    }
                    self.join_leave_busy = None;
                    self.last_error = None;
                }
                JoinLeaveMsg::Error { message } => {
                    self.join_leave_busy = None;
                    self.last_error = Some(message);
                }
            }
        }
    }

    pub fn is_modal_open(&self) -> bool {
        self.topic_new.open
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("network.overview", serde_json::json!({})) {
            Ok(v) => {
                self.topics = parse_overview_topics(&v);
                if self.topics.is_empty() {
                    self.table_state.select(None);
                } else if self.table_state.selected().is_none() {
                    self.table_state.select(Some(0));
                }
                self.last_error = None;
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    fn selected_topic_name(&self) -> Option<String> {
        let idx = self.table_state.selected()?;
        self.topics.get(idx).map(|t| t.name.clone())
    }

    fn selected_topic(&self) -> Option<&TopicRow> {
        let idx = self.table_state.selected()?;
        self.topics.get(idx)
    }

    pub fn topic_new_open(&mut self) {
        self.topic_new.open = true;
        self.topic_new.focus = TopicNewFocus::Name;
        self.topic_new.name.clear();
        self.topic_new.auto_join = true;
        self.topic_new.password_enabled = false;
        self.topic_new.password.clear();
        self.last_error = None;
    }

    pub fn topic_new_cancel(&mut self) {
        self.topic_new.open = false;
    }

    pub fn topic_new_save(&mut self, ipc: &mut IpcClient) {
        if !self.topic_new.open {
            return;
        }
        let name = self.topic_new.name.trim().to_string();
        if name.is_empty() {
            self.last_error = Some("topic name required".to_string());
            return;
        }

        let password = if self.topic_new.password_enabled {
            let p = self.topic_new.password.clone();
            Some(p)
        } else {
            None
        };

        let params = serde_json::json!({
            "name": name,
            "autoJoin": self.topic_new.auto_join,
            "password": password,
        });

        match ipc.rpc("topic.create", params) {
            Ok(_) => {
                self.topic_new.open = false;
                self.last_error = None;
                self.refresh(ipc);
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn join_selected(&mut self, ipc: &mut IpcClient) {
        let _ = ipc;
        let Some(name) = self.selected_topic_name() else {
            return;
        };

        let endpoint = self.endpoint.clone();
        let (tx, rx): (Sender<(u64, JoinLeaveMsg)>, Receiver<(u64, JoinLeaveMsg)>) = mpsc::channel();
        self.join_leave_rx = rx;

        self.join_leave_req_id = self.join_leave_req_id.wrapping_add(1);
        let req_id = self.join_leave_req_id;

        self.join_leave_busy = Some(format!("joining {}", name));
        self.last_error = None;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;
                c.rpc("topic.join", serde_json::json!({"name": name})).map_err(|e| e.to_string())?;
                let overview = c
                    .rpc("network.overview", serde_json::json!({}))
                    .map_err(|e| e.to_string())?;
                Ok::<Value, String>(overview)
            })();

            match res {
                Ok(overview) => {
                    let _ = tx.send((req_id, JoinLeaveMsg::Done { overview }));
                }
                Err(message) => {
                    let _ = tx.send((req_id, JoinLeaveMsg::Error { message }));
                }
            }
        });
    }

    pub fn leave_selected(&mut self, ipc: &mut IpcClient) {
        let _ = ipc;
        let Some(name) = self.selected_topic_name() else {
            return;
        };

        let endpoint = self.endpoint.clone();
        let (tx, rx): (Sender<(u64, JoinLeaveMsg)>, Receiver<(u64, JoinLeaveMsg)>) = mpsc::channel();
        self.join_leave_rx = rx;

        self.join_leave_req_id = self.join_leave_req_id.wrapping_add(1);
        let req_id = self.join_leave_req_id;

        self.join_leave_busy = Some(format!("leaving {}", name));
        self.last_error = None;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;
                c.rpc("topic.leave", serde_json::json!({"name": name})).map_err(|e| e.to_string())?;
                let overview = c
                    .rpc("network.overview", serde_json::json!({}))
                    .map_err(|e| e.to_string())?;
                Ok::<Value, String>(overview)
            })();

            match res {
                Ok(overview) => {
                    let _ = tx.send((req_id, JoinLeaveMsg::Done { overview }));
                }
                Err(message) => {
                    let _ = tx.send((req_id, JoinLeaveMsg::Error { message }));
                }
            }
        });
    }

    pub fn remove_selected(&mut self, ipc: &mut IpcClient) {
        if let Some(name) = self.selected_topic_name() {
            match ipc.rpc("topic.rm", serde_json::json!({"name": name})) {
                Ok(_) => {
                    self.last_error = None;
                    self.refresh(ipc);
                }
                Err(e) => {
                    self.last_error = Some(e.to_string());
                }
            }
        }
    }

    pub fn on_network_event(&mut self, _evt: crate::ipc::NetworkEvent) {
        // For now we rely on network.stats snapshots.
    }
}

impl Tab for NetworkTab {
    fn id(&self) -> TabId {
        TabId::Network
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, app: &mut App) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(7)].as_ref())
            .split(area);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(65), Constraint::Percentage(35)].as_ref())
            .split(chunks[0]);

        let list_area = main[0];
        let details_area = main[1];

        // Keep viewport rows in sync for scrollbar + mouse mapping.
        // Table viewport = inside borders minus 1 header row.
        self.last_viewport_rows = list_area.height.saturating_sub(3).max(1) as usize;

        let header = Row::new(vec![" ", "Name", "Peers", "Auto"]).style(Style::default().fg(Color::Yellow));
        let rows = self.topics.iter().map(|t| {
            let mark = if t.joined { "✓" } else { "" };
            let auto = t.auto_join.map(|b| if b { "yes" } else { "no" }).unwrap_or("?");
            Row::new(vec![
                mark.to_string(),
                t.name.clone(),
                t.peers.to_string(),
                auto.to_string(),
            ])
        });

        let table = Table::new(
            rows,
            [
                Constraint::Length(2),
                Constraint::Min(12),
                Constraint::Length(6),
                Constraint::Length(6),
            ],
        )
        .header(header)
        .block(Block::default().title("Topics").borders(Borders::ALL))
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        let show_scrollbar = self.topics.len() > self.last_viewport_rows;
        let mut table_area = list_area;
        if show_scrollbar {
            table_area.width = table_area.width.saturating_sub(1);
        }
        f.render_stateful_widget(table, table_area, &mut self.table_state);

        if let Some(metrics) = compute_scrollbar_metrics(
            list_area,
            1,
            self.topics.len(),
            self.table_state.offset(),
        ) {
            render_scrollbar(f, metrics);
        }

        // Details + actions panel
        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(6),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
            ]
            .as_ref())
            .split(details_area);

        let selected = self.selected_topic();
        let detail_lines = if let Some(t) = selected {
            vec![
                Line::from(format!("name: {}", t.name)),
                Line::from(format!("joined: {}", if t.joined { "yes" } else { "no" })),
                Line::from(format!("peers: {}", t.peers)),
                Line::from(format!(
                    "auto-join: {}",
                    t.auto_join.map(|b| if b { "yes" } else { "no" }).unwrap_or("?")
                )),
            ]
        } else {
            vec![Line::from("(no topic selected)")]
        };

        let details = Paragraph::new(Text::from(detail_lines))
            .block(Block::default().title("Selected").borders(Borders::ALL));
        f.render_widget(details, detail_chunks[0]);

        let join_btn = Button {
            label: "Join".to_string(),
            enabled: selected.map(|t| !t.joined).unwrap_or(false),
        };
        join_btn.draw(f, detail_chunks[1], self.hovered == Hovered::Join);

        let leave_btn = Button {
            label: "Leave".to_string(),
            enabled: selected.map(|t| t.joined).unwrap_or(false),
        };
        leave_btn.draw(f, detail_chunks[2], self.hovered == Hovered::Leave);

        let remove_btn = Button {
            label: "Remove".to_string(),
            enabled: selected.is_some(),
        };
        remove_btn.draw(f, detail_chunks[3], self.hovered == Hovered::Remove);

        let new_btn = Button {
            label: "New".to_string(),
            enabled: true,
        };
        new_btn.draw(f, detail_chunks[4], self.hovered == Hovered::New);

        let stats_txt = if let Some(v) = &app.network.stats_json {
            serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
        } else {
            "(no network stats yet)".to_string()
        };

        let mut lines = vec![Line::from(
            "Keys: r refresh | n new | x/Del remove | Enter join | Backspace leave | j/k move",
        )];
        if let Some(e) = &self.last_error {
            lines.push(Line::from(format!("Error: {}", e)));
        }
        lines.push(Line::from(""));
        lines.extend(Text::from(stats_txt).lines);

        let stats = Paragraph::new(Text::from(lines))
            .block(Block::default().title("Network").borders(Borders::ALL));
        f.render_widget(stats, chunks[1]);

        if self.topic_new.open {
            let popup = centered_rect(60, 60, area);
            f.render_widget(Clear, popup);

            let outer = Block::default().title("New topic").borders(Borders::ALL);
            f.render_widget(outer, popup);
            let inner = popup.inner(Margin { vertical: 1, horizontal: 1 });
            let pchunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                ]
                .as_ref())
                .split(inner);

            let name_style = if self.topic_new.focus == TopicNewFocus::Name {
                Style::default().bg(Color::Blue)
            } else {
                Style::default()
            };
            let name_p = Paragraph::new(Line::from(self.topic_new.name.clone()))
                .block(Block::default().title("Name").borders(Borders::ALL))
                .style(name_style);
            f.render_widget(name_p, pchunks[0]);

            let auto_style = if self.topic_new.focus == TopicNewFocus::AutoJoin {
                Style::default().bg(Color::Blue)
            } else {
                Style::default()
            };
            let auto_label = format!(
                "[{}] Auto join",
                if self.topic_new.auto_join { "x" } else { " " }
            );
            let auto_p = Paragraph::new(Line::from(auto_label))
                .block(Block::default().borders(Borders::ALL))
                .style(auto_style);
            f.render_widget(auto_p, pchunks[1]);

            let pw_toggle_style = if self.topic_new.focus == TopicNewFocus::PasswordToggle {
                Style::default().bg(Color::Blue)
            } else {
                Style::default()
            };
            let pw_toggle_label = format!(
                "[{}] Password",
                if self.topic_new.password_enabled { "x" } else { " " }
            );
            let pw_toggle_p = Paragraph::new(Line::from(pw_toggle_label))
                .block(Block::default().borders(Borders::ALL))
                .style(pw_toggle_style);
            f.render_widget(pw_toggle_p, pchunks[2]);

            let pw_style = if self.topic_new.focus == TopicNewFocus::Password {
                Style::default().bg(Color::Blue)
            } else {
                Style::default()
            };
            let pw_val = if self.topic_new.password_enabled {
                self.topic_new.password.clone()
            } else {
                "".to_string()
            };
            let pw_p = Paragraph::new(Line::from(pw_val))
                .block(Block::default().title("Password (optional)").borders(Borders::ALL))
                .style(pw_style);
            f.render_widget(pw_p, pchunks[3]);

            let btns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)].as_ref())
                .split(pchunks[4]);

            let save_btn = Button {
                label: "Save".to_string(),
                enabled: true,
            };
            save_btn.draw(f, btns[0], self.topic_new.focus == TopicNewFocus::Save);

            let abort_btn = Button {
                label: "Abort".to_string(),
                enabled: true,
            };
            abort_btn.draw(f, btns[1], self.topic_new.focus == TopicNewFocus::Abort);
        }
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        if self.topic_new.open {
            match key.code {
                KeyCode::Esc => return UiCommand::TopicNewCancel,
                KeyCode::Tab => {
                    self.topic_new.focus = match self.topic_new.focus {
                        TopicNewFocus::Name => TopicNewFocus::AutoJoin,
                        TopicNewFocus::AutoJoin => TopicNewFocus::PasswordToggle,
                        TopicNewFocus::PasswordToggle => TopicNewFocus::Password,
                        TopicNewFocus::Password => TopicNewFocus::Save,
                        TopicNewFocus::Save => TopicNewFocus::Abort,
                        TopicNewFocus::Abort => TopicNewFocus::Name,
                    };
                }
                KeyCode::BackTab => {
                    self.topic_new.focus = match self.topic_new.focus {
                        TopicNewFocus::Name => TopicNewFocus::Abort,
                        TopicNewFocus::AutoJoin => TopicNewFocus::Name,
                        TopicNewFocus::PasswordToggle => TopicNewFocus::AutoJoin,
                        TopicNewFocus::Password => TopicNewFocus::PasswordToggle,
                        TopicNewFocus::Save => TopicNewFocus::Password,
                        TopicNewFocus::Abort => TopicNewFocus::Save,
                    };
                }
                KeyCode::Enter => {
                    match self.topic_new.focus {
                        TopicNewFocus::AutoJoin => self.topic_new.auto_join = !self.topic_new.auto_join,
                        TopicNewFocus::PasswordToggle => {
                            self.topic_new.password_enabled = !self.topic_new.password_enabled
                        }
                        TopicNewFocus::Save => return UiCommand::TopicNewSave,
                        TopicNewFocus::Abort => return UiCommand::TopicNewCancel,
                        _ => {}
                    }
                }
                KeyCode::Backspace => {
                    if self.topic_new.focus == TopicNewFocus::Name {
                        self.topic_new.name.pop();
                    } else if self.topic_new.focus == TopicNewFocus::Password && self.topic_new.password_enabled {
                        self.topic_new.password.pop();
                    }
                }
                KeyCode::Char(c) => {
                    if self.topic_new.focus == TopicNewFocus::Name {
                        self.topic_new.name.push(c);
                    } else if self.topic_new.focus == TopicNewFocus::Password && self.topic_new.password_enabled {
                        self.topic_new.password.push(c);
                    }
                }
                _ => {}
            }
            return UiCommand::None;
        }

        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                };
                if !self.topics.is_empty() {
                    self.table_state.select(Some(next));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.topics.is_empty() {
                    self.table_state.select(Some(next));
                }
            }
            KeyCode::Char('r') => return UiCommand::Refresh,
            KeyCode::Enter => return UiCommand::JoinSelected,
            KeyCode::Backspace => return UiCommand::LeaveSelected,
            KeyCode::Char('n') => return UiCommand::TopicNewOpen,
            KeyCode::Char('x') | KeyCode::Delete => return UiCommand::TopicRemoveSelected,
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        if self.topic_new.open {
            let popup = centered_rect(60, 60, area);
            let inner = popup.inner(Margin { vertical: 1, horizontal: 1 });
            let pchunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                ]
                .as_ref())
                .split(inner);
            let btns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)].as_ref())
                .split(pchunks[4]);

            match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    if !contains(popup, mouse.column, mouse.row) {
                        return UiCommand::TopicNewCancel;
                    }
                    if mouse_in(pchunks[0], &mouse) {
                        self.topic_new.focus = TopicNewFocus::Name;
                    } else if mouse_in(pchunks[1], &mouse) {
                        self.topic_new.focus = TopicNewFocus::AutoJoin;
                        self.topic_new.auto_join = !self.topic_new.auto_join;
                    } else if mouse_in(pchunks[2], &mouse) {
                        self.topic_new.focus = TopicNewFocus::PasswordToggle;
                        self.topic_new.password_enabled = !self.topic_new.password_enabled;
                    } else if mouse_in(pchunks[3], &mouse) {
                        self.topic_new.focus = TopicNewFocus::Password;
                    } else if mouse_in(btns[0], &mouse) {
                        self.topic_new.focus = TopicNewFocus::Save;
                        return UiCommand::TopicNewSave;
                    } else if mouse_in(btns[1], &mouse) {
                        self.topic_new.focus = TopicNewFocus::Abort;
                        return UiCommand::TopicNewCancel;
                    }
                }
                _ => {}
            }
            return UiCommand::None;
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(7)].as_ref())
            .split(area);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(65), Constraint::Percentage(35)].as_ref())
            .split(chunks[0]);

        let list_area = main[0];
        let details_area = main[1];

        let scrollbar_metrics = compute_scrollbar_metrics(
            list_area,
            1,
            self.topics.len(),
            self.table_state.offset(),
        );

        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints(
                [
                    Constraint::Min(6),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                ]
                .as_ref(),
            )
            .split(details_area);

        // Hover handling (Move) + click handling.
        let mut cmd = UiCommand::None;

        if mouse_in(detail_chunks[1], &mouse) {
            self.hovered = Hovered::Join;
        } else if mouse_in(detail_chunks[2], &mouse) {
            self.hovered = Hovered::Leave;
        } else if mouse_in(detail_chunks[3], &mouse) {
            self.hovered = Hovered::Remove;
        } else if mouse_in(detail_chunks[4], &mouse) {
            self.hovered = Hovered::New;
        } else {
            self.hovered = Hovered::None;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // Scrollbar interactions.
                if let Some(metrics) = scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.table_state.offset_mut() = offset;
                                self.table_state
                                    .select(Some(offset.min(self.topics.len().saturating_sub(1))));
                                return UiCommand::None;
                            }
                        }
                    }
                }

                // Click on list row to select
                // List inner area excludes borders.
                let inner = Rect {
                    x: list_area.x.saturating_add(1),
                    y: list_area.y.saturating_add(1),
                    width: list_area.width.saturating_sub(2),
                    height: list_area.height.saturating_sub(2),
                };

                if contains(inner, mouse.column, mouse.row) {
                    // Table has a 1-row header; clicks should map to data rows.
                    let rel_y = mouse.row.saturating_sub(inner.y) as usize;
                    if rel_y >= 1 {
                        let row = rel_y - 1;
                        let idx = self.table_state.offset().saturating_add(row);
                        if idx < self.topics.len() {
                            self.table_state.select(Some(idx));
                        }
                    }
                }

                // Click on buttons
                if mouse_in(detail_chunks[1], &mouse) {
                    cmd = UiCommand::JoinSelected;
                } else if mouse_in(detail_chunks[2], &mouse) {
                    cmd = UiCommand::LeaveSelected;
                } else if mouse_in(detail_chunks[3], &mouse) {
                    cmd = UiCommand::TopicRemoveSelected;
                } else if mouse_in(detail_chunks[4], &mouse) {
                    cmd = UiCommand::TopicNewOpen;
                }
            }

            MouseEventKind::Drag(MouseButton::Left) => {
                if let (Some(metrics), Some(grab)) = (scrollbar_metrics, self.scrollbar_drag) {
                    let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                    *self.table_state.offset_mut() = target;
                    self.table_state
                        .select(Some(target.min(self.topics.len().saturating_sub(1))));
                }
            }

            MouseEventKind::Up(MouseButton::Left) => {
                self.scrollbar_drag = None;
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                    };
                    if !self.topics.is_empty() {
                        self.table_state.select(Some(next));
                    }
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => i.saturating_sub(1),
                    };
                    if !self.topics.is_empty() {
                        self.table_state.select(Some(next));
                    }
                }
            }
            _ => {}
        }

        cmd
    }
}

fn parse_overview_topics(v: &Value) -> Vec<TopicRow> {
    let arr = match v.get("topics").and_then(|x| x.as_array()) {
        Some(a) => a,
        None => return vec![],
    };

    arr.iter()
        .filter_map(|t| {
            Some(TopicRow {
                name: t.get("name")?.as_str()?.to_string(),
                key: t
                    .get("topicKey")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                auto_join: t.get("autoJoin").and_then(|x| x.as_bool()),
                last_joined_at: t.get("lastJoinedAt").and_then(|x| x.as_i64()),
                joined: t.get("joined").and_then(|x| x.as_bool()).unwrap_or(false),
                peers: t.get("peers").and_then(|x| x.as_u64()).unwrap_or(0),
            })
        })
        .collect()
}
