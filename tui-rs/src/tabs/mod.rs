use crate::app::App;
use crate::ipc::NetworkEvent;
use crossterm::event::{KeyCode, KeyEvent, MouseEvent};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub mod network;
pub mod stubs;
pub mod logs;

pub use logs::LogsTab;
pub use network::NetworkTab;
pub use stubs::{BrowseTab, DownloadsTab, FilesTab};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabId {
    Network,
    Browse,
    Downloads,
    Files,
    Logs,
}

impl TabId {
    pub const ALL: [TabId; 5] = [
        TabId::Network,
        TabId::Browse,
        TabId::Downloads,
        TabId::Files,
        TabId::Logs,
    ];

    pub fn title(self) -> &'static str {
        match self {
            TabId::Network => "Network",
            TabId::Browse => "Browse",
            TabId::Downloads => "Downloads",
            TabId::Files => "Files",
            TabId::Logs => "Logs",
        }
    }

    pub fn number(self) -> usize {
        match self {
            TabId::Network => 1,
            TabId::Browse => 2,
            TabId::Downloads => 3,
            TabId::Files => 4,
            TabId::Logs => 5,
        }
    }

    pub fn from_number(n: usize) -> Option<Self> {
        match n {
            1 => Some(TabId::Network),
            2 => Some(TabId::Browse),
            3 => Some(TabId::Downloads),
            4 => Some(TabId::Files),
            5 => Some(TabId::Logs),
            _ => None,
        }
    }
}

pub enum UiCommand {
    None,
    Quit,
    SwitchTab(TabId),
    Refresh,
    JoinSelected,
    LeaveSelected,
}

pub trait Tab {
    fn id(&self) -> TabId;
    fn draw(&mut self, f: &mut Frame, area: Rect, app: &mut App);
    fn on_key(&mut self, _key: KeyEvent, _app: &mut App) -> UiCommand {
        UiCommand::None
    }
    fn on_mouse(&mut self, _mouse: MouseEvent, _area: Rect, _app: &mut App) -> UiCommand {
        UiCommand::None
    }
    fn on_network_event(&mut self, _evt: NetworkEvent, _app: &mut App) {}
}

pub fn draw_placeholder(f: &mut Frame, area: Rect, title: &str) {
    let p = Paragraph::new(Line::from(vec![Span::raw("TODO")]))
        .block(Block::default().title(title).borders(Borders::ALL));
    f.render_widget(p, area);
}

pub fn tab_label(tab: TabId, active: bool) -> Line<'static> {
    let text = format!("{} {}", tab.number(), tab.title());
    if active {
        Line::from(Span::styled(text, Style::default().fg(Color::Yellow)))
    } else {
        Line::from(Span::raw(text))
    }
}

pub fn top_row_char_to_number(c: char) -> Option<usize> {
    // Layout-agnostic-ish mapping for the top digit row.
    // - QWERTY: '1'..'9','0'
    // - Shifted QWERTY: '!','@','#','$','%','^','&','*','(',')'
    // - AZERTY: '&','é','"','\'', '(', '-', 'è', '_', 'ç', 'à'
    match c {
        // 1..6
        '1' | '&' | '!' => Some(1),
        '2' | 'é' | '@' => Some(2),
        '3' | '"' | '#' => Some(3),
        '4' | '\'' | '$' => Some(4),
        '5' | '(' | '%' => Some(5),
        '6' | '-' | '^' => Some(6),

        // 7..0
        // NOTE: don't map '&' to 7 (AZERTY uses '&' for the physical "1" key).
        '7' | 'è' => Some(7),
        '8' | '_' | '*' => Some(8),
        // NOTE: don't map '(' to 9 (AZERTY uses '(' for the physical "5" key).
        '9' | 'ç' => Some(9),
        '0' | 'à' | ')' => Some(10),
        _ => None,
    }
}

pub fn global_keybind(key: KeyEvent) -> UiCommand {
    match key.code {
        KeyCode::Char('q') => UiCommand::Quit,
        KeyCode::Char(c) => {
            if let Some(n) = top_row_char_to_number(c) {
                if let Some(tab) = TabId::from_number(n) {
                    return UiCommand::SwitchTab(tab);
                }
            }
            UiCommand::None
        }
        _ => UiCommand::None,
    }
}
