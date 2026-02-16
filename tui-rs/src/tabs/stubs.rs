use crate::app::App;
use crate::file_picker::{FilePicker, PickerAction};
use crate::ipc::IpcClient;
use crate::tabs::{draw_placeholder, Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Style},
    text::{Line, Text},
    widgets::{Block, Borders, Paragraph, Row, Table, TableState},
    Frame,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;

use crate::widgets::{
    compute_scrollbar_metrics, handle_scrollbar_down, handle_scrollbar_drag, hit_test_table_index,
    mouse_in, render_scrollbar, Button, MultiSelectState, ScrollbarDownResult,
};

pub struct BrowseTab;
pub struct DownloadsTab;
pub struct FilesTab {
    entries: Vec<FileEntryRow>,
    table_state: TableState,
    selection: MultiSelectState<String>,
    scrollbar_drag: Option<usize>,
    last_viewport_rows: usize,
    endpoint: String,
    info_rx: Receiver<(u64, String, Result<Value, String>)>,
    info_req_id: u64,
    verify_rx: Receiver<(u64, VerifyMsg)>,
    verify_req_id: u64,
    verify_progress: Option<(usize, usize)>,
    focused_path: Option<String>,
    last_error: Option<String>,
    last_info: Option<Value>,
    last_verify: Option<Value>,
    hovered: FilesHovered,
    picker: FilePicker,
}

#[derive(Debug, Clone)]
enum VerifyMsg {
    Progress { done: usize, total: usize },
    Done { value: Value },
    Error { message: String },
}

#[derive(Debug, Clone)]
struct FileEntryRow {
    typ: String,
    path: String,
    size: Option<u64>,
    chunks: Option<u64>,
    merkle_root: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilesHovered {
    None,
    Refresh,
    Add,
    Verify,
    Remove,
}

impl BrowseTab {
    pub fn new() -> Self {
        Self
    }
}

impl DownloadsTab {
    pub fn new() -> Self {
        Self
    }
}

impl FilesTab {
    pub fn new(endpoint: String) -> Self {
        let mut table_state = TableState::default();
        table_state.select(Some(0));

        let (_tx, rx) = mpsc::channel::<(u64, String, Result<Value, String>)>();
        let (_vtx, vrx) = mpsc::channel::<(u64, VerifyMsg)>();
        Self {
            entries: Vec::new(),
            table_state,
            selection: MultiSelectState::default(),
            scrollbar_drag: None,
            last_viewport_rows: 10,
            endpoint,
            info_rx: rx,
            info_req_id: 0,
            verify_rx: vrx,
            verify_req_id: 0,
            verify_progress: None,
            focused_path: None,
            last_error: None,
            last_info: None,
            last_verify: None,
            hovered: FilesHovered::None,
            picker: FilePicker::new(PathBuf::from(".")),
        }
    }

    pub fn poll_async(&mut self) {
        while let Ok((req_id, path, res)) = self.info_rx.try_recv() {
            if req_id != self.info_req_id {
                continue;
            }
            if self.focused_path.as_deref() != Some(path.as_str()) {
                continue;
            }

            match res {
                Ok(v) => {
                    self.last_info = Some(v);
                    self.last_error = None;
                }
                Err(e) => {
                    self.last_error = Some(e);
                }
            }
        }

        while let Ok((req_id, msg)) = self.verify_rx.try_recv() {
            if req_id != self.verify_req_id {
                continue;
            }

            match msg {
                VerifyMsg::Progress { done, total } => {
                    self.verify_progress = Some((done, total));
                }
                VerifyMsg::Done { value } => {
                    self.verify_progress = None;
                    self.last_verify = Some(value);
                    self.last_error = None;
                }
                VerifyMsg::Error { message } => {
                    self.verify_progress = None;
                    self.last_error = Some(message);
                }
            }
        }
    }

