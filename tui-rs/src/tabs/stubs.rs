use crate::app::App;
use crate::file_picker::{FilePicker, PickerAction};
use crate::ipc::IpcClient;
use crate::tabs::{Tab, TabId, UiCommand};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Gauge, Paragraph, Row, Table, TableState},
    Frame,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Instant;

use crate::widgets::{
    contains,
    compute_scrollbar_metrics, handle_scrollbar_down, handle_scrollbar_drag, hit_test_table_index,
    mouse_in, render_scrollbar, Button, MultiSelectState, ScrollbarDownResult,
};

pub struct BrowseTab {
    endpoint: String,
    topics: Vec<BrowseTopicRow>,
    topics_state: TableState,
    topics_sel: MultiSelectState<String>,
    topics_viewport_rows: usize,

    query: String,
    focus: BrowseFocus,

    results: Vec<BrowseResultRow>,
    cache: BTreeMap<String, Vec<BrowseResultRow>>,
    results_state: TableState,
    results_sel: MultiSelectState<String>,
    results_scrollbar_drag: Option<usize>,
    results_viewport_rows: usize,

    browse_rx: Receiver<(u64, Result<Value, String>)>,
    browse_req_id: u64,
    browse_busy: Option<(String, Instant)>,

    last_error: Option<String>,
    hovered: BrowseHovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowseFocus {
    Topics,
    Search,
    Results,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowseHovered {
    None,
    Refresh,
    Download,
}

#[derive(Debug, Clone)]
struct BrowseTopicRow {
    name: String,
    joined: bool,
    peers: u64,
}

#[derive(Debug, Clone)]
struct BrowseResultRow {
    topic: String,
    name: String,
    merkle_root: String,
    size: Option<u64>,
    chunk_count: Option<u64>,
}
pub struct DownloadsTab {
    entries: Vec<DownloadRow>,
    table_state: TableState,
    selection: MultiSelectState<i64>,
    last_viewport_rows: usize,
    hovered: DownloadsHovered,
    last_error: Option<String>,
    live: BTreeMap<DownloadKey, LiveDownload>,
    add: DownloadsAddState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsHovered {
    None,
    Refresh,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsAddFocus {
    Topic,
    MerkleRoot,
    Destination,
    Start,
    Abort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadsAddHovered {
    None,
    Start,
    Abort,
}

#[derive(Debug, Clone)]
struct DownloadsAddTopicRow {
    name: String,
    peers: u64,
}

#[derive(Debug, Clone)]
struct DownloadsAddState {
    open: bool,
    focus: DownloadsAddFocus,
    topics: Vec<DownloadsAddTopicRow>,
    topics_state: TableState,
    topics_scrollbar_drag: Option<usize>,
    merkle_root: String,
    destination: String,
    hovered: DownloadsAddHovered,
}

#[derive(Debug, Clone)]
struct DownloadRow {
    id: i64,
    topic: String,
    merkle_root: String,
    output_path: String,
    created_at: Option<i64>,
    completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DownloadKey {
    topic: String,
    merkle_root: String,
    output_path: String,
}

#[derive(Debug, Clone)]
struct LiveDownload {
    verified: u64,
    total: u64,
    bytes: u64,
    last_ts: u64,
    last_bytes: u64,
    speed_bps: u64,
    completed: bool,
    error: Option<String>,
}
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
    pub fn new(endpoint: String) -> Self {
        let mut topics_state = TableState::default();
        topics_state.select(Some(0));

        let mut results_state = TableState::default();
        results_state.select(Some(0));

        let (_tx, rx) = mpsc::channel::<(u64, Result<Value, String>)>();
        Self {
            endpoint,
            topics: Vec::new(),
            topics_state,
            topics_sel: MultiSelectState::default(),
            topics_viewport_rows: 10,
            query: String::new(),
            focus: BrowseFocus::Topics,
            results: Vec::new(),
            cache: BTreeMap::new(),
            results_state,
            results_sel: MultiSelectState::default(),
            results_scrollbar_drag: None,
            results_viewport_rows: 10,
            browse_rx: rx,
            browse_req_id: 0,
            browse_busy: None,
            last_error: None,
            hovered: BrowseHovered::None,
        }
    }

    pub fn poll_async(&mut self) {
        while let Ok((req_id, res)) = self.browse_rx.try_recv() {
            if req_id != self.browse_req_id {
                continue;
            }

            self.browse_busy = None;
            match res {
                Ok(v) => {
                    self.cache = parse_browse_cache(&v);
                    self.rebuild_results_from_cache();
                    self.last_error = None;
                }
                Err(e) => {
                    self.last_error = Some(e);
                }
            }
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("network.overview", serde_json::json!({})) {
            Ok(v) => {
                let topics = v
                    .get("topics")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default();
                // Only show currently connected topics.
                self.topics = topics
                    .iter()
                    .filter_map(|t| {
                        let name = t.get("name")?.as_str()?.to_string();
                        let joined = t.get("joined").and_then(|x| x.as_bool()).unwrap_or(false);
                        let peers = t.get("peers").and_then(|x| x.as_u64()).unwrap_or(0);
                        if peers == 0 {
                            return None;
                        }
                        Some(BrowseTopicRow { name, joined, peers })
                    })
                    .collect();

                let existing: BTreeSet<String> =
                    self.topics.iter().map(|t| t.name.clone()).collect();
                self.topics_sel.retain_existing(&existing);

                // Select all connected topics by default (only when the user has not made a
                // selection yet).
                if self.topics_sel.selected().is_empty() {
                    let keys: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
                    self.topics_sel.select_all(&keys);
                    self.topics_sel.set_anchor(self.topics_state.selected());
                }

                if self.topics.is_empty() {
                    self.topics_state.select(None);
                } else if self.topics_state.selected().is_none() {
                    self.topics_state.select(Some(0));
                }
                self.last_error = None;

                // Rebuild visible results if topic selection changed due to retain/default.
                self.rebuild_results_from_cache();
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn browse_prefetch(&mut self) {
        self.browse_reload_all_connected();
    }

    pub fn browse_refresh(&mut self, _ipc: &mut IpcClient) {
        self.browse_reload_all_connected();
    }

    fn browse_reload_all_connected(&mut self) {
        // Async: browse all connected topics and cache results per topic.
        let topics: Vec<String> = self.topics.iter().map(|t| t.name.clone()).collect();
        if topics.is_empty() {
            self.last_error = Some("no connected topics".to_string());
            return;
        }

        let endpoint = self.endpoint.clone();
        let (tx, rx): (Sender<(u64, Result<Value, String>)>, Receiver<(u64, Result<Value, String>)>) =
            mpsc::channel();
        self.browse_rx = rx;

        self.browse_req_id = self.browse_req_id.wrapping_add(1);
        let req_id = self.browse_req_id;
        self.browse_busy = Some((format!("browsing {} topic(s)", topics.len()), Instant::now()));
        self.last_error = None;

        thread::spawn(move || {
            let res = (|| {
                let mut c = crate::ipc::IpcClient::connect(endpoint).map_err(|e| e.to_string())?;

                let mut out: BTreeMap<String, Vec<Value>> = BTreeMap::new();
                for name in topics {
                    match c.rpc(
                        "browse.topic",
                        serde_json::json!({"name": name, "timeout": 5000}),
                    ) {
                        Ok(v) => {
                            if let Some(arr) = v.as_array() {
                                out.insert(name, arr.iter().cloned().collect());
                            }
                        }
                        Err(e) => {
                            let _ = e;
                        }
                    }
                }

                Ok::<Value, String>(serde_json::to_value(out).map_err(|e| e.to_string())?)
            })();
            let _ = tx.send((req_id, res));
        });
    }

    pub fn download_selected(&mut self, _ipc: &mut IpcClient) {
        // Placeholder for the upcoming download popup flow.
        // For now we just surface an error if nothing selected.
        if self.results_sel.selected().is_empty() {
            self.last_error = Some("no browse items selected".to_string());
        } else {
            self.last_error = Some("download popup not implemented yet".to_string());
        }
    }

    fn page_down(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let cur = self.topics_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.topics_viewport_rows)
                    .min(self.topics.len().saturating_sub(1));
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let cur = self.results_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.results_viewport_rows)
                    .min(self.results.len().saturating_sub(1));
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn page_up(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let cur = self.topics_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.topics_viewport_rows);
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let cur = self.results_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.results_viewport_rows);
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn rebuild_results_from_cache(&mut self) {
        let selected_topics: BTreeSet<String> = self.topics_sel.selected().iter().cloned().collect();
        let mut out: Vec<BrowseResultRow> = Vec::new();
        for (topic, rows) in &self.cache {
            if !selected_topics.contains(topic) {
                continue;
            }
            out.extend(rows.iter().cloned());
        }

        // Dedup across topics by merkle root.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        out.retain(|r| {
            if r.merkle_root.is_empty() || seen.contains(&r.merkle_root) {
                return false;
            }
            seen.insert(r.merkle_root.clone());
            true
        });

        let q = self.query.trim().to_lowercase();
        if !q.is_empty() {
            out.retain(|r| {
                r.name.to_lowercase().contains(&q)
                    || r.topic.to_lowercase().contains(&q)
                    || r.merkle_root.to_lowercase().contains(&q)
            });
        }

        self.results = out;

        if self.results.is_empty() {
            self.results_state.select(None);
        } else if self.results_state.selected().is_none() {
            self.results_state.select(Some(0));
        } else if let Some(sel) = self.results_state.selected() {
            self.results_state.select(Some(sel.min(self.results.len().saturating_sub(1))));
        }

        let existing: BTreeSet<String> = self.results.iter().map(|r| r.merkle_root.clone()).collect();
        self.results_sel.retain_existing(&existing);
    }
}

impl DownloadsTab {
    pub fn new() -> Self {
        let mut table_state = TableState::default();
        table_state.select(Some(0));

        let mut topics_state = TableState::default();
        topics_state.select(Some(0));
        Self {
            entries: Vec::new(),
            table_state,
            selection: MultiSelectState::default(),
            last_viewport_rows: 10,
            hovered: DownloadsHovered::None,
            last_error: None,
            live: BTreeMap::new(),
            add: DownloadsAddState {
                open: false,
                focus: DownloadsAddFocus::Topic,
                topics: Vec::new(),
                topics_state,
                topics_scrollbar_drag: None,
                merkle_root: String::new(),
                destination: String::new(),
                hovered: DownloadsAddHovered::None,
            },
        }
    }

    pub fn is_modal_open(&self) -> bool {
        self.add.open
    }

    pub fn add_open(&mut self, ipc: &mut IpcClient) {
        self.add.open = true;
        self.add.focus = DownloadsAddFocus::Topic;
        self.add.hovered = DownloadsAddHovered::None;
        self.add.topics_scrollbar_drag = None;
        self.add.merkle_root.clear();
        self.add.destination.clear();

        self.add.topics_state = TableState::default();
        self.add.topics_state.select(Some(0));

        self.add.topics = fetch_topics(ipc);
        if self.add.topics.is_empty() {
            self.add.topics_state.select(None);
        }
        self.last_error = None;
    }

    pub fn add_cancel(&mut self) {
        self.add.open = false;
    }

    pub fn add_confirm(&mut self, ipc: &mut IpcClient) {
        if !self.add.open {
            return;
        }
        let Some(topic) = self
            .add
            .topics_state
            .selected()
            .and_then(|i| self.add.topics.get(i))
            .map(|t| t.name.clone())
        else {
            self.last_error = Some("topic required".to_string());
            return;
        };

        let root = self.add.merkle_root.trim().to_string();
        if root.is_empty() {
            self.last_error = Some("merkle root required".to_string());
            return;
        }
        let dest = self.add.destination.trim().to_string();
        if dest.is_empty() {
            self.last_error = Some("destination required".to_string());
            return;
        }

        let params = serde_json::json!({
            "topic": topic,
            "merkleRoot": root,
            "outputPath": dest,
        });
        match ipc.rpc("downloads.start", params) {
            Ok(_) => {
                self.add.open = false;
                self.last_error = None;
                self.refresh(ipc);
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
    }

    pub fn on_downloads_progress(&mut self, v: Value) {
        let topic = v
            .get("topic")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let merkle_root = v
            .get("merkleRoot")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let output_path = v
            .get("outputPath")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if topic.is_empty() || merkle_root.is_empty() || output_path.is_empty() {
            return;
        }

        let verified = v.get("verified").and_then(|x| x.as_u64()).unwrap_or(0);
        let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
        let bytes = v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0);
        let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);

        let key = DownloadKey {
            topic,
            merkle_root,
            output_path,
        };

        let entry = self.live.entry(key).or_insert(LiveDownload {
            verified,
            total,
            bytes,
            last_ts: ts,
            last_bytes: bytes,
            speed_bps: 0,
            completed: false,
            error: None,
        });

        let dt_ms = ts.saturating_sub(entry.last_ts).max(1);
        let db = bytes.saturating_sub(entry.last_bytes);
        let speed = (db.saturating_mul(1000)).saturating_div(dt_ms);

        entry.verified = verified;
        entry.total = total;
        entry.bytes = bytes;
        entry.last_ts = ts;
        entry.last_bytes = bytes;
        entry.speed_bps = speed;
        entry.completed = false;
        entry.error = None;
    }

    pub fn on_downloads_complete(&mut self, v: Value) {
        if let Some(k) = parse_download_key(&v) {
            let e = self.live.entry(k).or_insert(LiveDownload {
                verified: 0,
                total: 0,
                bytes: 0,
                last_ts: now_ms(),
                last_bytes: 0,
                speed_bps: 0,
                completed: true,
                error: None,
            });
            e.completed = true;
            e.error = None;
            e.speed_bps = 0;
            e.last_ts = now_ms();
        }
    }

    pub fn on_downloads_error(&mut self, v: Value) {
        if let Some(k) = parse_download_key(&v) {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("error")
                .to_string();
            let e = self.live.entry(k).or_insert(LiveDownload {
                verified: 0,
                total: 0,
                bytes: 0,
                last_ts: now_ms(),
                last_bytes: 0,
                speed_bps: 0,
                completed: false,
                error: Some(msg.clone()),
            });
            e.completed = false;
            e.error = Some(msg);
            e.speed_bps = 0;
            e.last_ts = now_ms();
        }
    }

    pub fn refresh(&mut self, ipc: &mut IpcClient) {
        match ipc.rpc("downloads.list", serde_json::json!({})) {
            Ok(v) => {
                let arr = v.as_array().cloned().unwrap_or_default();
                self.entries = arr
                    .iter()
                    .filter_map(|it| {
                        Some(DownloadRow {
                            id: it.get("id")?.as_i64()?,
                            topic: it
                                .get("topic_name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            merkle_root: it
                                .get("merkle_root")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            output_path: it
                                .get("output_path")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            created_at: it.get("created_at").and_then(|x| x.as_i64()),
                            completed_at: it.get("completed_at").and_then(|x| x.as_i64()),
                        })
                    })
                    .collect();

                if self.entries.is_empty() {
                    self.table_state.select(None);
                } else if self.table_state.selected().is_none() {
                    self.table_state.select(Some(0));
                }

                let existing: BTreeSet<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.retain_existing(&existing);

                // Best-effort: clear live entries that no longer map to any row.
                let existing_live: BTreeSet<DownloadKey> = self
                    .entries
                    .iter()
                    .map(|e| DownloadKey {
                        topic: e.topic.clone(),
                        merkle_root: e.merkle_root.clone(),
                        output_path: e.output_path.clone(),
                    })
                    .collect();
                self.live.retain(|k, _| existing_live.contains(k));
                self.last_error = None;
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
            }
        }
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
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        // Search bar
        let search_style = if self.focus == BrowseFocus::Search {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let search = Paragraph::new(Line::from(self.query.clone()))
            .style(search_style)
            .block(Block::default().title("Search (/)").borders(Borders::ALL));
        f.render_widget(search, chunks[0]);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(35), Constraint::Percentage(65)].as_ref())
            .split(chunks[1]);

        // Topics table
        self.topics_viewport_rows = main[0].height.saturating_sub(3).max(1) as usize;
        let topic_header = Row::new(vec!["Sel", "Topic", "Joined", "Peers"])
            .style(Style::default().fg(Color::Yellow));
        let topic_rows = self.topics.iter().map(|t| {
            let mark = if self.topics_sel.is_selected(&t.name) {
                "[x]"
            } else {
                "[ ]"
            };
            let joined = if t.joined { "yes" } else { "no" };
            Row::new(vec![mark.to_string(), t.name.clone(), joined.to_string(), t.peers.to_string()])
        });
        let topic_table_style = if self.focus == BrowseFocus::Topics {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let topics_table = Table::new(
            topic_rows,
            [
                Constraint::Length(4),
                Constraint::Min(10),
                Constraint::Length(6),
                Constraint::Length(6),
            ],
        )
        .header(topic_header)
        .block(
            Block::default()
                .title("Topics")
                .borders(Borders::ALL)
                .border_style(topic_table_style),
        )
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));
        f.render_stateful_widget(topics_table, main[0], &mut self.topics_state);

        // Results table
        self.results_viewport_rows = main[1].height.saturating_sub(2).max(1) as usize;
        let results_header = Row::new(vec!["Sel", "Topic", "Name", "Size", "Chunks", "Root"])
            .style(Style::default().fg(Color::Yellow));
        let result_rows = self.results.iter().map(|r| {
            let mark = if self.results_sel.is_selected(&r.merkle_root) {
                "[x]"
            } else {
                "[ ]"
            };
            let size = r.size.map(|s| s.to_string()).unwrap_or_else(|| "".to_string());
            let chunks = r
                .chunk_count
                .map(|c| c.to_string())
                .unwrap_or_else(|| "".to_string());
            let root = if r.merkle_root.len() > 12 {
                r.merkle_root[..12].to_string()
            } else {
                r.merkle_root.clone()
            };
            Row::new(vec![
                mark.to_string(),
                r.topic.clone(),
                r.name.clone(),
                size,
                chunks,
                root,
            ])
        });
        let results_table_style = if self.focus == BrowseFocus::Results {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let results_table = Table::new(
            result_rows,
            [
                Constraint::Length(4),
                Constraint::Length(10),
                Constraint::Min(10),
                Constraint::Length(12),
                Constraint::Length(8),
                Constraint::Length(14),
            ],
        )
        .header(results_header)
        .block(
            Block::default()
                .title("Public content")
                .borders(Borders::ALL)
                .border_style(results_table_style),
        )
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        let show_scrollbar = self.results.len() > self.results_viewport_rows;
        let mut results_area = main[1];
        if show_scrollbar {
            results_area.width = results_area.width.saturating_sub(1);
        }
        f.render_stateful_widget(results_table, results_area, &mut self.results_state);
        if let Some(metrics) = compute_scrollbar_metrics(main[1], 1, self.results.len(), self.results_state.offset()) {
            render_scrollbar(f, metrics);
        }

        // Footer actions
        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(14)].as_ref())
            .split(chunks[2]);

        let mut footer_lines: Vec<Line> = vec![Line::from(
            "Keys: / focus search | Tab toggle | Shift-click range | Ctrl-click toggle | r browse | Enter download | PgUp/PgDn",
        )];
        if let Some((msg, started)) = &self.browse_busy {
            let secs = started.elapsed().as_secs_f32();
            footer_lines.push(Line::from(format!("Busy: {} ({:.1}s)", msg, secs)));
        }
        if let Some(e) = &self.last_error {
            footer_lines.push(Line::from(format!("Error: {}", e)));
        }
        let footer = Paragraph::new(Text::from(footer_lines))
            .block(Block::default().title("Browse").borders(Borders::ALL));
        f.render_widget(footer, footer_chunks[0]);

        let refresh_btn = Button {
            label: "Refresh".to_string(),
            enabled: true,
        };
        refresh_btn.draw(f, footer_chunks[1], self.hovered == BrowseHovered::Refresh);

        let download_btn = Button {
            label: "Download".to_string(),
            enabled: !self.results_sel.selected().is_empty() || self.results_state.selected().is_some(),
        };
        download_btn.draw(f, footer_chunks[2], self.hovered == BrowseHovered::Download);
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        match key.code {
            KeyCode::Char('/') => {
                self.focus = BrowseFocus::Search;
            }
            KeyCode::Left | KeyCode::Char('h') => {
                if self.focus != BrowseFocus::Search {
                    self.focus = BrowseFocus::Topics;
                }
            }
            KeyCode::Right | KeyCode::Char('l') => {
                if self.focus != BrowseFocus::Search {
                    self.focus = BrowseFocus::Results;
                }
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.nav_down();
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.nav_up();
            }
            KeyCode::PageDown | KeyCode::Char('J') => {
                self.page_down();
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                self.page_up();
            }
            KeyCode::Esc => {
                if self.focus == BrowseFocus::Search && !self.query.is_empty() {
                    self.query.clear();
                } else {
                    self.focus = BrowseFocus::Results;
                }
            }
            KeyCode::Tab | KeyCode::Char(' ') => {
                match self.focus {
                    BrowseFocus::Topics => {
                        self.toggle_topic_current();
                    }
                    BrowseFocus::Results => {
                        self.toggle_result_current();
                    }
                    BrowseFocus::Search => {}
                }
            }
            KeyCode::Char('r') => return UiCommand::BrowseRefresh,
            KeyCode::Enter => return UiCommand::BrowseDownloadSelected,

            KeyCode::Backspace => {
                if self.focus == BrowseFocus::Search {
                    self.query.pop();
                    self.rebuild_results_from_cache();
                }
            }
            KeyCode::Char(c) => {
                if self.focus == BrowseFocus::Search && !c.is_control() {
                    self.query.push(c);
                    self.rebuild_results_from_cache();
                }
            }
            _ => {}
        }

        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);
        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(35), Constraint::Percentage(65)].as_ref())
            .split(chunks[1]);

        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(14)].as_ref())
            .split(chunks[2]);

        let topics_area = main[0];
        let results_area = main[1];

        if mouse_in(footer_chunks[1], &mouse) {
            self.hovered = BrowseHovered::Refresh;
        } else if mouse_in(footer_chunks[2], &mouse) {
            self.hovered = BrowseHovered::Download;
        } else {
            self.hovered = BrowseHovered::None;
        }

        let scrollbar_metrics = compute_scrollbar_metrics(
            results_area,
            1,
            self.results.len(),
            self.results_state.offset(),
        );

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if mouse_in(chunks[0], &mouse) {
                    self.focus = BrowseFocus::Search;
                    return UiCommand::None;
                }

                if mouse_in(footer_chunks[1], &mouse) {
                    return UiCommand::BrowseRefresh;
                }
                if mouse_in(footer_chunks[2], &mouse) {
                    return UiCommand::BrowseDownloadSelected;
                }

                if let Some(idx) = hit_test_table_index(
                    topics_area,
                    1,
                    &mouse,
                    self.topics_state.offset(),
                    self.topics.len(),
                ) {
                    self.focus = BrowseFocus::Topics;
                    self.topics_state.select(Some(idx));
                    self.topics_sel.set_anchor(Some(idx));

                    // Toggle when clicking in checkbox column.
                    let inner = topics_area.inner(Margin { vertical: 1, horizontal: 1 });
                    let rel_x = mouse.column.saturating_sub(inner.x);
                    if rel_x < 4 {
                        self.toggle_topic_current();
                    }
                    return UiCommand::None;
                }

                // Scrollbar interactions.
                if let Some(metrics) = scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.results_scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.results_state.offset_mut() = offset;
                                self.results_state.select(Some(
                                    offset.min(self.results.len().saturating_sub(1)),
                                ));
                                self.results_sel.set_anchor(self.results_state.selected());
                                return UiCommand::None;
                            }
                        }
                    }
                }

                if let Some(idx) = hit_test_table_index(
                    results_area,
                    1,
                    &mouse,
                    self.results_state.offset(),
                    self.results.len(),
                ) {
                    self.focus = BrowseFocus::Results;
                    let is_ctrl = mouse.modifiers.contains(KeyModifiers::CONTROL);
                    let is_shift = mouse.modifiers.contains(KeyModifiers::SHIFT);

                    if is_shift {
                        self.results_state.select(Some(idx));
                        self.select_result_range_to(idx);
                    } else if is_ctrl {
                        self.results_state.select(Some(idx));
                        self.results_sel.set_anchor(Some(idx));
                        self.toggle_result_current();
                    } else {
                        self.results_state.select(Some(idx));
                        self.results_sel.set_anchor(Some(idx));

                        let inner = results_area.inner(Margin { vertical: 1, horizontal: 1 });
                        let rel_x = mouse.column.saturating_sub(inner.x);
                        if rel_x < 4 {
                            self.toggle_result_current();
                        }
                    }
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(grab) = self.results_scrollbar_drag {
                    if let Some(metrics) = scrollbar_metrics {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.results_state.offset_mut() = target;
                        self.results_state.select(Some(
                            target.min(self.results.len().saturating_sub(1)),
                        ));
                        self.results_sel.set_anchor(self.results_state.selected());
                    }
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.results_scrollbar_drag = None;
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(results_area, &mouse) {
                    self.focus = BrowseFocus::Results;
                    self.nav_down();
                } else if mouse_in(topics_area, &mouse) {
                    self.focus = BrowseFocus::Topics;
                    self.nav_down();
                }
            }
            MouseEventKind::ScrollUp => {
                if mouse_in(results_area, &mouse) {
                    self.focus = BrowseFocus::Results;
                    self.nav_up();
                } else if mouse_in(topics_area, &mouse) {
                    self.focus = BrowseFocus::Topics;
                    self.nav_up();
                }
            }
            _ => {}
        }

        UiCommand::None
    }
}

