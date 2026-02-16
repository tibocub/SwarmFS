use anyhow::{Context, Result};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind, MouseButton,
        MouseEventKind, KeyCode,
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
    ipc.subscribe_events(vec!["log", "network", "state"], evt_tx)?;

    let mut app = App::new();
    let _ = app.refresh_basics(&mut ipc);

    let mut network_tab = NetworkTab::new(endpoint.clone());
    let mut browse_tab = BrowseTab::new();
    let mut downloads_tab = DownloadsTab::new();
    let mut files_tab = FilesTab::new(endpoint.clone());
    let mut logs_tab = LogsTab::new();

    network_tab.refresh(&mut ipc);
    files_tab.refresh(&mut ipc);

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let tick_rate = Duration::from_millis(50);

    loop {
        files_tab.poll_async();
        network_tab.poll_async();
        while let Ok(evt) = evt_rx.try_recv() {
            match evt.clone() {
                DaemonEvent::Network(net_evt) => {
                    network_tab.on_network_event(net_evt);
                }
                DaemonEvent::State(state_evt) => {
                    match state_evt {
                        swarmfs_tui::ipc::types::StateEvent::Files(_)
                        | swarmfs_tui::ipc::types::StateEvent::Topics(_)
                        | swarmfs_tui::ipc::types::StateEvent::Other { .. } => {
                            // Refresh tab state on any state event.
                            // This keeps the UI reactive even if the event payload format changes.
                            network_tab.refresh(&mut ipc);
                            files_tab.refresh(&mut ipc);
                        }
                    }
                }
                _ => {}
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
                    if app.active_tab == TabId::Network && network_tab.is_modal_open() {
                        let cmd = network_tab.on_key(key, &mut app);
                        apply_command(cmd, &mut app, &mut ipc, &mut network_tab, &mut files_tab);
                        continue;
                    }

                    // If a modal is open, it must capture all key input so typing works.
                    // 'q' should remain a global quit shortcut ONLY when no modal is open.
                    if matches!(key.code, KeyCode::Char('q')) {
                        app.should_quit = true;
                        continue;
                    }

                    // Global keybinds (quit + tab switching)
                    match global_keybind(key) {
                        UiCommand::Quit => app.should_quit = true,
                        UiCommand::SwitchTab(t) => app.set_active_tab(t),
                        UiCommand::None
                        | UiCommand::Refresh
                        | UiCommand::JoinSelected
                        | UiCommand::LeaveSelected
                        | UiCommand::TopicNewOpen
                        | UiCommand::TopicNewSave
                        | UiCommand::TopicNewCancel
                        | UiCommand::TopicRemoveSelected
                        | UiCommand::FilesVerifySelected
                        | UiCommand::FilesRemoveSelected
                        | UiCommand::FilesAddOpen
                        | UiCommand::FilesAddConfirm
                        | UiCommand::FilesAddCancel => {
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

                            if matches!(cmd, UiCommand::Refresh) && app.active_tab == TabId::Files {
                                files_tab.refresh(&mut ipc);
                            }

                            apply_command(cmd, &mut app, &mut ipc, &mut network_tab, &mut files_tab);

                            // Files commands are dispatched via UiCommand.
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
                    apply_command(cmd, &mut app, &mut ipc, &mut network_tab, &mut files_tab);
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

fn apply_command(
    cmd: UiCommand,
    app: &mut App,
    ipc: &mut IpcClient,
    network_tab: &mut NetworkTab,
    files_tab: &mut FilesTab,
) {
    match cmd {
        UiCommand::None => {}
        UiCommand::Quit => app.should_quit = true,
        UiCommand::SwitchTab(t) => app.set_active_tab(t),
        UiCommand::Refresh => {
            let _ = ipc;
        }
        UiCommand::JoinSelected => network_tab.join_selected(ipc),
        UiCommand::LeaveSelected => network_tab.leave_selected(ipc),
        UiCommand::TopicNewOpen => network_tab.topic_new_open(),
        UiCommand::TopicNewCancel => network_tab.topic_new_cancel(),
        UiCommand::TopicNewSave => network_tab.topic_new_save(ipc),
        UiCommand::TopicRemoveSelected => network_tab.remove_selected(ipc),
        UiCommand::FilesVerifySelected => files_tab.verify_selected(ipc),
        UiCommand::FilesRemoveSelected => files_tab.remove_selected(ipc),
        UiCommand::FilesAddOpen => files_tab.add_open(),
        UiCommand::FilesAddConfirm => files_tab.add_confirm(ipc),
        UiCommand::FilesAddCancel => files_tab.add_cancel(),
    }
}