    fn selected_path(&self) -> Option<String> {
        let idx = self.table_state.selected()?;
        self.entries.get(idx).map(|e| e.path.clone())
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("files.list", serde_json::json!({})) {
            Ok(v) => {
                self.entries = parse_files_list(&v);

                // Keep multi-selection stable across refresh by retaining only paths
                // that still exist in the refreshed list.
                let existing: BTreeSet<String> = self.entries.iter().map(|e| e.path.clone()).collect();
                self.selection.retain_existing(&existing);

                if self.entries.is_empty() {
                    self.table_state.select(None);
                } else if self.table_state.selected().is_none() {
                    self.table_state.select(Some(0));
                }
                self.last_error = None;

                self.request_focused_info_if_needed();
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn verify_selected(&mut self, _ipc: &mut IpcClient) {
        let mut paths: Vec<String> = self.selection.selected().iter().cloned().collect();
        if paths.is_empty() {
            if let Some(p) = self.selected_path() {
                paths.push(p);
            }
        }

        if paths.is_empty() {
            return;
        }

        let endpoint = self.endpoint.clone();
        let (tx, rx): (Sender<(u64, VerifyMsg)>, Receiver<(u64, VerifyMsg)>) = mpsc::channel();
        self.verify_rx = rx;

        self.verify_req_id = self.verify_req_id.wrapping_add(1);
        let req_id = self.verify_req_id;

        self.verify_progress = Some((0, paths.len()));
        self.last_error = None;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;
                let total = paths.len();
                let mut ok_count: u64 = 0;
                let mut fail_count: u64 = 0;
                let mut results: Vec<Value> = Vec::new();

                for (i, path) in paths.into_iter().enumerate() {
                    let _ = tx.send((
                        req_id,
                        VerifyMsg::Progress {
                            done: i,
                            total,
                        },
                    ));

                    match c.rpc("files.verify", serde_json::json!({"path": path.clone()})) {
                        Ok(v) => {
                            let valid = v.get("valid").and_then(|x| x.as_bool());
                            match valid {
                                Some(true) => ok_count += 1,
                                Some(false) => fail_count += 1,
                                None => {}
                            }
                            results.push(serde_json::json!({"path": path, "result": v}));
                        }
                        Err(e) => {
                            fail_count += 1;
                            results.push(serde_json::json!({
                                "path": path,
                                "error": e.to_string()
                            }));
                        }
                    }
                }

                let _ = tx.send((
                    req_id,
                    VerifyMsg::Progress {
                        done: total,
                        total,
                    },
                ));

                Ok::<Value, String>(serde_json::json!({
                    "summary": {
                        "ok": ok_count,
                        "failed": fail_count,
                        "total": ok_count + fail_count
                    },
                    "results": results
                }))
            })();

            match res {
                Ok(v) => {
                    let _ = tx.send((req_id, VerifyMsg::Done { value: v }));
                }
                Err(e) => {
                    let _ = tx.send((req_id, VerifyMsg::Error { message: e }));
                }
            }
        });
    }

    pub fn remove_selected(&mut self, ipc: &mut IpcClient) {
        let mut paths: Vec<String> = self.selection.selected().iter().cloned().collect();
        if paths.is_empty() {
            if let Some(p) = self.selected_path() {
                paths.push(p);
            }
        }

        if paths.is_empty() {
            return;
        }

        for path in paths {
            match ipc.rpc("files.remove", serde_json::json!({"path": path})) {
                Ok(_v) => {}
                Err(e) => {
                    self.last_error = Some(e.to_string());
                    return;
                }
            }
        }

        self.last_error = None;
        self.refresh(ipc);
    }

    fn toggle_selected_current(&mut self) {
        let Some(p) = self.selected_path() else {
            return;
        };
        let idx = self.table_state.selected().unwrap_or(0);
        self.selection.toggle(p, idx);
    }

    fn invert_selection(&mut self) {
        let keys: Vec<String> = self.entries.iter().map(|e| e.path.clone()).collect();
        self.selection.invert(&keys);
    }

    fn set_focus(&mut self, idx: Option<usize>) {
        self.table_state.select(idx);
        self.selection.set_anchor(idx);
        self.request_focused_info_if_needed();
    }

    fn select_all(&mut self) {
        let keys: Vec<String> = self.entries.iter().map(|e| e.path.clone()).collect();
        self.selection.select_all(&keys);
    }

    fn clear_selection(&mut self) {
        self.selection.clear();
    }

    fn select_range_to(&mut self, idx: usize) {
        let keys: Vec<String> = self.entries.iter().map(|e| e.path.clone()).collect();
        self.selection.range_select(&keys, idx);
    }