impl DownloadsTab {
    fn draw_add_modal(&mut self, f: &mut Frame, area: Rect) {
        use ratatui::widgets::Clear;

        let popup = centered_rect(80, 80, area);
        f.render_widget(Clear, popup);
        f.render_widget(
            Block::default().title("Add download").borders(Borders::ALL),
            popup,
        );

        let inner = popup.inner(Margin { vertical: 1, horizontal: 1 });
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints(
                [
                    Constraint::Min(6),
                    Constraint::Length(3),
                    Constraint::Length(3),
                    Constraint::Length(3),
                ]
                .as_ref(),
            )
            .split(inner);

        let topic_border = if self.add.focus == DownloadsAddFocus::Topic {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let header = Row::new(vec!["Topic", "Peers"]).style(Style::default().fg(Color::Yellow));
        let rows = self.add.topics.iter().map(|t| {
            Row::new(vec![t.name.clone(), t.peers.to_string()])
        });
        let show_scrollbar = self.add.topics.len() > chunks[0].height.saturating_sub(3).max(1) as usize;
        let mut topics_area = chunks[0];
        if show_scrollbar {
            topics_area.width = topics_area.width.saturating_sub(1);
        }

        let table = Table::new(rows, [Constraint::Min(10), Constraint::Length(6)])
            .header(header)
            .block(
                Block::default()
                    .title("Topic")
                    .borders(Borders::ALL)
                    .border_style(topic_border),
            )
            .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow))
            .style(Style::default());
        f.render_stateful_widget(table, topics_area, &mut self.add.topics_state);

