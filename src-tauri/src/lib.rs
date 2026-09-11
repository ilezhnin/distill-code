mod commands;
mod deep_links;
mod services;

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, OnceLock};

    pub(crate) fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}

#[cfg(target_os = "macos")]
use objc2::AnyThread;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSImage};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSProcessInfo, NSString};
use services::{bundled_agents, bundled_skills, distro_bundle::DistroBundleState};
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::WindowEvent;
use tauri::{include_image, Manager, RunEvent, WebviewWindow};
use tauri_plugin_window_state::StateFlags;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_POSITION: (f64, f64) = (14.0, 28.0);
const APP_LOG_MAX_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024;
/// Archived log files kept once `berd.log` hits the size cap. `KeepSome`
/// counts archives only — the active `berd.log` is always kept on top, so
/// this retains three files total. The plugin's default strategy is
/// `KeepOne`, which *deletes* the full file rather than archiving it — that
/// would wipe the captured agent-bridge stderr and panic backtraces
/// mid-incident.
const APP_LOG_ARCHIVES_KEPT: usize = 2;
#[cfg(target_os = "macos")]
const APP_DISPLAY_NAME: &str = "Distill";
#[cfg(target_os = "macos")]
const DEV_APP_NAME_ENV: &str = "BERD_DEV_APP_NAME";
#[cfg(target_os = "macos")]
const DEV_APP_ICON_ENV: &str = "BERD_DEV_APP_ICON";

fn install_panic_logging_hook() {
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let backtrace = backtrace.to_string();
        let panic_message = info.to_string();
        let message = format!("PANIC: {panic_message}\nbacktrace:\n{backtrace}");
        services::diagnostic_log::record_panic(panic_message, backtrace.clone());
        eprintln!("{message}");
        log::error!("{message}");
    }));
}

#[cfg(target_os = "macos")]
fn set_process_name() {
    let app_name = std::env::var(DEV_APP_NAME_ENV).unwrap_or_else(|_| APP_DISPLAY_NAME.to_string());
    let app_name = app_name.trim();
    if app_name.is_empty() {
        return;
    }

    NSProcessInfo::processInfo().setProcessName(&NSString::from_str(app_name));
}

pub(crate) fn apply_window_icon(window: &WebviewWindow) {
    if let Err(error) = window.set_icon(include_image!("icons/32x32.png")) {
        log::warn!("Failed to set window icon: {error}");
    }
}

fn apply_app_window_icons(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        apply_window_icon(window);
    }
}

