use crossterm::event::MouseEvent;
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub fn contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.x.saturating_add(rect.width) && row >= rect.y && row < rect.y.saturating_add(rect.height)
}

pub fn mouse_in(rect: Rect, mouse: &MouseEvent) -> bool {
    contains(rect, mouse.column, mouse.row)
}

#[derive(Debug, Clone)]
pub struct Button {
    pub label: String,
    pub enabled: bool,
}

impl Button {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            enabled: true,
        }
    }

    pub fn draw(&self, f: &mut Frame, area: Rect, hovered: bool) {
        let base = if self.enabled {
            Style::default().fg(Color::White)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let style = if hovered && self.enabled {
            base.bg(Color::Blue)
        } else {
            base
        };

        let p = Paragraph::new(Line::from(self.label.clone()))
            .style(style)
            .block(Block::default().borders(Borders::ALL));
        f.render_widget(p, area);
    }
}
