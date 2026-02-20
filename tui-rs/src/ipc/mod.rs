use crate::app::LogEntry;
use anyhow::{Context, Result};
use interprocess::local_socket::{GenericFilePath, ToFsName};
use interprocess::local_socket::prelude::LocalSocketStream;
use interprocess::local_socket::traits::Stream;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::Sender;
use std::thread;

pub mod types;

pub use types::{DaemonEvent, NetworkEvent};

pub struct IpcClient {
    rpc: RpcClient,
    endpoint: String,
}

impl IpcClient {
    pub fn connect(endpoint: String) -> Result<Self> {
        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .with_context(|| format!("invalid IPC endpoint name: {}", endpoint))?;

        let stream = LocalSocketStream::connect(name)
            .with_context(|| format!("connect IPC {}", endpoint))?;

        Ok(Self {
            rpc: RpcClient::new(stream),
            endpoint,
        })
    }

    pub fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.rpc.rpc(method, params)
    }

    pub fn subscribe_events(&self, channels: Vec<&str>, tx: Sender<DaemonEvent>) -> Result<()> {
        let endpoint = self.endpoint.clone();
        let channels: Vec<String> = channels.into_iter().map(|s| s.to_string()).collect();

        thread::spawn(move || {
            if let Err(e) = event_thread(endpoint, channels, tx) {
                // Best-effort: we can’t report this cleanly yet without a second channel.
                let _ = e;
            }
        });

        Ok(())
    }
}

struct RpcClient {
    reader: BufReader<LocalSocketStream>,
    next_id: u64,
}

impl RpcClient {
    fn new(stream: LocalSocketStream) -> Self {
        Self {
            reader: BufReader::new(stream),
            next_id: 1,
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        let req = serde_json::json!({
            "id": id.to_string(),
            "type": "req",
            "method": method,
            "params": params
        });

        let line = serde_json::to_string(&req)? + "\n";
        self.reader.get_mut().write_all(line.as_bytes())?;
        self.reader.get_mut().flush()?;

        let mut buf = String::new();
        loop {
            buf.clear();
            let n = self.reader.read_line(&mut buf)?;
            if n == 0 {
                anyhow::bail!("daemon disconnected")
            }

            let msg: Value = serde_json::from_str(buf.trim())?;
            if msg.get("type").and_then(|v| v.as_str()) != Some("res") {
                continue;
            }
            if msg.get("id").and_then(|v| v.as_str()) != Some(&id.to_string()) {
                continue;
            }

            if msg.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }

            let emsg = msg
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("RPC error")
                .to_string();
            anyhow::bail!(emsg)
        }
    }
}

fn event_thread(endpoint: String, channels: Vec<String>, tx: Sender<DaemonEvent>) -> Result<()> {
    let name = endpoint
        .as_str()
        .to_fs_name::<GenericFilePath>()
        .with_context(|| format!("invalid IPC endpoint name: {}", endpoint))?;

    let mut stream = LocalSocketStream::connect(name)
        .with_context(|| format!("connect IPC {}", endpoint))?;

    // Subscribe
    let req = serde_json::json!({
        "id": "1",
        "type": "req",
        "method": "events.subscribe",
        "params": { "channels": channels }
    });

    stream.write_all((serde_json::to_string(&req)? + "\n").as_bytes())?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut buf = String::new();

    loop {
        buf.clear();
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            break;
        }

        let v: Value = match serde_json::from_str(buf.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let typ = v.get("type").and_then(|x| x.as_str());
        if typ == Some("evt") {
            if let Some(evt) = DaemonEvent::try_from(v).ok() {
                let _ = tx.send(evt);
            }
            continue;
        }

        // Ignore responses (subscribe ack, etc.)
    }

    Ok(())
}

fn parse_log_entry(v: &Value) -> Option<LogEntry> {
    LogEntry::try_from(v.clone()).ok()
}

// Kept for future typed parsing extensions.
#[allow(dead_code)]
fn _parse_log_event(v: &Value) -> Option<DaemonEvent> {
    let data = v.get("data")?;
    let entry = parse_log_entry(data)?;
    Some(DaemonEvent::Log(entry))
}
