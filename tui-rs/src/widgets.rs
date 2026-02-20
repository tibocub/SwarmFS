use crossterm::event::MouseEvent;
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph},
    Frame,
};
use std::collections::BTreeSet;

pub fn contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.x.saturating_add(rect.width) && row >= rect.y && row < rect.y.saturating_add(rect.height)
}

pub fn mouse_in(rect: Rect, mouse: &MouseEvent) -> bool {
    contains(rect, mouse.column, mouse.row)
}

pub fn hit_test_table_row(table_outer: Rect, header_rows: u16, mouse: &MouseEvent) -> Option<usize> {
    let inner = table_outer.inner(ratatui::layout::Margin {
        vertical: 1,
        horizontal: 1,
    });
    if inner.width == 0 || inner.height == 0 {
        return None;
    }
    if !contains(inner, mouse.column, mouse.row) {
        return None;
    }
    let rel_y = mouse.row.saturating_sub(inner.y) as usize;
    let header_rows = header_rows as usize;
    if rel_y < header_rows {
        return None;
    }
    Some(rel_y.saturating_sub(header_rows))
}

pub fn hit_test_table_index(
    table_outer: Rect,
    header_rows: u16,
    mouse: &MouseEvent,
    offset: usize,
    content_len: usize,
) -> Option<usize> {
    let row = hit_test_table_row(table_outer, header_rows, mouse)?;
    let idx = offset.saturating_add(row);
    if idx < content_len {
        Some(idx)
    } else {
        None
    }
}

pub fn nav_next_index(current: Option<usize>, len: usize, delta: isize) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let cur = current.unwrap_or(0).min(len.saturating_sub(1));
    let n = len as isize;
    let next = (cur as isize + delta).clamp(0, n.saturating_sub(1));
    Some(next as usize)
}

pub fn nav_page_delta(viewport_rows: usize, forward: bool) -> isize {
    let d = viewport_rows.max(1) as isize;
    if forward { d } else { -d }
}

#[derive(Debug, Clone, Default)]
pub struct MultiSelectState<K: Ord + Clone> {
    selected: BTreeSet<K>,
    anchor: Option<usize>,
}

impl<K: Ord + Clone> MultiSelectState<K> {
    pub fn selected(&self) -> &BTreeSet<K> {
        &self.selected
    }

    pub fn is_selected(&self, key: &K) -> bool {
        self.selected.contains(key)
    }

    pub fn set_anchor(&mut self, anchor_idx: Option<usize>) {
        self.anchor = anchor_idx;
    }

    pub fn clear(&mut self) {
        self.selected.clear();
        self.anchor = None;
    }

    pub fn set_single(&mut self, key: K, anchor_idx: usize) {
        self.selected.clear();
        self.selected.insert(key);
        self.anchor = Some(anchor_idx);
    }

    pub fn toggle(&mut self, key: K, anchor_idx: usize) {
        if self.selected.contains(&key) {
            self.selected.remove(&key);
        } else {
            self.selected.insert(key);
        }
        self.anchor = Some(anchor_idx);
    }

    pub fn range_select(&mut self, keys: &[K], target_idx: usize) {
        let Some(anchor) = self.anchor else {
            if let Some(k) = keys.get(target_idx) {
                self.set_single(k.clone(), target_idx);
            }
            return;
        };
        let a = anchor.min(target_idx);
        let b = anchor.max(target_idx);
        for i in a..=b {
            if let Some(k) = keys.get(i) {
                self.selected.insert(k.clone());
            }
        }
    }

    pub fn retain_existing(&mut self, existing: &BTreeSet<K>) {
        self.selected.retain(|k| existing.contains(k));
    }

    pub fn select_all(&mut self, keys: &[K]) {
        self.selected.clear();
        self.selected.extend(keys.iter().cloned());
    }

