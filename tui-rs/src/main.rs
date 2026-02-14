use anyhow::{Context, Result};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind, MouseButton,
        MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, layout::Rect, Terminal};
use std::{sync::mpsc, time::Duration};

use swarmfs_tui::{
    app::App,
    config::{get_ipc_endpoint, get_repo_root},
    ipc::{DaemonEvent, IpcClient},
    tabs::{global_keybind, Tab, TabId, UiCommand},
    tabs::{BrowseTab, DownloadsTab, FilesTab, LogsTab, NetworkTab},
    ui::{draw_footer, draw_tab_bar, layout},
};

fn main() -> Result<()> {
    let cwd = std::env::current_dir().context("current_dir")?;
    let repo_root = get_repo_root(&cwd)?;
    let (repo_root, _data_dir, endpoint) = get_ipc_endpoint(&repo_root)?;

    if !cfg!(windows) {
        let sock_path = std::path::PathBuf::from(&endpoint);
        if !sock_path.exists() {
            anyhow::bail!(
                "IPC socket not found at {} (repo_root={}). Set SWARMFS_IPC_ENDPOINT to override.",
                sock_path.display(),
                repo_root.display(),
            )
        }
    }

    let mut ipc = IpcClient::connect(endpoint.clone())?;
    let (evt_tx, evt_rx) = mpsc::channel::<DaemonEvent>();
    ipc.subscribe_events(vec!["log", "network"], evt_tx)?;

    let mut app = App::new();
    let _ = app.refresh_basics(&mut ipc);

    let mut network_tab = NetworkTab::new();
    let mut browse_tab = BrowseTab::new();
    let mut downloads_tab = DownloadsTab::new();
    let mut files_tab = FilesTab::new();
    let mut logs_tab = LogsTab::new();

    network_tab.refresh(&mut ipc);

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let tick_rate = Duration::from_millis(50);

    loop {
        while let Ok(evt) = evt_rx.try_recv() {
            if let DaemonEvent::Network(net_evt) = evt.clone() {
                network_tab.on_network_event(net_evt);
            }
            app.on_daemon_event(evt);
        }

        terminal.draw(|f| {
            let areas = layout(f.area());
            draw_tab_bar(f, areas.tab_bar, &mut app);

            match app.active_tab {
                TabId::Network => network_tab.draw(f, areas.content, &mut app),
                TabId::Browse => browse_tab.draw(f, areas.content, &mut app),
                TabId::Downloads => downloads_tab.draw(f, areas.content, &mut app),
                TabId::Files => files_tab.draw(f, areas.content, &mut app),
                TabId::Logs => logs_tab.draw(f, areas.content, &mut app),
            }

            draw_footer(f, areas.footer, &mut app);
        })?;

        if event::poll(tick_rate)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    // Global keybinds (quit + tab switching)
                    match global_keybind(key) {
                        UiCommand::Quit => app.should_quit = true,
                        UiCommand::SwitchTab(t) => app.set_active_tab(t),
                        UiCommand::None | UiCommand::Refresh => {
                            // Fallthrough to tab handlers.
                            let cmd = match app.active_tab {
                                TabId::Network => network_tab.on_key(key, &mut app),
                                TabId::Browse => browse_tab.on_key(key, &mut app),
                                TabId::Downloads => downloads_tab.on_key(key, &mut app),
                                TabId::Files => files_tab.on_key(key, &mut app),
                                TabId::Logs => logs_tab.on_key(key, &mut app),
                            };

                            if matches!(cmd, UiCommand::Refresh) && app.active_tab == TabId::Network {
                                network_tab.refresh(&mut ipc);
                            }

                            apply_command(cmd, &mut app, &mut ipc);

                            // Keep these explicit and beginner-friendly.
                            if app.active_tab == TabId::Network {
                                match key.code {
                                    crossterm::event::KeyCode::Enter => network_tab.join_selected(&mut ipc),
                                    crossterm::event::KeyCode::Backspace => network_tab.leave_selected(&mut ipc),
                                    _ => {}
                                }
                            }
                        }
                    }
                }

                Event::Mouse(m) => {
                    // Compute current layout for routing.
                    let size = terminal.size()?;
                    let areas = layout(Rect::new(0, 0, size.width, size.height));

                    // Tab-bar mouse click
                    if let MouseEventKind::Down(MouseButton::Left) = m.kind {
                        for hb in &app.ui.tab_hitboxes {
                            if m.column >= hb.x0
                                && m.column < hb.x1
                                && m.row >= hb.y0
                                && m.row < hb.y1
                            {
                                app.set_active_tab(hb.tab);
                                break;
                            }
                        }
                    }

                    // Per-tab mouse (scroll etc.)
                    let cmd = match app.active_tab {
                        TabId::Network => network_tab.on_mouse(m, areas.content, &mut app),
                        TabId::Browse => browse_tab.on_mouse(m, areas.content, &mut app),
                        TabId::Downloads => downloads_tab.on_mouse(m, areas.content, &mut app),
                        TabId::Files => files_tab.on_mouse(m, areas.content, &mut app),
                        TabId::Logs => logs_tab.on_mouse(m, areas.content, &mut app),
                    };
                    apply_command(cmd, &mut app, &mut ipc);
                }

                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;

    Ok(())
}

fn apply_command(cmd: UiCommand, app: &mut App, ipc: &mut IpcClient) {
    match cmd {
        UiCommand::None => {}
        UiCommand::Quit => app.should_quit = true,
        UiCommand::SwitchTab(t) => app.set_active_tab(t),
        UiCommand::Refresh => {
            let _ = ipc;
        }
    }
}
