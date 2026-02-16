use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState},
    Frame,
};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::widgets::{
    compute_scrollbar_metrics, handle_scrollbar_down, handle_scrollbar_drag, hit_test_table_index,
    render_scrollbar, MultiSelectState, ScrollbarDownResult,
};

/// Action emitted by the picker.
///
/// The parent (Files tab) decides what to do with these actions
/// (e.g. call IPC, close the popup, refresh state, etc.).
#[derive(Debug, Clone)]
pub enum PickerAction {
    None,
    /// User confirmed selection (typically Enter while Table is focused).
    Confirm,
    /// User cancelled (Esc).
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Focus {
    Search,
    Table,
}

#[derive(Debug, Clone)]
struct PickerItem {
    path: PathBuf,
    label: String,
    is_dir: bool,
    size: Option<u64>,
}

#[derive(Debug, Clone)]
struct VisibleItem {
    item_idx: usize,
    score: i64,
    /// Indices (in chars) of characters in `label` that match the query.
    /// Used to highlight matches.
    match_indices: Vec<usize>,
}

/// A reusable file picker popup.
#[derive(Debug, Clone)]
pub struct FilePicker {
    open: bool,
    focus: Focus,

    cwd: PathBuf,
    items: Vec<PickerItem>,

    /// Derived view: indices into `items`, filtered + ranked by `query`.
    visible: Vec<VisibleItem>,

    table_state: TableState,

    // Mouse UX: detect double-click.
    last_click: Option<(usize, Instant)>,

    // Scrollbar mouse drag.
    scrollbar_drag: bool,

    // When dragging the scrollbar thumb, keep a stable grab offset within the thumb.
    scrollbar_grab: Option<usize>,

    // Cached viewport size (in rows) from the last draw. Used for page-up/page-down jumps.
    last_viewport_rows: usize,

    /// Selected paths remain selected even if they disappear due to filtering.
    selection: MultiSelectState<PathBuf>,