    pub fn invert(&mut self, keys: &[K]) {
        let mut next: BTreeSet<K> = BTreeSet::new();
        for k in keys {
            if !self.selected.contains(k) {
                next.insert(k.clone());
            }
        }
        self.selected = next;
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollbarMetrics {
    pub scrollbar_area: Rect,
    pub scrollbar_col: Rect,
    pub track_rows: usize,
    pub viewport_rows: usize,
    pub max_off: usize,
    pub denom: usize,
    pub thumb_top: usize,
    pub thumb_height: usize,
}

pub fn compute_scrollbar_metrics(
    table_outer: Rect,
    header_rows: u16,
    content_len: usize,
    offset: usize,
) -> Option<ScrollbarMetrics> {
    let inner = table_outer.inner(ratatui::layout::Margin {
        vertical: 1,
        horizontal: 1,
    });
    if inner.height == 0 {
        return None;
    }

    let viewport_rows = inner.height.saturating_sub(header_rows).max(1) as usize;
    if content_len <= viewport_rows {
        return None;
    }

    let scrollbar_area = Rect {
        x: inner.x,
        y: inner.y.saturating_add(header_rows),
        width: inner.width,
        height: inner.height.saturating_sub(header_rows),
    };
    let track_rows = scrollbar_area.height.max(1) as usize;

    let max_off = content_len.saturating_sub(viewport_rows);
    let pos = offset.min(max_off);

    let thumb_height = ((viewport_rows as u64 * viewport_rows as u64) / content_len.max(1) as u64)
        .max(1)
        .min(track_rows as u64) as usize;
    let denom = track_rows.saturating_sub(thumb_height);

    let thumb_top = if max_off == 0 || denom == 0 {
        0
    } else {
        (pos.saturating_mul(denom) / max_off).min(denom)
    };

    let scrollbar_col = Rect {
        x: scrollbar_area
            .x
            .saturating_add(scrollbar_area.width.saturating_sub(1)),
        y: scrollbar_area.y,
        width: 1,
        height: scrollbar_area.height,
    };

    Some(ScrollbarMetrics {
        scrollbar_area,
        scrollbar_col,
        track_rows,
        viewport_rows,
        max_off,
        denom,
        thumb_top,
        thumb_height,
    })
}

pub fn render_scrollbar(f: &mut Frame, metrics: ScrollbarMetrics) {
    let mut lines: Vec<Line> = Vec::with_capacity(metrics.track_rows);
    for r in 0..metrics.track_rows {
        let ch = if r >= metrics.thumb_top && r < metrics.thumb_top.saturating_add(metrics.thumb_height) {
            "█"
        } else {
            "│"
        };
        lines.push(Line::from(ch));
    }
    let sb = Paragraph::new(Text::from(lines)).style(Style::default().bg(Color::Black));
    f.render_widget(sb, metrics.scrollbar_col);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollbarDownResult {
    None,
    StartDrag { grab: usize },
    JumpTo { offset: usize },
}

pub fn handle_scrollbar_down(metrics: ScrollbarMetrics, mouse_row: u16) -> ScrollbarDownResult {
    let rel = mouse_row.saturating_sub(metrics.scrollbar_area.y) as usize;

    if rel >= metrics.thumb_top && rel < metrics.thumb_top.saturating_add(metrics.thumb_height) {
        return ScrollbarDownResult::StartDrag {
            grab: rel.saturating_sub(metrics.thumb_top),
        };
    }

    let desired_thumb_top = rel.saturating_sub(metrics.thumb_height / 2).min(metrics.denom);
    let target = if metrics.max_off == 0 || metrics.denom == 0 {
        0
    } else {
        (desired_thumb_top.saturating_mul(metrics.max_off) / metrics.denom).min(metrics.max_off)
    };

    ScrollbarDownResult::JumpTo { offset: target }
}

pub fn handle_scrollbar_drag(metrics: ScrollbarMetrics, grab: usize, mouse_row: u16) -> usize {
    let clamped_row = mouse_row
        .clamp(
            metrics.scrollbar_area.y,
            metrics
                .scrollbar_area
                .y
                .saturating_add(metrics.scrollbar_area.height.saturating_sub(1)),
        )
        .saturating_sub(metrics.scrollbar_area.y) as usize;

    let desired_thumb_top = clamped_row.saturating_sub(grab).min(metrics.denom);
    if metrics.max_off == 0 || metrics.denom == 0 {
        0
    } else {
        (desired_thumb_top.saturating_mul(metrics.max_off) / metrics.denom).min(metrics.max_off)
    }
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
