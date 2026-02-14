use crate::app::App;
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame,
};
use serde_json::Value;
use crate::widgets::{contains, mouse_in, Button};

#[derive(Debug, Clone)]
pub struct TopicRow {
    pub name: String,
    pub key: Option<String>,
    pub auto_join: Option<bool>,
    pub last_joined_at: Option<i64>,
    pub joined: bool,
    pub peers: u64,
}

pub struct NetworkTab {
    topics: Vec<TopicRow>,
    list_state: ListState,
    last_error: Option<String>,
    hovered: Hovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hovered {
    None,
    Join,
    Leave,
}

impl NetworkTab {
    pub fn new() -> Self {
        let mut list_state = ListState::default();
        list_state.select(Some(0));
        Self {
            topics: Vec::new(),
            list_state,
            last_error: None,
            hovered: Hovered::None,
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("network.overview", serde_json::json!({})) {
            Ok(v) => {
                self.topics = parse_overview_topics(&v);
                if self.topics.is_empty() {
                    self.list_state.select(None);
                } else if self.list_state.selected().is_none() {
                    self.list_state.select(Some(0));
                }
                self.last_error = None;
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    fn selected_topic_name(&self) -> Option<String> {
        let idx = self.list_state.selected()?;
        self.topics.get(idx).map(|t| t.name.clone())
    }

    fn selected_topic(&self) -> Option<&TopicRow> {
        let idx = self.list_state.selected()?;
        self.topics.get(idx)
    }

    pub fn join_selected(&mut self, ipc: &mut IpcClient) {
        if let Some(name) = self.selected_topic_name() {
            if let Err(e) = ipc.rpc("topic.join", serde_json::json!({"name": name})) {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn leave_selected(&mut self, ipc: &mut IpcClient) {
        if let Some(name) = self.selected_topic_name() {
            if let Err(e) = ipc.rpc("topic.leave", serde_json::json!({"name": name})) {
                self.last_error = Some(e.to_string());
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

        let items: Vec<ListItem> = self
            .topics
            .iter()
            .map(|t| {
                let status = if t.joined { "[joined]" } else { "[ ]" };
                let label = format!("{} {}  peers:{}", status, t.name, t.peers);
                ListItem::new(Line::from(label))
            })
            .collect();

        let list = List::new(items)
            .block(Block::default().title("Topics").borders(Borders::ALL))
            .highlight_style(Style::default().fg(Color::Yellow).bg(Color::Black));

        f.render_stateful_widget(list, list_area, &mut self.list_state);

        // Details + actions panel
        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(6), Constraint::Length(3), Constraint::Length(3)].as_ref())
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

        let stats_txt = if let Some(v) = &app.network.stats_json {
            serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
        } else {
            "(no network stats yet)".to_string()
        };

        let mut lines = vec![Line::from("Keys: r refresh | Enter join | Backspace leave | j/k move")];
        if let Some(e) = &self.last_error {
            lines.push(Line::from(format!("Error: {}", e)));
        }
        lines.push(Line::from(""));
        lines.extend(Text::from(stats_txt).lines);

        let stats = Paragraph::new(Text::from(lines))
            .block(Block::default().title("Network").borders(Borders::ALL));
        f.render_widget(stats, chunks[1]);
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                let next = match self.list_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                };
                if !self.topics.is_empty() {
                    self.list_state.select(Some(next));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let next = match self.list_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.topics.is_empty() {
                    self.list_state.select(Some(next));
                }
            }
            KeyCode::Char('r') => return UiCommand::Refresh,
            KeyCode::Enter => return UiCommand::JoinSelected,
            KeyCode::Backspace => return UiCommand::LeaveSelected,
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
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

        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(6), Constraint::Length(3), Constraint::Length(3)].as_ref())
            .split(details_area);

        // Hover handling (Move) + click handling.
        let mut cmd = UiCommand::None;

        if mouse_in(detail_chunks[1], &mouse) {
            self.hovered = Hovered::Join;
        } else if mouse_in(detail_chunks[2], &mouse) {
            self.hovered = Hovered::Leave;
        } else {
            self.hovered = Hovered::None;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // Click on list row to select
                // List inner area excludes borders.
                let inner = Rect {
                    x: list_area.x.saturating_add(1),
                    y: list_area.y.saturating_add(1),
                    width: list_area.width.saturating_sub(2),
                    height: list_area.height.saturating_sub(2),
                };

                if contains(inner, mouse.column, mouse.row) {
                    let row = mouse.row.saturating_sub(inner.y) as usize;
                    if row < self.topics.len() {
                        self.list_state.select(Some(row));
                    }
                }

                // Click on buttons
                if mouse_in(detail_chunks[1], &mouse) {
                    cmd = UiCommand::JoinSelected;
                } else if mouse_in(detail_chunks[2], &mouse) {
                    cmd = UiCommand::LeaveSelected;
                }
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.list_state.selected() {
                        None => 0,
                        Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                    };
                    if !self.topics.is_empty() {
                        self.list_state.select(Some(next));
                    }
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.list_state.selected() {
                        None => 0,
                        Some(i) => i.saturating_sub(1),
                    };
                    if !self.topics.is_empty() {
                        self.list_state.select(Some(next));
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
