use crate::app::LogEntry;
use anyhow::Result;
use serde_json::Value;

#[derive(Debug, Clone)]
pub enum DaemonEvent {
    Log(LogEntry),
    Network(NetworkEvent),
    State(StateEvent),
    Downloads(DownloadsEvent),
}

impl TryFrom<Value> for DaemonEvent {
    type Error = anyhow::Error;

    fn try_from(v: Value) -> Result<Self, Self::Error> {
        let event = v.get("event").and_then(|x| x.as_str()).unwrap_or("");
        match event {
            "log" => {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                Ok(DaemonEvent::Log(LogEntry::try_from(data)?))
            }
            _ if event.starts_with("network.") => {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                Ok(DaemonEvent::Network(NetworkEvent::from_event_name(event, data)))
            }
            _ if event.starts_with("state.") => {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                Ok(DaemonEvent::State(StateEvent::from_event_name(event, data)))
            }
            _ if event.starts_with("downloads.") => {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                Ok(DaemonEvent::Downloads(DownloadsEvent::from_event_name(event, data)))
            }
            _ => anyhow::bail!("unknown event: {}", event),
        }
    }
}

#[derive(Debug, Clone)]
pub enum DownloadsEvent {
    Progress(Value),
    Complete(Value),
    Error(Value),
    Other { name: String, data: Value },
}

impl DownloadsEvent {
    pub fn from_event_name(name: &str, data: Value) -> Self {
        if name == "downloads.progress" {
            return DownloadsEvent::Progress(data);
        }
        if name == "downloads.complete" {
            return DownloadsEvent::Complete(data);
        }
        if name == "downloads.error" {
            return DownloadsEvent::Error(data);
        }
        DownloadsEvent::Other {
            name: name.to_string(),
            data,
        }
    }
}

#[derive(Debug, Clone)]
pub enum StateEvent {
    Files(Value),
    Topics(Value),
    Downloads(Value),
    Other { name: String, data: Value },
}

impl StateEvent {
    pub fn from_event_name(name: &str, data: Value) -> Self {
        if name == "state.files" {
            return StateEvent::Files(data);
        }
        if name == "state.topics" {
            return StateEvent::Topics(data);
        }
        if name == "state.downloads" {
            return StateEvent::Downloads(data);
        }
        StateEvent::Other {
            name: name.to_string(),
            data,
        }
    }
}

#[derive(Debug, Clone)]
pub enum NetworkEvent {
    Stats(Value),
    Other { name: String, data: Value },
}

impl NetworkEvent {
    pub fn from_event_name(name: &str, data: Value) -> Self {
        if name == "network.stats" {
            return NetworkEvent::Stats(data);
        }
        NetworkEvent::Other {
            name: name.to_string(),
            data,
        }
    }
}
