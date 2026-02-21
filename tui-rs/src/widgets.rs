use crossterm::event::MouseEvent;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::Rect,
    layout::Margin,
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph},
    Frame,
};
use ratatui::widgets::TableState;
use std::collections::BTreeSet;

pub fn contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.x.saturating_add(rect.width) && row >= rect.y && row < rect.y.saturating_add(rect.height)
}

pub fn mouse_in(rect: Rect, mouse: &MouseEvent) -> bool {
    contains(rect, mouse.column, mouse.row)
}

#[derive(Debug, Clone, Copy)]
pub struct TableHitTestSpec {
    pub header_rows: u16,
    pub inner_margin: Margin,
    pub hit_y_shift: i16,
    pub hit_extra_height: u16,
    pub checkbox_width: u16,
    pub checkbox_rel_x_bias: u16,
}

impl TableHitTestSpec {
    pub fn bordered(header_rows: u16) -> Self {
        Self {
            header_rows,
            inner_margin: Margin {
                vertical: 1,
                horizontal: 1,
            },
            hit_y_shift: 0,
            hit_extra_height: 0,
            checkbox_width: 0,
            checkbox_rel_x_bias: 0,
        }
    }
}

impl Default for TableHitTestSpec {
    fn default() -> Self {
        Self::bordered(0)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MultiSelectTableController {
    pub spec: TableHitTestSpec,
}

impl MultiSelectTableController {
    pub fn new(spec: TableHitTestSpec) -> Self {
        Self { spec }
    }

    pub fn hit_rect(&self, table_outer: Rect) -> Rect {
        let mut out = table_outer;

        if self.spec.hit_y_shift < 0 {
            let dy = (-self.spec.hit_y_shift) as u16;
            out.y = out.y.saturating_sub(dy);
        } else if self.spec.hit_y_shift > 0 {
            let dy = self.spec.hit_y_shift as u16;
            out.y = out.y.saturating_add(dy);
        }

        out.height = out.height.saturating_add(self.spec.hit_extra_height);
        out
    }

    pub fn hit_test_row(&self, table_outer: Rect, mouse: &MouseEvent) -> Option<usize> {
        hit_test_table_row_with_margin(
            self.hit_rect(table_outer),
            self.spec.header_rows,
            self.spec.inner_margin,
            mouse,
        )
    }

    pub fn hit_test_index(
        &self,
        table_outer: Rect,
        mouse: &MouseEvent,
        offset: usize,
        content_len: usize,
    ) -> Option<usize> {
        hit_test_table_index_with_margin(
            self.hit_rect(table_outer),
            self.spec.header_rows,
            self.spec.inner_margin,
            mouse,
            offset,
            content_len,
        )
    }

    pub fn is_checkbox_toggle(&self, table_outer: Rect, mouse: &MouseEvent) -> bool {
        if self.spec.checkbox_width == 0 {
            return false;
        }

        let inner = self.hit_rect(table_outer).inner(self.spec.inner_margin);
        if inner.width == 0 || inner.height == 0 {
            return false;
        }
        if !contains(inner, mouse.column, mouse.row) {
            return false;
        }
        let rel_x = mouse
            .column
            .saturating_sub(inner.x)
            .saturating_sub(self.spec.checkbox_rel_x_bias);
        rel_x < self.spec.checkbox_width
    }

    pub fn click_from_mouse<K: Ord + Clone>(
        &self,
        table_outer: Rect,
        mouse: &MouseEvent,
        offset: usize,
        keys: &[K],
        table_state: &mut TableState,
        sel: &mut MultiSelectState<K>,
        drag_select_start: &mut Option<usize>,
    ) -> Option<usize> {
        let idx = self.hit_test_index(table_outer, mouse, offset, keys.len())?;
        let is_ctrl = mouse.modifiers.contains(KeyModifiers::CONTROL);
        let is_shift = mouse.modifiers.contains(KeyModifiers::SHIFT);
        let is_checkbox_toggle = self.is_checkbox_toggle(table_outer, mouse);
        multiselect_table_click(
            idx,
            keys,
            table_state,
            sel,
            is_ctrl,
            is_shift,
            is_checkbox_toggle,
            drag_select_start,
        );
        Some(idx)
    }

    pub fn drag_from_mouse<K: Ord + Clone>(
        &self,
        table_outer: Rect,
        mouse: &MouseEvent,
        offset: usize,
        keys: &[K],
        table_state: &mut TableState,
        sel: &mut MultiSelectState<K>,
        drag_select_start: &mut Option<usize>,
    ) -> Option<usize> {
        let idx = self.hit_test_index(table_outer, mouse, offset, keys.len())?;
        multiselect_table_drag_update(idx, keys, table_state, sel, drag_select_start);
        Some(idx)
    }

    pub fn scrollbar_metrics(
        &self,
        table_outer: Rect,
        content_len: usize,
        offset: usize,
    ) -> Option<ScrollbarMetrics> {
        compute_scrollbar_metrics_with_margin(
            self.hit_rect(table_outer),
            self.spec.header_rows,
            self.spec.inner_margin,
            content_len,
            offset,
        )
    }
}

pub fn hit_test_table_row_with_margin(
    table_outer: Rect,
    header_rows: u16,
    margin: Margin,
    mouse: &MouseEvent,
) -> Option<usize> {
    let inner = table_outer.inner(margin);
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

pub fn hit_test_table_index_with_margin(
    table_outer: Rect,
    header_rows: u16,
    margin: Margin,
    mouse: &MouseEvent,
    offset: usize,
    content_len: usize,
) -> Option<usize> {
    let row = hit_test_table_row_with_margin(table_outer, header_rows, margin, mouse)?;
    let idx = offset.saturating_add(row);
    if idx < content_len {
        Some(idx)
    } else {
        None
    }
}

pub fn hit_test_table_row(table_outer: Rect, header_rows: u16, mouse: &MouseEvent) -> Option<usize> {
    hit_test_table_row_with_margin(
        table_outer,
        header_rows,
        Margin {
            vertical: 1,
            horizontal: 1,
        },
        mouse,
    )
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextInputAction {
    None,
    Changed,
    Submit,
    Cancel,
}

#[derive(Debug, Clone, Default)]
pub struct TextInput {
    value: String,
}

impl TextInput {
    pub fn new() -> Self {
        Self { value: String::new() }
    }

    pub fn from(value: String) -> Self {
        Self { value }
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn set(&mut self, value: String) {
        self.value = value;
    }

    pub fn clear(&mut self) {
        self.value.clear();
    }

    pub fn pop(&mut self) -> bool {
        self.value.pop().is_some()
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> TextInputAction {
        match key.code {
            KeyCode::Esc => TextInputAction::Cancel,
            KeyCode::Enter => TextInputAction::Submit,
            KeyCode::Backspace => {
                if self.value.pop().is_some() {
                    TextInputAction::Changed
                } else {
                    TextInputAction::None
                }
            }
            KeyCode::Char(c) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) || c.is_control() {
                    return TextInputAction::None;
                }
                self.value.push(c);
                TextInputAction::Changed
            }
            _ => TextInputAction::None,
        }
    }

    pub fn draw(&self, f: &mut Frame, area: Rect, title: &str, focused: bool) {
        let style = if focused {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };

        let p = Paragraph::new(Line::from(self.value.clone()))
            .style(style)
            .block(Block::default().title(title).borders(Borders::ALL));
        f.render_widget(p, area);
    }
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

    pub fn insert_selected(&mut self, key: K) {
        self.selected.insert(key);
    }
}

pub fn multiselect_table_click<K: Ord + Clone>(
    idx: usize,
    keys: &[K],
    table_state: &mut TableState,
    sel: &mut MultiSelectState<K>,
    is_ctrl: bool,
    is_shift: bool,
    is_checkbox_toggle: bool,
    drag_select_start: &mut Option<usize>,
) {
    table_state.select(Some(idx));

    if is_shift {
        sel.range_select(keys, idx);
        *drag_select_start = None;
        return;
    }

    if is_ctrl || is_checkbox_toggle {
        if let Some(k) = keys.get(idx) {
            sel.toggle(k.clone(), idx);
        }
        *drag_select_start = None;
        return;
    }

    if let Some(k) = keys.get(idx) {
        sel.set_single(k.clone(), idx);
    } else {
        sel.clear();
    }
    *drag_select_start = Some(idx);
}

pub fn multiselect_table_drag_update<K: Ord + Clone>(
    current_idx: usize,
    keys: &[K],
    table_state: &mut TableState,
    sel: &mut MultiSelectState<K>,
    drag_select_start: &mut Option<usize>,
) {
    let Some(start) = *drag_select_start else {
        return;
    };

    let a = start.min(current_idx);
    let b = start.max(current_idx);

    table_state.select(Some(current_idx));

    sel.clear();
    sel.set_anchor(Some(start));
    for i in a..=b {
        if let Some(k) = keys.get(i) {
            sel.insert_selected(k.clone());
        }
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
    compute_scrollbar_metrics_with_margin(
        table_outer,
        header_rows,
        Margin {
            vertical: 1,
            horizontal: 1,
        },
        content_len,
        offset,
    )
}

pub fn compute_scrollbar_metrics_with_margin(
    table_outer: Rect,
    header_rows: u16,
    margin: Margin,
    content_len: usize,
    offset: usize,
) -> Option<ScrollbarMetrics> {
    let inner = table_outer.inner(margin);
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