#[cfg(target_os = "macos")]
fn set_dev_dock_icon() {
    let Ok(icon_path) = std::env::var(DEV_APP_ICON_ENV) else {
        return;
    };
    let icon_path = icon_path.trim();
    if icon_path.is_empty() {
        return;
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    let Some(icon) =
        NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(icon_path))
    else {
        log::warn!("Failed to load dev app icon from {icon_path}");
        return;
    };

    let ns_app = NSApplication::sharedApplication(mtm);
    unsafe {
        ns_app.setApplicationIconImage(Some(&icon));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging_hook();
    #[cfg(target_os = "macos")]
    set_process_name();

    let context = tauri::generate_context!();
    let e2e_mode = services::e2e_mode::E2eMode::from_process_env(&context.config().identifier)
        .unwrap_or_else(|error| panic!("invalid isolated E2E configuration: {error}"));
    if let Some(mode) = &e2e_mode {
        mode.enforce_process_env()
            .unwrap_or_else(|error| panic!("failed to initialize isolated E2E mode: {error}"));
    }

    let builder = tauri::Builder::default();

    // Single-instance enforcement: on Windows, a second launch exits early
    // and focuses the existing window instead of starting a duplicate app
    // (log files, db connections, agent host, etc.). macOS handles this
    // via RunEvent::Reopen further below.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("perf", log::LevelFilter::Debug)
                .max_file_size(APP_LOG_MAX_FILE_SIZE_BYTES)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(
                    APP_LOG_ARCHIVES_KEPT,
                ))
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("berd".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        );

    #[cfg(feature = "app-test-driver")]
    let builder = if let Some(mode) = &e2e_mode {
        let driver_config = tauri_plugin_app_test_driver::DriverConfig::new(
            mode.driver_token().to_owned(),
            mode.driver_run_root(),
        );
        builder.plugin(tauri_plugin_app_test_driver::init_isolated(driver_config))
    } else {
        builder.plugin(tauri_plugin_app_test_driver::init())
    };

    #[cfg(feature = "berdctl")]
    let builder = builder.plugin(tauri_plugin_berdctl::init());

    if let Some(mode) = &e2e_mode {
        mode.log_enabled();
    }

    let builder = if let Some(mode) = e2e_mode {
        builder.manage(mode)
    } else {
        builder
    };

    builder
        .setup(|app| {
            // Register every command-backed state in the Tauri state map
            // before any blocking, async, or filesystem work below. The main
            // window is created hidden, but its webview still loads and races
            // ahead on Tokio threads (e.g. `runChatRuntimeStartup` starting
            // the agent host and calling `refresh_runtime_config`). If a blocking
            // step runs first, those handlers read the state map before
            // `manage()` has run and fail with "state not managed". These
            // `manage()` calls are cheap and side-effect-free, so running them
            // first guarantees the state is present even while a later step
            // blocks the setup thread.
            let app_data_dir = app.path().app_data_dir()?;

            // Resolved before anything writes to disk so every part of the app
            // agrees on the chosen folder.
            match commands::distill_store::initialize(app) {
                Ok(state) => {
                    log::info!("Distill root: {}", state.root.display());
                    app.manage(state);
                }
                Err(error) => {
                    // Not fatal: without a root the app still runs on the
                    // previous OS-scattered layout, which is worse but
                    // working. Refusing to start over a folder would be a
                    // cure worse than the disease.
                    log::error!("Failed to resolve the Distill root: {error}");
                }
            }

            let bundled_runtime_config_path = app
                .try_state::<services::e2e_mode::E2eMode>()
                .and_then(|mode| mode.runtime_config_path().map(PathBuf::from))
                .or_else(|| match app.path().resource_dir() {
                    Ok(resource_dir) => Some(
                        resource_dir
                            .join(commands::runtime_config::BUNDLED_RUNTIME_CONFIG_FILE_NAME),
                    ),
                    Err(error) => {
                        log::warn!(
                            "Failed to resolve resource dir for bundled runtime config: {error}"
                        );
                        None
                    }
                });

            app.manage(commands::runtime_config::RuntimeConfigState::new(
                app_data_dir.clone(),
                bundled_runtime_config_path,
            ));
            // Construct and register the distro bundle up front (the agent host
            // and runtime-config readiness both depend on it). Seeding its bundled
            // skills/agents is filesystem work and is deferred below.
            app.manage(DistroBundleState::new(app.handle()));
            app.manage(bundled_skills::BundledSkillsState::default());
            app.manage(commands::terminal::TerminalState::default());
            app.manage(services::agent_host::AgentHost::new());
            app.manage(commands::window_session::WindowSessionRegistry::default());
            app.manage(commands::agent_setup::AgentSetupRegistry::default());

            // With all command state registered, it is now safe to run blocking,
            // async, network, or filesystem work.

            services::diagnostic_log::record_event(
                services::diagnostic_log::DiagnosticLevel::Info,
                services::diagnostic_log::DiagnosticCategory::Startup,
                "app_setup",
                None,
                std::collections::BTreeMap::new(),
            );

            #[cfg(target_os = "macos")]
            {
                if let Err(error) =
                    commands::notifications::init_completion_notifications(app.handle())
                {
                    log::warn!("Failed to initialize completion notifications: {error}");
                }
            }

            deep_links::install(app);

            services::berdctl_discovery::sweep_stale_discovery_files(&app_data_dir);

            // Seed bundled skills and agents from the distro bundle registered
            // above. This touches the filesystem, so it runs after the prompt.
            let e2e_agents_dir = app
                .try_state::<services::e2e_mode::E2eMode>()
                .map(|mode| mode.agents_dir());
            {
                let distro_state = app.state::<DistroBundleState>();
                let bundled_skills_state = app
                    .state::<bundled_skills::BundledSkillsState>()
                    .inner()
                    .clone();
                if let Some(bundle) = distro_state.bundle() {
                    let skills_bundle = bundle.clone();
                    let skills_app_data_dir = app_data_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        match bundled_skills::seed_bundled_skills(
                            &skills_bundle,
                            &skills_app_data_dir,
                        ) {
                            Ok(count) if count > 0 => {
                                log::info!("Seeded {count} bundled skill(s)");
                            }
                            Ok(_) => {}
                            Err(error) => log::warn!("Failed to seed bundled skills: {error}"),
                        }
                        bundled_skills_state.mark_ready();
                    });

                    match bundled_agents::seed_bundled_agents(bundle, e2e_agents_dir.as_deref()) {
                        Ok(result) => {
                            if result.seeded_count > 0 {
                                log::info!("Seeded {} bundled agent(s)", result.seeded_count);
                            }
                        }
                        Err(error) => log::warn!("Failed to seed bundled agents: {error}"),
                    }
                } else {
                    bundled_skills_state.mark_ready();
                }
            }
            app.manage(commands::global_shortcut::GlobalShortcutHandlerState::default());

            // Install or upgrade the Berd-managed ACP bridges (claude, codex)
            // to the latest published version in the background: each floats
            // to `<pkg>@latest` from the private npm registry onto the managed
            // Node runtime in app data; failures are logged and retried next
            // launch while any previously installed version keeps working.
            services::acp_tools_reconciler::spawn_startup_reconcile(app.handle());

            apply_app_window_icons(app.handle());

            // Build a custom macOS application menu so that the app submenu,
            // "About" item, and "Quit" item use the product name "Distill"
            // instead of the Cargo binary name.
            #[cfg(target_os = "macos")]
            {
                set_dev_dock_icon();
                refresh_traffic_light_position_on_window_changes(app);
                attach_main_window_lifecycle(app);

                let app_menu = SubmenuBuilder::new(app, "Distill")
                    .about_with_text(
                        "About Distill",
                        Some(AboutMetadataBuilder::new().name(Some("Distill")).build()),
                    )
                    .separator()
                    .services()
                    .separator()
                    .hide_with_text("Hide Distill")
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit_with_text("Quit Distill")
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .maximize_with_text("Zoom")
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;

                // Register the Window submenu as macOS's windowsMenu so that
                // the system injects standard window management items (Fill,
                // Center, Move & Resize, Full Screen Tile, Bring All to Front,
                // etc.) automatically.
                //
                if let Some(mtm) = MainThreadMarker::new() {
                    let ns_app = NSApplication::sharedApplication(mtm);
                    if let Some(main_menu) = ns_app.mainMenu() {
                        let window_title = NSString::from_str("Window");
                        if let Some(window_item) = main_menu.itemWithTitle(&window_title) {
                            if let Some(window_ns_menu) = window_item.submenu() {
                                ns_app.setWindowsMenu(Some(&window_ns_menu));
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agents::read_import_agent_file,
            commands::agents::read_agent_source_file,
            commands::avatars::get_cached_avatars_for_refs,
            commands::avatars::import_user_avatar_data_url,
            commands::avatars::import_agent_avatar_file,
            commands::avatars::delete_user_avatar,
            commands::cache::clear_local_media_caches,
            commands::global_shortcut::launch_global_shortcut_handler,
            commands::global_shortcut::stop_global_shortcut_handler,
            commands::agent_host::get_agent_host_url,
            commands::project_icons::scan_project_icons,
            commands::project_icons::read_project_icon,
            commands::renderer::log_renderer_event,
            commands::doctor::run_doctor,
            commands::doctor::run_doctor_fresh,
            commands::doctor::run_doctor_fix,
            commands::git::get_git_state,
            commands::git_changes::get_changed_files,
            commands::git::git_switch_branch,
            commands::git::git_stash,
            commands::git::git_init,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_create_branch,
            commands::git::git_has_ignored_files,
            commands::git::git_count_branch_commits_not_in_base,
            commands::git::git_delete_branch,
            commands::git::git_create_worktree,
            commands::git::git_remove_worktree,
            commands::message_queues::load_message_queues,
            commands::message_queues::persist_message_queue_updates,
            commands::local_mcp_inventory::list_local_mcp_inventory,
            commands::notifications::show_completion_notification,
            commands::agent_setup::start_agent_setup,
            commands::agent_setup::list_agent_setup_status,
            commands::agent_setup::clear_agent_setup_status,
            commands::provider_rate_limits::get_provider_rate_limits,
            commands::path_resolver::resolve_path,
            commands::path_resolver::canonicalize_authorized_workspace_directory,
            commands::path_resolver::check_directories_exist,
            commands::diagnostics::write_diagnostic_event,
            commands::distro::get_distro_bundle,
            commands::runtime_config::get_runtime_config,
            commands::runtime_config::set_fake_runtime_config,
            commands::runtime_config::clear_fake_runtime_config,
            commands::runtime_config::refresh_runtime_config,
            commands::system::get_home_dir,
            commands::system::save_exported_agent_file,
            commands::system::save_exported_session_file,
            commands::system::save_exported_session_files,
            commands::system::path_exists,
            commands::system::ensure_directory,
            commands::system::list_directory_entries,
            commands::system::inspect_attachment_paths,
            commands::system::search_file_mentions,
            commands::system::read_image_attachment,
            commands::distill_store::get_distill_root,
            commands::distill_store::set_distill_root,
            commands::distill_store::read_distill_document,
            commands::distill_store::write_distill_document,
            commands::project_store::read_project_document,
            commands::project_store::write_project_document,
            commands::project_store::list_project_documents,
            commands::project_store::write_project_run_closeout,
            commands::system::read_text_file,
            commands::system::stat_file,
            commands::terminal::start_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::stop_terminal,
            commands::window_session::get_session_window_support,
            commands::window_session::open_session_window,
            commands::window_session::release_session,
            commands::window_session::join_session_handoff,
            commands::window_session::publish_session_handoff_snapshot,
            commands::window_session::finish_session_handoff,
            commands::window_session::read_session_handoff_snapshot,
            commands::window_session::recover_session_handoff,
            commands::window_session::focus_session_window,
            commands::window_session::list_session_windows,
            commands::agent_skills::list_agent_skills,
            commands::agent_skills::list_berd_app_skills,
            commands::workspace_context::load_workspace_context,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                app.state::<commands::global_shortcut::GlobalShortcutHandlerState>()
                    .stop();
                app.state::<commands::terminal::TerminalState>().stop_all();
                app.state::<services::agent_host::AgentHost>().shutdown();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            RunEvent::Ready => {
                apply_app_window_icons(app);
            }
            _ => {}
        });
}

#[cfg(target_os = "macos")]
fn refresh_traffic_light_position_on_window_changes(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        attach_traffic_light_management(&window);
    }
}

#[cfg(target_os = "macos")]
fn attach_main_window_lifecycle(app: &tauri::App) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };

    let app_handle = app.handle().clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let has_secondary_window = app_handle
                .webview_windows()
                .keys()
                .any(|label| label != "main");

            if has_secondary_window {
                api.prevent_close();
                if let Some(main) = app_handle.get_webview_window("main") {
                    let _ = main.hide();
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn attach_traffic_light_management(window: &WebviewWindow) {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    schedule_traffic_light_position_refresh(window);

    let window_for_events = window.clone();
    let resize_generation = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            let generation = resize_generation.fetch_add(1, Ordering::Relaxed) + 1;
            let delayed_window = window_for_events.clone();
            let delayed_generation = resize_generation.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if delayed_generation.load(Ordering::Relaxed) == generation {
                    schedule_traffic_light_position_refresh(&delayed_window);
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Focused(true) => {
            resize_generation.fetch_add(1, Ordering::Relaxed);
            schedule_traffic_light_position_refresh(&window_for_events);

            let delayed_window = window_for_events.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                schedule_traffic_light_position_refresh(&delayed_window);
            });
        }
        _ => {}
    });
}

