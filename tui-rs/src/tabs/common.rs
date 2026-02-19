use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
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

pub fn progress_percent(verified: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    ((verified.saturating_mul(100)) / total).min(100)
}

pub fn format_bytes_per_sec(bps: u64) -> String {
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