    query: String,
}

impl FilePicker {
    pub fn new(cwd: PathBuf) -> Self {
        let mut table_state = TableState::default();
        table_state.select(Some(0));

        Self {
            open: false,
            focus: Focus::Search,
            cwd,
            items: Vec::new(),
            visible: Vec::new(),
            table_state,
            last_click: None,
            scrollbar_drag: false,
            scrollbar_grab: None,
            last_viewport_rows: 10,
            selection: MultiSelectState::default(),
            query: String::new(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn open(&mut self, cwd: PathBuf) {
        self.open = true;
        self.focus = Focus::Search;
        self.cwd = cwd;
        self.query.clear();
        self.selection.clear();
        self.reload_items();
    }

    pub fn close(&mut self) {
        self.open = false;
        self.focus = Focus::Search;
    }

    pub fn selected_count(&self) -> usize {
        self.selection.selected().len()
    }

    pub fn selected_paths(&self) -> Vec<String> {
        self.selection
            .selected()
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }

    /// Returns the currently highlighted item path (based on the visible list).
    ///
    /// This is useful when the user presses Confirm without explicitly toggling a selection.
    pub fn current_path(&self) -> Option<String> {
        let sel = self.table_state.selected()?;
        let vi = self.visible.get(sel)?;
        let it = self.items.get(vi.item_idx)?;
        Some(it.path.to_string_lossy().to_string())
    }

    /// Draws the picker as a popup centered in `area`.
    pub fn draw(&mut self, f: &mut Frame, area: Rect) {
        if !self.open {
            return;
        }

        // The background layer is critical: without it, terminals keep old characters
        // for cells we don't explicitly paint in the new frame.
        let popup = centered_rect(80, 80, area);
        f.render_widget(Clear, popup);
        f.render_widget(
            Block::default()
                .style(Style::default().bg(Color::Black))
                .borders(Borders::ALL)
                .title("Add"),
            popup,
        );

        let inner = Rect {
            x: popup.x.saturating_add(1),
            y: popup.y.saturating_add(1),
            width: popup.width.saturating_sub(2),
            height: popup.height.saturating_sub(2),
        };

        // Layout inside popup:
        // - Search input
        // - Table
        // - Footer (selected counter + short help)
        let picker_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(5),
                Constraint::Length(3),
            ])
            .split(inner);

        // Approximate number of visible rows inside the table:
        // -2 for the table block borders.
        // (No header in this picker table.)
        self.last_viewport_rows = picker_chunks[1]
            .height
            .saturating_sub(2)
            .max(1) as usize;

        let search_style = if self.focus == Focus::Search {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };

        let q = Paragraph::new(Line::from(self.query.clone()))
            .style(search_style.bg(Color::Black))
            .block(
                Block::default()
                    .title("Search")
                    .borders(Borders::ALL)
                    .style(Style::default().bg(Color::Black)),
            );
        f.render_widget(q, picker_chunks[0]);

        let rows = self.visible.iter().map(|vi| {
            let it = &self.items[vi.item_idx];
            let mark = if self.selection.is_selected(&it.path) {
                "[x]"
            } else {
                "[ ]"
            };

            let typ = if it.is_dir { "d" } else { "f" };
            let size = it
                .size
                .map(format_bytes_short)
                .unwrap_or_else(|| "-".to_string());
            let label = render_highlighted_label(&it.label, &vi.match_indices);
            Row::new(vec![
                Cell::from(mark),
                Cell::from(typ),
                Cell::from(size),
                Cell::from(label),
            ])
        });

        let table_style = if self.focus == Focus::Table {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };

        let table = Table::new(
            rows,
            [
                Constraint::Length(4),
                Constraint::Length(2),
                Constraint::Length(8),
                Constraint::Min(10),
            ],
        )
            .style(Style::default().bg(Color::Black))
            .block(
                Block::default()
                    .title(self.cwd.to_string_lossy())
                    .borders(Borders::ALL)
                    .style(Style::default().bg(Color::Black))
                    .border_style(table_style),
            )
            .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        let show_scrollbar = self.visible.len() > self.last_viewport_rows;
        let mut table_area = picker_chunks[1];
        if show_scrollbar {
            table_area.width = table_area.width.saturating_sub(1);
        }

        f.render_stateful_widget(table, table_area, &mut self.table_state);

        if let Some(metrics) = compute_scrollbar_metrics(picker_chunks[1], 0, self.visible.len(), self.table_state.offset()) {
            render_scrollbar(f, metrics);
        }

        let footer = Paragraph::new(Line::from(vec![
            Span::raw(format!("Selected: {}  ", self.selection.selected().len())),
            Span::styled("/", Style::default().fg(Color::Yellow)),
            Span::raw(" focus search  "),
            Span::styled("Enter", Style::default().fg(Color::Yellow)),
            Span::raw(" confirm/cd  "),
            Span::styled("Backspace", Style::default().fg(Color::Yellow)),
            Span::raw(" up  "),
            Span::styled("Tab", Style::default().fg(Color::Yellow)),
            Span::raw(" toggle  "),
            Span::styled("Esc", Style::default().fg(Color::Yellow)),
            Span::raw(" cancel"),
        ]))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .style(Style::default().bg(Color::Black)),
        );
        f.render_widget(footer, picker_chunks[2]);
    }