        if let Some(metrics) = compute_scrollbar_metrics(chunks[0], 1, self.add.topics.len(), self.add.topics_state.offset()) {
            render_scrollbar(f, metrics);
        }

        let mr_border = if self.add.focus == DownloadsAddFocus::MerkleRoot {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let mr = Paragraph::new(Line::from(self.add.merkle_root.clone()))
            .block(
                Block::default()
                    .title("Merkle root")
                    .borders(Borders::ALL)
                    .border_style(mr_border),
            );
        f.render_widget(mr, chunks[1]);

        let dst_border = if self.add.focus == DownloadsAddFocus::Destination {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default()
        };
        let dst = Paragraph::new(Line::from(self.add.destination.clone()))
            .block(
                Block::default()
                    .title("Destination path")
                    .borders(Borders::ALL)
                    .border_style(dst_border),
            );
        f.render_widget(dst, chunks[2]);

        let btns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(12), Constraint::Length(12), Constraint::Min(10)].as_ref())
            .split(chunks[3]);

        let start_btn = Button {
            label: "Start".to_string(),
            enabled: true,
        };
        start_btn.draw(f, btns[0], self.add.hovered == DownloadsAddHovered::Start);

        let abort_btn = Button {
            label: "Abort".to_string(),
            enabled: true,
        };
        abort_btn.draw(f, btns[1], self.add.hovered == DownloadsAddHovered::Abort);

        let hint = Paragraph::new(Text::from(vec![
            Line::from("Tab/Shift+Tab switch fields | Enter confirm | Esc abort"),
        ]))
        .block(Block::default().borders(Borders::ALL));
        f.render_widget(hint, btns[2]);
    }
}