#[cfg(target_os = "macos")]
fn schedule_traffic_light_position_refresh(window: &WebviewWindow) {
    let window_for_main_thread = window.clone();
    let window_for_refresh = window.clone();
    let _ = window_for_main_thread.run_on_main_thread(move || {
        apply_traffic_light_position(&window_for_refresh);
    });
}

#[cfg(target_os = "macos")]
fn apply_traffic_light_position(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = &*ns_window.cast::<objc2_app_kit::NSWindow>();
        inset_traffic_lights(
            ns_window,
            TRAFFIC_LIGHT_POSITION.0,
            TRAFFIC_LIGHT_POSITION.1,
        );
    }
}

#[cfg(target_os = "macos")]
unsafe fn inset_traffic_lights(window: &objc2_app_kit::NSWindow, x: f64, y: f64) {
    use objc2_app_kit::{NSView, NSWindowButton};

    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };

    let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    let mut window_buttons = vec![close, miniaturize];
    if let Some(zoom) = window.standardWindowButton(NSWindowButton::ZoomButton) {
        window_buttons.push(zoom);
    }

    for (index, button) in window_buttons.into_iter().enumerate() {
        let mut rect = NSView::frame(&button);
        rect.origin.x = x + (index as f64 * space_between);
        button.setFrameOrigin(rect.origin);
    }
}