    pub fn on_key(&mut self, key: KeyEvent) -> PickerAction {
        if !self.open {
            return PickerAction::None;
        }

        match key.code {
            KeyCode::Esc => {
                // If search has text, first Esc clears the query. Second Esc cancels.
                if self.focus == Focus::Search && !self.query.is_empty() {
                    self.query.clear();
                    self.recompute_visible();
                    return PickerAction::None;
                }
                return PickerAction::Cancel;
            }

            // Explicit focus: / or f focuses search.
            KeyCode::Char('/') | KeyCode::Char('f') => {
                self.focus = Focus::Search;
                return PickerAction::None;
            }

            // Navigation in the visible list.
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_selection(1);
                self.last_click = None;
                return PickerAction::None;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_selection(-1);
                self.last_click = None;
                return PickerAction::None;
            }

            // Page navigation for long lists.
            // - PgDn / J (shift-j): jump down by a viewport.
            // - PgUp / K (shift-k): jump up by a viewport.
            KeyCode::PageDown | KeyCode::Char('J') => {
                self.move_selection(self.last_viewport_rows as i32);
                self.last_click = None;
                return PickerAction::None;
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                self.move_selection(-(self.last_viewport_rows as i32));
                self.last_click = None;
                return PickerAction::None;
            }

            // Directory navigation shortcuts (table focus).
            // - h / Left: go up to parent
            // - l / Right: enter selected directory
            KeyCode::Char('h') | KeyCode::Left => {
                if self.focus == Focus::Table {
                    self.go_up();
                }
                return PickerAction::None;
            }
            KeyCode::Char('l') | KeyCode::Right => {
                if self.focus == Focus::Table {
                    if let Some(it) = self.current_item() {
                        if it.is_dir {
                            self.cwd = it.path.clone();
                            self.reload_items();
                        }
                    }
                }
                return PickerAction::None;
            }

            KeyCode::Tab => {
                self.toggle_selected_current();
                return PickerAction::None;
            }

            KeyCode::Enter => {
                match self.focus {
                    Focus::Search => {
                        // This matches the “fzf-like” feel: Enter locks the query
                        // and moves focus to the table.
                        self.focus = Focus::Table;
                        return PickerAction::None;
                    }
                    Focus::Table => {
                        // Enter on a directory navigates into it.
                        // Enter on a file confirms.
                        if let Some(it) = self.current_item() {
                            if it.is_dir {
                                self.cwd = it.path.clone();
                                self.reload_items();
                                return PickerAction::None;
                            }
                        }
                        return PickerAction::Confirm;
                    }
                }
            }

            // Backspace: in Search it edits query, in Table it navigates up.
            KeyCode::Backspace => {
                if self.focus == Focus::Search {
                    self.query.pop();
                    self.recompute_visible();
                } else {
                    self.go_up();
                }
                return PickerAction::None;
            }

            KeyCode::Char(c) => {
                if self.focus == Focus::Search && !c.is_control() {
                    self.query.push(c);
                    self.recompute_visible();
                    return PickerAction::None;
                }
            }

            _ => {}
        }

        PickerAction::None
    }