fn fetch_topics(ipc: &mut IpcClient) -> Vec<DownloadsAddTopicRow> {
    let mut out: Vec<DownloadsAddTopicRow> = Vec::new();
    let Ok(v) = ipc.rpc("topic.list", serde_json::json!({})) else {
        return out;
    };
    let Some(arr) = v.as_array() else {
        return out;
    };
    for t in arr {
        let name = t.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let peers = t.get("peers").and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(DownloadsAddTopicRow { name, peers });
    }
    out
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

    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage((100 - percent_x) / 2),
                Constraint::Percentage(percent_x),
                Constraint::Percentage((100 - percent_x) / 2),
            ]
            .as_ref(),
        )
        .split(popup_layout[1]);

    horizontal[1]
}

impl BrowseTab {
    fn toggle_topic_current(&mut self) {
        let Some(idx) = self.topics_state.selected() else {
            return;
        };
        let Some(t) = self.topics.get(idx) else {
            return;
        };
        self.topics_sel.toggle(t.name.clone(), idx);
        self.rebuild_results_from_cache();
    }

    fn toggle_result_current(&mut self) {
        let Some(idx) = self.results_state.selected() else {
            return;
        };
        let Some(r) = self.results.get(idx) else {
            return;
        };
        self.results_sel.toggle(r.merkle_root.clone(), idx);
    }

