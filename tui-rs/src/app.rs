use crate::ipc::{DaemonEvent, IpcClient};
use crate::tabs::TabId;
use anyhow::Result;
use std::collections::VecDeque;

pub struct App {
    pub should_quit: bool,
    pub active_tab: TabId,

    pub status_json: serde_json::Value,

    pub logs: VecDeque<LogEntry>,
    pub logs_max: usize,

    pub network: NetworkState,

    pub ui: UiState,
}

impl App {
    pub fn new() -> Self {
        Self {
            should_quit: false,
            active_tab: TabId::Network,
            status_json: serde_json::Value::Null,
            logs: VecDeque::new(),
            logs_max: 5000,
            network: NetworkState::default(),
            ui: UiState::default(),
        }
    }

    pub fn set_active_tab(&mut self, tab: TabId) {
        self.active_tab = tab;
    }

    pub fn push_log(&mut self, entry: LogEntry) {
        self.logs.push_back(entry);
        while self.logs.len() > self.logs_max {
            self.logs.pop_front();
        }
    }

    pub fn on_daemon_event(&mut self, evt: DaemonEvent) {
        match evt {
            DaemonEvent::Log(e) => {
                self.push_log(e);
            }
            DaemonEvent::Network(net_evt) => {
                self.network.on_event(&net_evt);
            }
        }
    }

    pub fn refresh_basics(&mut self, ipc: &mut IpcClient) -> Result<()> {
        // Keep this small and safe; tabs can request additional refreshes.
        if let Ok(v) = ipc.rpc("node.status", serde_json::json!({})) {
            self.status_json = v;
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub ts: i64,
    pub level: String,
    pub message: String,
}

impl TryFrom<serde_json::Value> for LogEntry {
    type Error = anyhow::Error;

    fn try_from(v: serde_json::Value) -> Result<Self, Self::Error> {
        Ok(Self {
            ts: v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0),
            level: v
                .get("level")
                .and_then(|x| x.as_str())
                .unwrap_or("info")
                .to_string(),
            message: v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        })
    }
}

#[derive(Default)]
pub struct NetworkState {
    pub stats_json: Option<serde_json::Value>,
}

impl NetworkState {
    pub fn on_event(&mut self, evt: &crate::ipc::NetworkEvent) {
        if let crate::ipc::NetworkEvent::Stats(v) = evt {
            self.stats_json = Some(v.clone());
        }
    }
}

#[derive(Default)]
pub struct UiState {
    // Populated on each draw pass.
    pub tab_hitboxes: Vec<TabHitbox>,
}

#[derive(Debug, Clone)]
pub struct TabHitbox {
    pub tab: TabId,
    pub x0: u16,
    pub x1: u16,
    pub y0: u16,
    pub y1: u16,
}