    pub fn on_mouse(&mut self, mouse: MouseEvent, area: Rect) -> PickerAction {
        if !self.open {
            return PickerAction::None;
        }

        let popup = centered_rect(80, 80, area);
        let inner = Rect {
            x: popup.x.saturating_add(1),
            y: popup.y.saturating_add(1),
            width: popup.width.saturating_sub(2),
            height: popup.height.saturating_sub(2),
        };
        let picker_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(5),
                Constraint::Length(3),
            ])
            .split(inner);

        let scrollbar_metrics = compute_scrollbar_metrics(
            picker_chunks[1],
            0,
            self.visible.len(),
            self.table_state.offset(),
        );

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(metrics) = scrollbar_metrics {
                    if crate::widgets::contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.scrollbar_drag = true;
                                self.scrollbar_grab = Some(grab);
                                return PickerAction::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.table_state.offset_mut() = offset;
                                self.table_state
                                    .select(Some(offset.min(self.visible.len().saturating_sub(1))));
                                self.selection.set_anchor(self.table_state.selected());
                                return PickerAction::None;
                            }
                        }
                    }
                }

                // Click search: focus search.
                if contains(picker_chunks[0], mouse.column, mouse.row) {
                    self.focus = Focus::Search;
                    return PickerAction::None;
                }

                // Click table: select row, and toggle if clicking on the marker column.
                if contains(picker_chunks[1], mouse.column, mouse.row) {
                    self.focus = Focus::Table;

                    if let Some(idx) = hit_test_table_index(
                        picker_chunks[1],
                        0,
                        &mouse,
                        self.table_state.offset(),
                        self.visible.len(),
                    ) {
                        let is_ctrl = mouse.modifiers.contains(KeyModifiers::CONTROL);
                        let is_shift = mouse.modifiers.contains(KeyModifiers::SHIFT);

                        if is_shift {
                            self.table_state.select(Some(idx));
                            self.select_range_to(idx);
                        } else if is_ctrl {
                            self.table_state.select(Some(idx));
                            self.selection.set_anchor(Some(idx));
                            self.toggle_selected_current();
                        } else {
                            self.table_state.select(Some(idx));
                            self.selection.set_anchor(Some(idx));

                            let inner_table = picker_chunks[1].inner(Margin {
                                vertical: 1,
                                horizontal: 1,
                            });

                            // If click is in the first 4 columns, interpret as toggle.
                            let rel_x = mouse.column.saturating_sub(inner_table.x);
                            if rel_x < 4 {
                                self.toggle_selected_current();
                            }

                            // Double click:
                            // - dir: enter it
                            // - file: if nothing selected, confirm this item; otherwise confirm current selection
                            let now = Instant::now();
                            let is_double = self
                                .last_click
                                .map(|(prev_idx, t)| {
                                    prev_idx == idx && now.duration_since(t) <= Duration::from_millis(400)
                                })
                                .unwrap_or(false);
                            self.last_click = Some((idx, now));

                            if is_double {
                                if let Some(it) = self.current_item() {
                                    if it.is_dir {
                                        self.cwd = it.path.clone();
                                        self.reload_items();
                                        return PickerAction::None;
                                    }
                                }

                                if self.selection.selected().is_empty() {
                                    self.toggle_selected_current();
                                }
                                return PickerAction::Confirm;
                            }
                        }
                    }

                    return PickerAction::None;
                }

                // Clicking outside the popup cancels.
                if !contains(popup, mouse.column, mouse.row) {
                    return PickerAction::Cancel;
                }
            }

            MouseEventKind::Drag(MouseButton::Left) => {
                if self.scrollbar_drag {
                    if let (Some(metrics), Some(grab)) = (scrollbar_metrics, self.scrollbar_grab) {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.table_state.offset_mut() = target;
                        self.table_state
                            .select(Some(target.min(self.visible.len().saturating_sub(1))));
                        self.selection.set_anchor(self.table_state.selected());
                        return PickerAction::None;
                    }
                }
            }

            MouseEventKind::Up(MouseButton::Left) => {
                self.scrollbar_drag = false;
                self.scrollbar_grab = None;
            }

            MouseEventKind::ScrollDown => {
                if contains(picker_chunks[1], mouse.column, mouse.row) {
                    self.move_selection(1);
                    self.last_click = None;
                }
            }

            MouseEventKind::ScrollUp => {
                if contains(picker_chunks[1], mouse.column, mouse.row) {
                    self.move_selection(-1);
                    self.last_click = None;
                }
            }

            _ => {}
        }

        PickerAction::None
    }

    fn move_selection(&mut self, delta: i32) {
        if self.visible.is_empty() {
            self.table_state.select(None);
            return;
        }

        let cur = self.table_state.selected().unwrap_or(0) as i32;
        let next = (cur + delta).clamp(0, (self.visible.len().saturating_sub(1)) as i32) as usize;
        self.table_state.select(Some(next));
        self.selection.set_anchor(Some(next));
    }

    fn select_range_to(&mut self, idx: usize) {
        let keys: Vec<PathBuf> = self
            .visible
            .iter()
            .filter_map(|vi| self.items.get(vi.item_idx).map(|it| it.path.clone()))
            .collect();
        self.selection.range_select(&keys, idx);
    }

    fn current_item(&self) -> Option<&PickerItem> {
        let sel = self.table_state.selected()?;
        let vi = self.visible.get(sel)?;
        self.items.get(vi.item_idx)
    }

    fn toggle_selected_current(&mut self) {
        // Important: `current_item()` immutably borrows `self`, but selecting/unselecting needs
        // a mutable borrow of `self.selected`. We clone the path first to keep borrow scopes
        // non-overlapping.
        let Some(it) = self.current_item() else {
            return;
        };
        let p = it.path.clone();
        let idx = self.table_state.selected().unwrap_or(0);
        self.selection.toggle(p, idx);
    }

    fn go_up(&mut self) {
        if let Some(parent) = self.cwd.parent().map(Path::to_path_buf) {
            self.cwd = parent;
            self.reload_items();
        }
    }

    fn reload_items(&mut self) {
        let mut items: Vec<PickerItem> = Vec::new();

        if let Ok(rd) = std::fs::read_dir(&self.cwd) {
            for e in rd.flatten() {
                let p = e.path();
                let name = sanitize_label(&e.file_name().to_string_lossy());

                // Note: we use `symlink_metadata` so we can still display entries even
                // if following the link would fail.
                let meta = std::fs::symlink_metadata(&p).ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = if is_dir {
                    None
                } else {
                    meta.as_ref().map(|m| m.len())
                };

                let label = if is_dir {
                    format!("{}/", name)
                } else {
                    name
                };
                items.push(PickerItem {
                    path: p,
                    label,
                    is_dir,
                    size,
                });
            }
        }

        // Stable base ordering when query is empty.
        items.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

        self.items = items;
        self.recompute_visible();
        self.last_click = None;

        if self.visible.is_empty() {
            self.table_state.select(None);
            self.selection.set_anchor(None);
        } else {
            self.table_state.select(Some(0));
            self.selection.set_anchor(Some(0));
        }
    }

    fn recompute_visible(&mut self) {
        let q = self.query.trim();

        if q.is_empty() {
            self.visible = self
                .items
                .iter()
                .enumerate()
                .map(|(item_idx, _)| VisibleItem {
                    item_idx,
                    score: 0,
                    match_indices: Vec::new(),
                })
                .collect();
            return;
        }

        let mut vis: Vec<VisibleItem> = Vec::new();
        for (item_idx, it) in self.items.iter().enumerate() {
            if let Some((score, match_indices)) = subseq_score(&it.label, q) {
                vis.push(VisibleItem {
                    item_idx,
                    score,
                    match_indices,
                });
            }
        }

        // Sort by score descending, then label ascending for stability.
        vis.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| self.items[a.item_idx].label.cmp(&self.items[b.item_idx].label))
        });

        self.visible = vis;

        // Keep the current selection index in range.
        if let Some(sel) = self.table_state.selected() {
            if sel >= self.visible.len() {
                if self.visible.is_empty() {
                    self.table_state.select(None);
                } else {
                    self.table_state.select(Some(self.visible.len() - 1));
                }
            }
        }
    }
}

