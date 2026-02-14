use crate::app::App;
use crate::tabs::{draw_placeholder, Tab, TabId};
use ratatui::{layout::Rect, Frame};

pub struct BrowseTab;
pub struct DownloadsTab;
pub struct FilesTab;

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
    pub fn new() -> Self {
        Self
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
        draw_placeholder(f, area, "Files");
    }
}
