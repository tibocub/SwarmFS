use crate::app::App;
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame,
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct TopicRow {
    pub name: String,
    pub key: Option<String>,
    pub auto_join: Option<bool>,
    pub last_joined_at: Option<i64>,
}

pub struct NetworkTab {
    topics: Vec<TopicRow>,
    list_state: ListState,
    last_error: Option<String>,
}

impl NetworkTab {
    pub fn new() -> Self {
        let mut list_state = ListState::default();
        list_state.select(Some(0));
        Self {
            topics: Vec::new(),
            list_state,
            last_error: None,
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("topic.list", serde_json::json!({})) {
            Ok(v) => {
                self.topics = parse_topics(v);
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

        let items: Vec<ListItem> = self
            .topics
            .iter()
            .map(|t| {
                let label = t.name.clone();
                ListItem::new(Line::from(label))
            })
            .collect();

        let list = List::new(items)
            .block(Block::default().title("Topics").borders(Borders::ALL))
            .highlight_style(Style::default().fg(Color::Yellow).bg(Color::Black));

        f.render_stateful_widget(list, chunks[0], &mut self.list_state);

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
            KeyCode::Enter => return UiCommand::None,
            KeyCode::Backspace => return UiCommand::None,
            _ => {}
        }
        UiCommand::None
    }
}

fn parse_topics(v: Value) -> Vec<TopicRow> {
    let arr = match v.as_array() {
        Some(a) => a,
        None => return vec![],
    };

    arr.iter()
        .filter_map(|t| {
            Some(TopicRow {
                name: t.get("name")?.as_str()?.to_string(),
                key: t
                    .get("topic_key")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                auto_join: t.get("auto_join").and_then(|x| x.as_i64()).map(|n| n != 0),
                last_joined_at: t.get("last_joined_at").and_then(|x| x.as_i64()),
            })
        })
        .collect()
}
