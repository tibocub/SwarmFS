use crate::app::App;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::widgets::{
    compute_scrollbar_metrics, contains, handle_scrollbar_down, handle_scrollbar_drag,
    render_scrollbar, ScrollbarDownResult,
};

pub struct LogsTab {
    scroll: u16,
    follow: bool,
    scrollbar_drag: Option<usize>,
}

impl LogsTab {
    pub fn new() -> Self {
        Self {
            scroll: 0,
            follow: true,
            scrollbar_drag: None,
        }
    }

    pub fn on_activated(&mut self) {
        self.follow = true;
        self.scrollbar_drag = None;
    }

    fn max_scroll(&self, app: &App, viewport_rows: u16) -> u16 {
        // 1 line per entry.
        let len = app.logs.len().min(u16::MAX as usize) as u16;
        len.saturating_sub(viewport_rows)
    }

    fn update_follow_scroll(&mut self, area: Rect, app: &App) {
        let viewport_rows = area.height.saturating_sub(2).max(1);
        let max_scroll = self.max_scroll(app, viewport_rows);
        if self.follow {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }
    }
}

impl Tab for LogsTab {
    fn id(&self) -> TabId {
        TabId::Logs
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, app: &mut App) {
        self.update_follow_scroll(area, app);

        let lines: Vec<Line> = app
            .logs
            .iter()
            .map(|e| {
                let msg = format!("[{}] {}", e.level, e.message);
                Line::styled(msg, Style::default().fg(Color::Gray))
            })
            .collect();

        let show_scrollbar = area.height >= 3
            && app.logs.len() > area.height.saturating_sub(2).max(1) as usize;
        let mut text_area = area;
        if show_scrollbar {
            text_area.width = text_area.width.saturating_sub(1);
        }

        let p = Paragraph::new(Text::from(lines))
            .block(Block::default().title("Logs").borders(Borders::ALL))
            .scroll((self.scroll, 0));

        f.render_widget(p, text_area);

        if let Some(metrics) = compute_scrollbar_metrics(area, 0, app.logs.len(), self.scroll as usize) {
            render_scrollbar(f, metrics);
        }
    }

    fn on_key(&mut self, key: KeyEvent, app: &mut App) -> UiCommand {
        // We don't have access to the last rendered area here, so use a conservative
        // viewport guess; draw() will clamp and/or stick-to-bottom as needed.
        let viewport_rows = 10u16;
        let max_scroll = self.max_scroll(app, viewport_rows);

        match key.code {
            KeyCode::Up => {
                self.scroll = self.scroll.saturating_sub(1);
                self.follow = false;
            }
            KeyCode::Down => {
                self.scroll = (self.scroll + 1).min(max_scroll);
                if self.scroll >= max_scroll {
                    self.follow = true;
                }
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(10);
                self.follow = false;
            }
            KeyCode::PageDown => {
                self.scroll = (self.scroll + 10).min(max_scroll);
                if self.scroll >= max_scroll {
                    self.follow = true;
                }
            }
            KeyCode::Char('g') => {
                self.scroll = 0;
                self.follow = false;
            }
            KeyCode::Char('G') => {
                self.scroll = max_scroll;
                self.follow = true;
            }
            KeyCode::Enter => {
                self.follow = true;
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

        let viewport_rows = area.height.saturating_sub(2).max(1);
        let max_scroll = self.max_scroll(app, viewport_rows);
        let scrollbar_metrics = compute_scrollbar_metrics(area, 0, app.logs.len(), self.scroll as usize);

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(metrics) = scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.scrollbar_drag = Some(grab);
                                self.follow = false;
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                self.scroll = (offset as u16).min(max_scroll);
                                self.follow = self.scroll >= max_scroll;
                                return UiCommand::None;
                            }
                        }
                    }
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let (Some(grab), Some(metrics)) = (self.scrollbar_drag, scrollbar_metrics) {
                    let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                    self.scroll = (target as u16).min(max_scroll);
                    self.follow = self.scroll >= max_scroll;
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.scrollbar_drag = None;
            }
            MouseEventKind::ScrollUp => {
                self.scroll = self.scroll.saturating_sub(3);
                self.follow = false;
            }
            MouseEventKind::ScrollDown => {
                self.scroll = (self.scroll + 3).min(max_scroll);
                if self.scroll >= max_scroll {
                    self.follow = true;
                }
            }
            _ => {}
        }

        UiCommand::None
    }
}
