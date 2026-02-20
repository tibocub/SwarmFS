use crate::app::App;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, MouseEvent, MouseEventKind};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub struct LogsTab {
    scroll: u16,
}

impl LogsTab {
    pub fn new() -> Self {
        Self { scroll: 0 }
    }

    fn max_scroll(&self, app: &App) -> u16 {
        // Rough: 1 line per log entry.
        app.logs.len().saturating_sub(1).min(u16::MAX as usize) as u16
    }
}

impl Tab for LogsTab {
    fn id(&self) -> TabId {
        TabId::Logs
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, app: &mut App) {
        let lines: Vec<Line> = app
            .logs
            .iter()
            .map(|e| {
                let msg = format!("[{}] {}", e.level, e.message);
                Line::styled(msg, Style::default().fg(Color::Gray))
            })
            .collect();

        let p = Paragraph::new(Text::from(lines))
            .block(Block::default().title("Logs").borders(Borders::ALL))
            .scroll((self.scroll, 0));

        f.render_widget(p, area);
    }

    fn on_key(&mut self, key: KeyEvent, app: &mut App) -> UiCommand {
        match key.code {
            KeyCode::Up => {
                self.scroll = self.scroll.saturating_sub(1);
            }
            KeyCode::Down => {
                self.scroll = (self.scroll + 1).min(self.max_scroll(app));
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(10);
            }
            KeyCode::PageDown => {
                self.scroll = (self.scroll + 10).min(self.max_scroll(app));
            }
            KeyCode::Char('g') => {
                self.scroll = 0;
            }
            KeyCode::Char('G') => {
                self.scroll = self.max_scroll(app);
            }
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, app: &mut App) -> UiCommand {
        let inside = mouse.column >= area.x
            && mouse.column < area.x + area.width
            && mouse.row >= area.y
            && mouse.row < area.y + area.height;

        if !inside {
            return UiCommand::None;
        }

        match mouse.kind {
            MouseEventKind::ScrollUp => {
                self.scroll = self.scroll.saturating_sub(3);
            }
            MouseEventKind::ScrollDown => {
                self.scroll = (self.scroll + 3).min(self.max_scroll(app));
            }
            _ => {}
        }

        UiCommand::None
    }
}