    fn request_focused_info_if_needed(&mut self) {
        let Some(p) = self.selected_path() else {
            self.focused_path = None;
            self.last_info = None;
            return;
        };

        if self.focused_path.as_deref() == Some(p.as_str()) {
            return;
        }
        self.focused_path = Some(p.clone());
        self.last_info = None;

        let endpoint = self.endpoint.clone();
        let (tx, rx): (
            Sender<(u64, String, Result<Value, String>)>,
            Receiver<(u64, String, Result<Value, String>)>,
        ) = mpsc::channel();
        self.info_rx = rx;

        self.info_req_id = self.info_req_id.wrapping_add(1);
        let req_id = self.info_req_id;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;
                c.rpc("files.info", serde_json::json!({"path": p.clone()}))
                    .map_err(|e| e.to_string())
            })();
            let _ = tx.send((req_id, p, res));
        });
    }

    pub fn add_open(&mut self) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        self.picker.open(cwd);
    }

    pub fn add_cancel(&mut self) {
        self.picker.close();
        self.hovered = FilesHovered::None;
    }

    pub fn add_confirm(&mut self, ipc: &mut IpcClient) {
        let mut paths = self.picker.selected_paths();
        if paths.is_empty() {
            if let Some(p) = self.picker.current_path() {
                paths.push(p);
            }
        }

        if paths.is_empty() {
            self.picker.close();
            return;
        }

        match ipc.rpc("files.add", serde_json::json!({"paths": paths})) {
            Ok(_v) => {
                self.last_error = None;
                self.picker.close();
                self.refresh(ipc);
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                self.picker.close();
            }
        }
    }
}

impl Tab for BrowseTab {
    fn id(&self) -> TabId {
        TabId::Browse
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        draw_placeholder(f, area, "Browse");
    }
}

impl Tab for DownloadsTab {
    fn id(&self) -> TabId {
        TabId::Downloads
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        draw_placeholder(f, area, "Downloads");
    }
}