    fn select_result_range_to(&mut self, idx: usize) {
        let keys: Vec<String> = self.results.iter().map(|r| r.merkle_root.clone()).collect();
        self.results_sel.range_select(&keys, idx);
    }

    fn nav_down(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let next = match self.topics_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.topics.len().saturating_sub(1)),
                };
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let next = match self.results_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.results.len().saturating_sub(1)),
                };
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }

    fn nav_up(&mut self) {
        match self.focus {
            BrowseFocus::Topics => {
                let next = match self.topics_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.topics.is_empty() {
                    self.topics_state.select(Some(next));
                    self.topics_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Results => {
                let next = match self.results_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.results.is_empty() {
                    self.results_state.select(Some(next));
                    self.results_sel.set_anchor(Some(next));
                }
            }
            BrowseFocus::Search => {}
        }
    }
}

fn parse_browse_results(v: &Value) -> Vec<BrowseResultRow> {
    let arr = v.as_array().cloned().unwrap_or_default();
    arr.iter()
        .filter_map(|it| {
            Some(BrowseResultRow {
                topic: it
                    .get("topic")
                    .and_then(|x| x.as_str())
                    .unwrap_or("?")
                    .to_string(),
                name: it
                    .get("name")
                    .and_then(|x| x.as_str())
                    .or_else(|| it.get("path").and_then(|x| x.as_str()))
                    .unwrap_or("")
                    .to_string(),
                merkle_root: it
                    .get("merkleRoot")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                size: it.get("size").and_then(|x| x.as_u64()),
                chunk_count: it.get("chunkCount").and_then(|x| x.as_u64()),
            })
        })
        .filter(|r| !r.merkle_root.is_empty())
        .collect()
}

fn parse_browse_cache(v: &Value) -> BTreeMap<String, Vec<BrowseResultRow>> {
    let mut out: BTreeMap<String, Vec<BrowseResultRow>> = BTreeMap::new();

    let Some(obj) = v.as_object() else {
        return out;
    };

    for (topic, val) in obj {
        let arr = val.as_array().cloned().unwrap_or_default();
        let rows: Vec<BrowseResultRow> = arr
            .iter()
            .filter_map(|it| {
                Some(BrowseResultRow {
                    topic: topic.clone(),
                    name: it
                        .get("name")
                        .and_then(|x| x.as_str())
                        .or_else(|| it.get("path").and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string(),
                    merkle_root: it
                        .get("merkleRoot")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    size: it.get("size").and_then(|x| x.as_u64()),
                    chunk_count: it.get("chunkCount").and_then(|x| x.as_u64()),
                })
            })
            .filter(|r| !r.merkle_root.is_empty())
            .collect();
        out.insert(topic.clone(), rows);
    }

    out
}

impl Tab for DownloadsTab {
    fn id(&self) -> TabId {
        TabId::Downloads
    }

    fn draw(&mut self, f: &mut Frame, area: Rect, _app: &mut App) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        let list_area = chunks[0];
        let footer_area = chunks[1];

        self.last_viewport_rows = list_area.height.saturating_sub(3).max(1) as usize;

        let header = Row::new(vec![
            "Sel",
            "Topic",
            "Root",
            "Progress",
            "Speed",
            "Output",
            "Done",
        ])
        .style(Style::default().fg(Color::Yellow));

        let now = now_ms();
        let rows = self.entries.iter().map(|e| {
            let mark = if self.selection.is_selected(&e.id) { "[x]" } else { "[ ]" };
            let root = if e.merkle_root.len() > 12 {
                e.merkle_root[..12].to_string()
            } else {
                e.merkle_root.clone()
            };
            let done = if e.completed_at.is_some() { "yes" } else { "" };

            let lk = DownloadKey {
                topic: e.topic.clone(),
                merkle_root: e.merkle_root.clone(),
                output_path: e.output_path.clone(),
            };
            let mut status = "".to_string();
            let (speed, row_style) = if e.completed_at.is_some() {
                status = "complete".to_string();
                ("".to_string(), Style::default())
            } else if let Some(l) = self.live.get(&lk) {
                if l.error.is_some() {
                    status = "error".to_string();
                    ("".to_string(), Style::default())
                } else if l.completed {
                    status = "complete".to_string();
                    ("".to_string(), Style::default())
                } else {
                    let stalled = now.saturating_sub(l.last_ts) > 3000;
                    status = if stalled { "paused".to_string() } else { "downloading".to_string() };
                    let sp = if stalled { "".to_string() } else { format_bytes_per_sec(l.speed_bps) };
                    (sp, Style::default())
                }
            } else {
                status = "queued".to_string();
                ("".to_string(), Style::default())
            };

            Row::new(vec![
                mark.to_string(),
                e.topic.clone(),
                root,
                "".to_string(),
                speed,
                status,
                e.output_path.clone(),
                done.to_string(),
            ])
            .style(row_style)
        });

        let constraints = [
            Constraint::Length(4),
            Constraint::Length(12),
            Constraint::Length(14),
            Constraint::Length(18),
            Constraint::Length(10),
            Constraint::Length(12),
            Constraint::Min(10),
            Constraint::Length(6),
        ];

        let table = Table::new(
            rows,
            constraints,
        )
        .header(header)
        .block(Block::default().title("Downloads").borders(Borders::ALL))
        .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));

        f.render_stateful_widget(table, list_area, &mut self.table_state);

        // Overlay gauges in the Progress column.
        // (Gauge is a widget; Table cells are text only.)
        let inner = list_area.inner(Margin { vertical: 1, horizontal: 1 });
        if inner.height >= 2 && inner.width >= 2 {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(constraints)
                .split(inner);
            let progress_col = cols.get(3).cloned().unwrap_or(Rect::default());

            // 1 header row, rest content
            let viewport_rows = inner.height.saturating_sub(1).max(1) as usize;
            let offset = self.table_state.offset();

            for (rel, row_idx) in (offset..self.entries.len()).take(viewport_rows).enumerate() {
                let Some(e) = self.entries.get(row_idx) else { continue; };
                let lk = DownloadKey {
                    topic: e.topic.clone(),
                    merkle_root: e.merkle_root.clone(),
                    output_path: e.output_path.clone(),
                };

                let (pct, label, color) = if e.completed_at.is_some() {
                    (100, "Complete".to_string(), Color::Green)
                } else if let Some(l) = self.live.get(&lk) {
                    if l.error.is_some() {
                        (progress_percent(l.verified, l.total), "Verification error".to_string(), Color::Red)
                    } else if l.completed {
                        (100, "Complete".to_string(), Color::Green)
                    } else {
                        let stalled = now.saturating_sub(l.last_ts) > 3000;
                        if stalled {
                            (progress_percent(l.verified, l.total), "Paused".to_string(), Color::DarkGray)
                        } else {
                            (progress_percent(l.verified, l.total), "Downloading".to_string(), Color::White)
                        }
                    }
                } else {
                    (0, "Queued".to_string(), Color::Gray)
                };

                let y = progress_col.y.saturating_add(1).saturating_add(rel as u16);
                if y >= progress_col.y.saturating_add(progress_col.height) {
                    break;
                }

                let gauge_area = Rect {
                    x: progress_col.x,
                    y,
                    width: progress_col.width,
                    height: 1,
                };

                if gauge_area.width >= 3 {
                    let ratio = (pct.min(100) as f64) / 100.0;
                    let g = Gauge::default()
                        .gauge_style(Style::default().fg(color).bg(Color::Black))
                        .ratio(ratio)
                        .label(Span::raw(label));
                    f.render_widget(g, gauge_area);
                }
            }
        }

        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(12)].as_ref())
            .split(footer_area);

        let mut footer_lines: Vec<Line> = vec![Line::from(
            "Keys: n new | r refresh | R resume | tab/space toggle | A/Ctrl+A all | c clear | j/k move | PgUp/PgDn",
        )];
        if let Some(e) = &self.last_error {
            footer_lines.push(Line::from(format!("Error: {}", e)));
        }

        let footer = Paragraph::new(Text::from(footer_lines))
            .block(Block::default().title("Actions").borders(Borders::ALL));
        f.render_widget(footer, footer_chunks[0]);

        let refresh_btn = Button {
            label: "Refresh".to_string(),
            enabled: true,
        };
        refresh_btn.draw(f, footer_chunks[1], self.hovered == DownloadsHovered::Refresh);

        let resume_btn = Button {
            label: "Resume".to_string(),
            enabled: true,
        };
        resume_btn.draw(f, footer_chunks[2], self.hovered == DownloadsHovered::Resume);

        if self.add.open {
            self.draw_add_modal(f, area);
        }
    }

    fn on_key(&mut self, key: KeyEvent, _app: &mut App) -> UiCommand {
        if self.add.open {
            match key.code {
                KeyCode::Esc => return UiCommand::DownloadsAddCancel,
                KeyCode::Tab => {
                    self.add.focus = match self.add.focus {
                        DownloadsAddFocus::Topic => DownloadsAddFocus::MerkleRoot,
                        DownloadsAddFocus::MerkleRoot => DownloadsAddFocus::Destination,
                        DownloadsAddFocus::Destination => DownloadsAddFocus::Start,
                        DownloadsAddFocus::Start => DownloadsAddFocus::Abort,
                        DownloadsAddFocus::Abort => DownloadsAddFocus::Topic,
                    };
                }
                KeyCode::BackTab => {
                    self.add.focus = match self.add.focus {
                        DownloadsAddFocus::Topic => DownloadsAddFocus::Abort,
                        DownloadsAddFocus::MerkleRoot => DownloadsAddFocus::Topic,
                        DownloadsAddFocus::Destination => DownloadsAddFocus::MerkleRoot,
                        DownloadsAddFocus::Start => DownloadsAddFocus::Destination,
                        DownloadsAddFocus::Abort => DownloadsAddFocus::Start,
                    };
                }
                KeyCode::Enter => match self.add.focus {
                    DownloadsAddFocus::Start => return UiCommand::DownloadsAddConfirm,
                    DownloadsAddFocus::Abort => return UiCommand::DownloadsAddCancel,
                    _ => {}
                },
                KeyCode::Up => {
                    if self.add.focus == DownloadsAddFocus::Topic {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => i.saturating_sub(1),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                        }
                    }
                }
                KeyCode::Down => {
                    if self.add.focus == DownloadsAddFocus::Topic {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => (i + 1).min(self.add.topics.len().saturating_sub(1)),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                        }
                    }
                }
                KeyCode::Backspace => {
                    if self.add.focus == DownloadsAddFocus::MerkleRoot {
                        self.add.merkle_root.pop();
                    } else if self.add.focus == DownloadsAddFocus::Destination {
                        self.add.destination.pop();
                    }
                }
                KeyCode::Char(c) => {
                    if self.add.focus == DownloadsAddFocus::MerkleRoot {
                        self.add.merkle_root.push(c);
                    } else if self.add.focus == DownloadsAddFocus::Destination {
                        self.add.destination.push(c);
                    }
                }
                _ => {}
            }
            return UiCommand::None;
        }

        match key.code {
            KeyCode::Char('n') => return UiCommand::DownloadsAddOpen,
            KeyCode::Char('r') => return UiCommand::DownloadsRefresh,
            KeyCode::Char('R') => return UiCommand::DownloadsResume,
            KeyCode::Char('j') | KeyCode::Down => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                };
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let next = match self.table_state.selected() {
                    None => 0,
                    Some(i) => i.saturating_sub(1),
                };
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::PageDown | KeyCode::Char('J') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur
                    .saturating_add(self.last_viewport_rows)
                    .min(self.entries.len().saturating_sub(1));
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::PageUp | KeyCode::Char('K') => {
                let cur = self.table_state.selected().unwrap_or(0);
                let next = cur.saturating_sub(self.last_viewport_rows);
                if !self.entries.is_empty() {
                    self.table_state.select(Some(next));
                    self.selection.set_anchor(Some(next));
                }
            }
            KeyCode::Tab | KeyCode::Char(' ') => {
                if let Some(i) = self.table_state.selected() {
                    if let Some(e) = self.entries.get(i) {
                        self.selection.toggle(e.id, i);
                    }
                }
            }
            KeyCode::Char('c') => {
                self.selection.clear();
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.select_all(&keys);
            }
            KeyCode::Char('A') => {
                let keys: Vec<i64> = self.entries.iter().map(|e| e.id).collect();
                self.selection.select_all(&keys);
            }
            _ => {}
        }
        UiCommand::None
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect, _app: &mut App) -> UiCommand {
        if self.add.open {
            let popup = centered_rect(80, 80, area);
            let inner = popup.inner(Margin { vertical: 1, horizontal: 1 });
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints(
                    [
                        Constraint::Min(6),
                        Constraint::Length(3),
                        Constraint::Length(3),
                        Constraint::Length(3),
                    ]
                    .as_ref(),
                )
                .split(inner);

            let topic_scrollbar_metrics = compute_scrollbar_metrics(
                chunks[0],
                1,
                self.add.topics.len(),
                self.add.topics_state.offset(),
            );

            let btns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(12), Constraint::Length(12), Constraint::Min(10)].as_ref())
                .split(chunks[3]);

            if mouse_in(btns[0], &mouse) {
                self.add.hovered = DownloadsAddHovered::Start;
            } else if mouse_in(btns[1], &mouse) {
                self.add.hovered = DownloadsAddHovered::Abort;
            } else {
                self.add.hovered = DownloadsAddHovered::None;
            }

            if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
                // Scrollbar track/thumb interactions.
                if let Some(metrics) = topic_scrollbar_metrics {
                    if contains(metrics.scrollbar_col, mouse.column, mouse.row) {
                        match handle_scrollbar_down(metrics, mouse.row) {
                            ScrollbarDownResult::None => {}
                            ScrollbarDownResult::StartDrag { grab } => {
                                self.add.topics_scrollbar_drag = Some(grab);
                                return UiCommand::None;
                            }
                            ScrollbarDownResult::JumpTo { offset } => {
                                *self.add.topics_state.offset_mut() = offset;
                                self.add.topics_state.select(Some(
                                    offset.min(self.add.topics.len().saturating_sub(1)),
                                ));
                                self.add.focus = DownloadsAddFocus::Topic;
                                return UiCommand::None;
                            }
                        }
                    }
                }

                // Click-to-focus fields.
                if mouse_in(chunks[1], &mouse) {
                    self.add.focus = DownloadsAddFocus::MerkleRoot;
                    return UiCommand::None;
                }
                if mouse_in(chunks[2], &mouse) {
                    self.add.focus = DownloadsAddFocus::Destination;
                    return UiCommand::None;
                }

                if let Some(idx) = hit_test_table_index(
                    chunks[0],
                    1,
                    &mouse,
                    self.add.topics_state.offset(),
                    self.add.topics.len(),
                ) {
                    self.add.focus = DownloadsAddFocus::Topic;
                    self.add.topics_state.select(Some(idx));
                    return UiCommand::None;
                }

                if mouse_in(btns[0], &mouse) {
                    self.add.focus = DownloadsAddFocus::Start;
                    return UiCommand::DownloadsAddConfirm;
                }
                if mouse_in(btns[1], &mouse) {
                    self.add.focus = DownloadsAddFocus::Abort;
                    return UiCommand::DownloadsAddCancel;
                }
            }

            match mouse.kind {
                MouseEventKind::Drag(MouseButton::Left) => {
                    if let (Some(grab), Some(metrics)) = (self.add.topics_scrollbar_drag, topic_scrollbar_metrics) {
                        let target = handle_scrollbar_drag(metrics, grab, mouse.row);
                        *self.add.topics_state.offset_mut() = target;
                        self.add.topics_state.select(Some(
                            target.min(self.add.topics.len().saturating_sub(1)),
                        ));
                        self.add.focus = DownloadsAddFocus::Topic;
                    }
                }
                MouseEventKind::Up(MouseButton::Left) => {
                    self.add.topics_scrollbar_drag = None;
                }
                MouseEventKind::ScrollDown => {
                    if mouse_in(chunks[0], &mouse) {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => (i + 1).min(self.add.topics.len().saturating_sub(1)),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                            self.add.focus = DownloadsAddFocus::Topic;
                        }
                    }
                }
                MouseEventKind::ScrollUp => {
                    if mouse_in(chunks[0], &mouse) {
                        let next = match self.add.topics_state.selected() {
                            None => 0,
                            Some(i) => i.saturating_sub(1),
                        };
                        if !self.add.topics.is_empty() {
                            self.add.topics_state.select(Some(next));
                            self.add.focus = DownloadsAddFocus::Topic;
                        }
                    }
                }
                _ => {}
            }

            return UiCommand::None;
        }
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(8), Constraint::Length(3)].as_ref())
            .split(area);

        let list_area = chunks[0];
        let footer_area = chunks[1];
        let footer_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(10), Constraint::Length(12), Constraint::Length(12)].as_ref())
            .split(footer_area);

        if mouse_in(footer_chunks[1], &mouse) {
            self.hovered = DownloadsHovered::Refresh;
        } else if mouse_in(footer_chunks[2], &mouse) {
            self.hovered = DownloadsHovered::Resume;
        } else {
            self.hovered = DownloadsHovered::None;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if mouse_in(footer_chunks[1], &mouse) {
                    return UiCommand::DownloadsRefresh;
                }

                if mouse_in(footer_chunks[2], &mouse) {
                    return UiCommand::DownloadsResume;
                }

                if let Some(idx) = hit_test_table_index(
                    list_area,
                    1,
                    &mouse,
                    self.table_state.offset(),
                    self.entries.len(),
                ) {
                    self.table_state.select(Some(idx));
                    self.selection.set_anchor(Some(idx));

                    let inner = list_area.inner(Margin { vertical: 1, horizontal: 1 });
                    let rel_x = mouse.column.saturating_sub(inner.x).saturating_sub(1);
                    if rel_x < 4 {
                        if let Some(e) = self.entries.get(idx) {
                            self.selection.toggle(e.id, idx);
                        }
                    }
                }
            }
            MouseEventKind::ScrollDown => {
                if mouse_in(list_area, &mouse) {
                    let next = match self.table_state.selected() {
                        None => 0,
                        Some(i) => (i + 1).min(self.entries.len().saturating_sub(1)),
                    };
                    if !self.entries.is_empty() {
                        self.table_state.select(Some(next));
                        self.selection.set_anchor(Some(next));
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
                        self.table_state.select(Some(next));
                        self.selection.set_anchor(Some(next));
                    }
                }
            }
            _ => {}
        }

        UiCommand::None
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_download_key(v: &Value) -> Option<DownloadKey> {
    let topic = v.get("topic")?.as_str()?.to_string();
    let merkle_root = v.get("merkleRoot")?.as_str()?.to_string();
    let output_path = v.get("outputPath")?.as_str()?.to_string();
    if topic.is_empty() || merkle_root.is_empty() || output_path.is_empty() {
        return None;
    }
    Some(DownloadKey {
        topic,
        merkle_root,
        output_path,
    })
}

fn progress_percent(verified: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    ((verified.saturating_mul(100)) / total).min(100)
}

fn render_progress_bar(pct: u64, width: usize) -> String {
    if width == 0 {
        return "".to_string();
    }
    let p = pct.min(100) as usize;
    let filled = ((p.saturating_mul(width)) / 100).min(width);
    let mut s = String::with_capacity(width + 2);
    s.push('[');
    for i in 0..width {
        if i < filled {
            s.push('=');
        } else {
            s.push(' ');
        }
    }
    s.push(']');
    s
}

fn format_bytes_per_sec(bps: u64) -> String {
    if bps == 0 {
        return "".to_string();
    }
    if bps < 1024 {
        return format!("{} B/s", bps);
    }
    let kb = (bps as f64) / 1024.0;
    if kb < 1024.0 {
        return format!("{:.1} KiB/s", kb);
    }
    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{:.1} MiB/s", mb);
    }
    let gb = mb / 1024.0;
    format!("{:.1} GiB/s", gb)
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
