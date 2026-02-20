use crate::app::{App, TabHitbox};
use crate::tabs::TabId;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub struct LayoutAreas {
    pub tab_bar: Rect,
    pub content: Rect,
    pub footer: Rect,
}

pub fn layout(area: Rect) -> LayoutAreas {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);

    LayoutAreas {
        tab_bar: chunks[0],
        content: chunks[1],
        footer: chunks[2],
    }
}

pub fn draw_tab_bar(f: &mut Frame, area: Rect, app: &mut App) {
    // Simple, explicit renderer so we can compute hitboxes.
    let mut spans: Vec<Span> = Vec::new();
    let mut hitboxes: Vec<TabHitbox> = Vec::new();

    let mut x = area.x;
    let y0 = area.y;

    for (i, tab) in TabId::ALL.iter().enumerate() {
        if i > 0 {
            let sep = " | ";
            spans.push(Span::raw(sep));
            x += sep.len() as u16;
        }

        let label = format!("{} {}", tab.number(), tab.title());
        let style = if *tab == app.active_tab {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default().fg(Color::Gray)
        };

        let w = label.len() as u16;
        hitboxes.push(TabHitbox {
            tab: *tab,
            x0: x,
            x1: x.saturating_add(w),
            y0,
            y1: y0 + 1,
        });

        spans.push(Span::styled(label, style));
        x += w;
    }

    app.ui.tab_hitboxes = hitboxes;

    let p = Paragraph::new(Line::from(spans));
    f.render_widget(p, area);
}

pub fn draw_footer(f: &mut Frame, area: Rect, app: &mut App) {
    let text = format!("Tab {} | q quit", app.active_tab.title());
    let p = Paragraph::new(text)
        .block(Block::default().borders(Borders::TOP));
    f.render_widget(p, area);
}