impl Tab for FilesTab {
    fn id(&self) -> TabId {
        TabId::Files
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(10)].as_ref())
            .split(area);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(65), Constraint::Percentage(35)].as_ref())
            .split(chunks[0]);

        let list_area = main[0];
        let details_area = main[1];

        // Cache viewport row count for page navigation.
        // Table content height = list_area height - 2 borders - 1 header row.
        self.last_viewport_rows = list_area
            .height
            .saturating_sub(3)
            .max(1) as usize;

        let header = Row::new(vec![
            "Sel",
            "Type",
            "Size",
            "Chunks",
            "Root",
            "Path",
        ])
        .style(Style::default().fg(Color::Yellow));

        let rows = self.entries.iter().map(|e| {
            let mark = if self.selection.is_selected(&e.path) { "[x]" } else { "[ ]" };
            let size = e.size.map(|s| s.to_string()).unwrap_or_else(|| "".to_string());
            let chunks = e.chunks.map(|c| c.to_string()).unwrap_or_else(|| "".to_string());
            let root = e
                .merkle_root
                .as_deref()
                .map(|s| if s.len() > 12 { s[..12].to_string() } else { s.to_string() })
                .unwrap_or_else(|| "".to_string());

            Row::new(vec![mark.to_string(), e.typ.clone(), size, chunks, root, e.path.clone()])
        });

        let table = Table::new(
            rows,
            [
                Constraint::Length(4),
                Constraint::Length(5),
                Constraint::Length(12),
                Constraint::Length(8),
                Constraint::Length(14),
                Constraint::Min(10),
            ],
        )
        .header(header)
        .block(Block::default().title("Tracked").borders(Borders::ALL))
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        let show_scrollbar = self.entries.len() > self.last_viewport_rows;
        let mut table_area = list_area;
        if show_scrollbar {
            table_area.width = table_area.width.saturating_sub(1);
        }

        f.render_stateful_widget(table, table_area, &mut self.table_state);

        if let Some(metrics) = compute_scrollbar_metrics(list_area, 1, self.entries.len(), self.table_state.offset()) {
            render_scrollbar(f, metrics);
        }

        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(5),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
            ])
            .split(details_area);

        let mut info_lines: Vec<Line> = Vec::new();
        if let Some(e) = &self.last_error {
            info_lines.push(Line::from(format!("Error: {}", e)));
            info_lines.push(Line::from(""));
        }

        if let Some(v) = &self.last_info {
            info_lines.push(Line::from("info:"));
            let s = serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into());
            info_lines.extend(Text::from(s).lines);
        }

        if let Some(v) = &self.last_verify {
            info_lines.push(Line::from(""));
            let ok = v
                .get("summary")
                .and_then(|s| s.get("ok"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let failed = v
                .get("summary")
                .and_then(|s| s.get("failed"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let total = v
                .get("summary")
                .and_then(|s| s.get("total"))
                .and_then(|x| x.as_u64())
                .unwrap_or(ok + failed);

            info_lines.push(Line::from(format!(
                "verify: {} ok, {} failed ({} total)",
                ok, failed, total
            )));

            let s = serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into());
            info_lines.extend(Text::from(s).lines);
        }

        if info_lines.is_empty() {
            info_lines.push(Line::from(
                "Keys: r refresh | a add | tab/space toggle | a/Ctrl+A all | c clear | i invert | v verify | x/Del remove | j/k move",
            ));
        }

        let details = Paragraph::new(Text::from(info_lines))
            .block(Block::default().title("Details").borders(Borders::ALL));
        f.render_widget(details, detail_chunks[0]);

        let refresh_btn = Button {
            label: "Refresh".to_string(),
            enabled: true,
        };
        refresh_btn.draw(f, detail_chunks[1], self.hovered == FilesHovered::Refresh);

        let add_btn = Button {
            label: "Add".to_string(),
            enabled: true,
        };
        add_btn.draw(f, detail_chunks[2], self.hovered == FilesHovered::Add);

        let verify_btn = Button {
            label: "Verify".to_string(),
            enabled: self.table_state.selected().is_some(),
        };
        verify_btn.draw(f, detail_chunks[3], self.hovered == FilesHovered::Verify);

        let remove_btn = Button {
            label: "Remove".to_string(),
            enabled: self.table_state.selected().is_some(),
        };
        remove_btn.draw(f, detail_chunks[4], self.hovered == FilesHovered::Remove);

        let footer = Paragraph::new(
            "Keys: r refresh | a add | tab/space toggle | a/Ctrl+A all | c clear | i invert | v verify | x/Del remove | j/k move",
        )
            .block(Block::default().title("Actions").borders(Borders::ALL));
        f.render_widget(footer, chunks[1]);

        if self.picker.is_open() {
            self.picker.draw(f, area);
        }
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        if self.picker.is_open() {
            return match self.picker.on_key(key) {
                PickerAction::None => UiCommand::None,
                PickerAction::Confirm => UiCommand::FilesAddConfirm,
                PickerAction::Cancel => UiCommand::FilesAddCancel,
            };
        }

        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                };
                if !self.entries.is_empty() {
                    self.set_focus(Some(next));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.entries.is_empty() {
                    self.set_focus(Some(next));
                }
            }
            KeyCode::PageDown | KeyCode::Char('J') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.last_viewport_rows)
                    .min(self.entries.len().saturating_sub(1));
                if !self.entries.is_empty() {
                    self.set_focus(Some(next));
                }
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.last_viewport_rows);
                if !self.entries.is_empty() {
                    self.set_focus(Some(next));
                }
            }
            KeyCode::Tab | KeyCode::Char(' ') => {
                self.toggle_selected_current();
            }
            KeyCode::Char('r') => return UiCommand::Refresh,
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.select_all();
            }
            KeyCode::Char('A') => {
                self.select_all();
            }
            KeyCode::Char('a') => return UiCommand::FilesAddOpen,
            KeyCode::Char('c') => {
                self.clear_selection();
            }
            KeyCode::Char('i') => {
                self.invert_selection();
            }
            KeyCode::Char('v') => return UiCommand::FilesVerifySelected,
            KeyCode::Char('x') => return UiCommand::FilesRemoveSelected,
            KeyCode::Delete => return UiCommand::FilesRemoveSelected,
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        if self.picker.is_open() {
            return match self.picker.on_mouse(mouse, area) {
                PickerAction::None => UiCommand::None,
                PickerAction::Confirm => UiCommand::FilesAddConfirm,
                PickerAction::Cancel => UiCommand::FilesAddCancel,
            };
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(10)].as_ref())
            .split(area);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(65), Constraint::Percentage(35)].as_ref())
            .split(chunks[0]);

        let list_area = main[0];
        let details_area = main[1];

        let list_inner = list_area.inner(Margin {
            vertical: 1,
            horizontal: 1,
        });
        let scrollbar_metrics = compute_scrollbar_metrics(
            list_area,
            1,
            self.entries.len(),
            self.table_state.offset(),
        );

        let detail_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(5),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Length(3),
            ])
            .split(details_area);

        if mouse_in(detail_chunks[1], &mouse) {
            self.hovered = FilesHovered::Refresh;
        } else if mouse_in(detail_chunks[2], &mouse) {
            self.hovered = FilesHovered::Add;
        } else if mouse_in(detail_chunks[3], &mouse) {
            self.hovered = FilesHovered::Verify;
        } else if mouse_in(detail_chunks[4], &mouse) {
            self.hovered = FilesHovered::Remove;
        } else {
            self.hovered = FilesHovered::None;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // Clicking on the scrollbar track jumps.
                if let Some(metrics) = scrollbar_metrics {
                    if crate::widgets::contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.table_state.offset_mut() = offset;
                                self.table_state
                                    .select(Some(offset.min(self.entries.len().saturating_sub(1))));
                                self.selection.set_anchor(self.table_state.selected());
                                self.request_focused_info_if_needed();
                                return UiCommand::None;
                            }
                        }
                    }
                }

                if let Some(idx) = hit_test_table_index(
                    list_area,
                    1,
                    &mouse,
                    self.table_state.offset(),
                    self.entries.len(),
                ) {
                    let is_ctrl = mouse.modifiers.contains(KeyModifiers::CONTROL);
                    let is_shift = mouse.modifiers.contains(KeyModifiers::SHIFT);

                    if is_shift {
                        self.table_state.select(Some(idx));
                        self.select_range_to(idx);
                        self.request_focused_info_if_needed();
                    } else if is_ctrl {
                        self.set_focus(Some(idx));
                        if let Some(p) = self.selected_path() {
                            self.selection.toggle(p, idx);
                        }
                    } else {
                        self.set_focus(Some(idx));

                        // Toggle selection when clicking in the checkbox column.
                        // (Table inner content starts at +1,+1.)
                        let rel_x = mouse
                            .column
                            .saturating_sub(list_inner.x)
                            .saturating_sub(1);
                        if rel_x < 4 {
                            if let Some(p) = self.selected_path() {
                                self.selection.toggle(p, idx);
                            }
                        }
                    }
                }
                if mouse_in(detail_chunks[1], &mouse) {
                    return UiCommand::Refresh;
                }
                if mouse_in(detail_chunks[2], &mouse) {
                    return UiCommand::FilesAddOpen;
                }
                if mouse_in(detail_chunks[3], &mouse) {
                    return UiCommand::FilesVerifySelected;
                }
                if mouse_in(detail_chunks[4], &mouse) {
                    return UiCommand::FilesRemoveSelected;
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(grab) = self.scrollbar_drag {
                    if let Some(metrics) = scrollbar_metrics {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.table_state.offset_mut() = target;
                        self.table_state
                            .select(Some(target.min(self.entries.len().saturating_sub(1))));
                        self.selection.set_anchor(self.table_state.selected());
                        self.request_focused_info_if_needed();
                    }
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.scrollbar_drag = None;
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                    };
                    if !self.entries.is_empty() {
                        self.set_focus(Some(next));
                    }
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => i.saturating_sub(1),
                    };
                    if !self.entries.is_empty() {
                        self.set_focus(Some(next));
                    }
                }
            }
            _ => {}
        }

        UiCommand::None
    }
}

fn parse_files_list(v: &Value) -> Vec<FileEntryRow> {
    let mut out: Vec<FileEntryRow> = Vec::new();

    if let Some(files) = v.get("files").and_then(|x| x.as_array()) {
        for f in files {
            if let Some(path) = f.get("path").and_then(|x| x.as_str()) {
                out.push(FileEntryRow {
                    typ: "f".to_string(),
                    path: path.to_string(),
                    size: f.get("size").and_then(|x| x.as_u64()),
                    chunks: f.get("chunk_count").and_then(|x| x.as_u64()),
                    merkle_root: f
                        .get("merkle_root")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }

    if let Some(dirs) = v.get("dirs").and_then(|x| x.as_array()) {
        for d in dirs {
            if let Some(path) = d.get("path").and_then(|x| x.as_str()) {
                out.push(FileEntryRow {
                    typ: "d".to_string(),
                    path: path.to_string(),
                    size: None,
                    chunks: None,
                    merkle_root: d
                        .get("merkle_root")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }

    out
}