fn contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x
        && col < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
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

/// Compute a simple fzf-like subsequence score.
///
/// Returns `None` if `query` is not a subsequence of `label`.
///
/// Scoring (intentionally simple):
/// - +10 for each matched character
/// - +15 for each consecutive match (bonus)
/// - -position of first match (prefer earlier)
///
/// Also returns match indices for highlighting.
fn subseq_score(label: &str, query: &str) -> Option<(i64, Vec<usize>)> {
    let label_chars: Vec<char> = label.chars().collect();
    let q_chars: Vec<char> = query.chars().collect();

    if q_chars.is_empty() {
        return Some((0, Vec::new()));
    }

    let mut match_indices: Vec<usize> = Vec::with_capacity(q_chars.len());

    let mut li = 0;
    for qc in q_chars.iter() {
        let mut found = None;
        while li < label_chars.len() {
            if label_chars[li].to_ascii_lowercase() == qc.to_ascii_lowercase() {
                found = Some(li);
                li += 1;
                break;
            }
            li += 1;
        }
        let idx = found?;
        match_indices.push(idx);
    }

    let mut score: i64 = 0;
    score += 10 * match_indices.len() as i64;

    // Consecutive bonus.
    for w in match_indices.windows(2) {
        if w[1] == w[0] + 1 {
            score += 15;
        }
    }

    // Prefer early matches.
    score -= match_indices[0] as i64;

    Some((score, match_indices))
}

fn render_highlighted_label(label: &str, match_indices: &[usize]) -> Line<'static> {
    // NOTE: table cells support rich text via `Line` (which is made of multiple `Span`s).
    // This keeps the UI fzf-like: matched characters are highlighted.
    if match_indices.is_empty() {
        return Line::from(Span::styled(
            label.to_string(),
            Style::default().fg(Color::Gray),
        ));
    }

    let matches: BTreeSet<usize> = match_indices.iter().copied().collect();
    let mut spans: Vec<Span> = Vec::new();

    for (i, ch) in label.chars().enumerate() {
        if matches.contains(&i) {
            spans.push(Span::styled(
                ch.to_string(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(ch.to_string(), Style::default().fg(Color::Gray)));
        }
    }

    Line::from(spans)
}

fn sanitize_label(s: &str) -> String {
    // Filenames can contain control characters (including ESC) that would break
    // terminal rendering. We replace them with a visible placeholder.
    //
    // This is intentionally conservative: even if we can't display the exact name,
    // the UI should remain stable and predictable.
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_control() {
            out.push('�');
        } else {
            out.push(ch);
        }
    }
    out
}

fn format_bytes_short(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    const TB: f64 = GB * 1024.0;

    let n_f = n as f64;
    if n_f < KB {
        format!("{}B", n)
    } else if n_f < MB {
        format!("{:.1}K", n_f / KB)
    } else if n_f < GB {
        format!("{:.1}M", n_f / MB)
    } else if n_f < TB {
        format!("{:.1}G", n_f / GB)
    } else {
        format!("{:.1}T", n_f / TB)
    }
}
