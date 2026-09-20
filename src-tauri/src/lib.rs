mod commands;
mod deep_links;
mod services;

use services::{bundled_agents, bundled_skills, distro_bundle::DistroBundleState};
use std::path::PathBuf;
use tauri::{include_image, Manager, RunEvent, WebviewWindow};
use tauri_plugin_window_state::StateFlags;

const APP_LOG_MAX_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024;
/// Archived log files kept once `berd.log` hits the size cap. `KeepSome`
/// counts archives only — the active `berd.log` is always kept on top, so
/// this retains three files total. The plugin's default strategy is
/// `KeepOne`, which *deletes* the full file rather than archiving it — that
/// would wipe the captured agent-bridge stderr and panic backtraces
/// mid-incident.
const APP_LOG_ARCHIVES_KEPT: usize = 2;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging_hook();

    let context = tauri::generate_context!();
    let e2e_mode = services::e2e_mode::E2eMode::from_process_env(&context.config().identifier)
        .unwrap_or_else(|error| panic!("invalid isolated E2E configuration: {error}"));
    if let Some(mode) = &e2e_mode {
        mode.enforce_process_env()
            .unwrap_or_else(|error| panic!("failed to initialize isolated E2E mode: {error}"));
    }

    // Before the first plugin: every one of them — the log, the window state,
    // the WebView itself — opens its files under the identifier's folders, and
    // single-instance cannot see a build still running under the old one.
    let adopted_app_dirs = if e2e_mode.is_some() {
        Vec::new()
    } else {
        services::identifier_migration::adopt_replaced_app_dirs(&context.config().identifier)
            .unwrap_or_else(|refusal| services::identifier_migration::refuse_to_start(&refusal))
    };

    let builder = tauri::Builder::default();

    // Single-instance enforcement: on Windows, a second launch exits early
    // and focuses the existing window instead of starting a duplicate app
    // (log files, db connections, agent host, etc.).
    //
    // This plugin must stay registered *before* `tauri_plugin_deep_link` so
    // that the deep-link state exists by the time this callback runs. Because
    // the dependency enables the plugin's `deep-link` feature, the plugin
    // itself hands `args` to `DeepLink::handle_cli_arguments` before invoking
    // the closure below — that is what turns a `berd://…` link clicked while
    // the app is running into a `deep-link://new-url` event for
    // `deep_links::install`. The closure therefore only has to reveal the
    // window for a plain second launch; a session link additionally reveals it
    // from `deep_links::handle_urls` once the session opens.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
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
        .setup(move |app| {
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
            for dir in &adopted_app_dirs {
                log::info!(
                    "Adopted the previous identifier's folder as {}",
                    dir.display()
                );
            }

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

            deep_links::install(app);

            services::berdctl_discovery::sweep_stale_discovery_files(&app_data_dir);

            // Seed bundled skills and agents from the distro bundle registered
            // above. This touches the filesystem, so it runs after the state
            // registration.
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

            // Install or upgrade the Berd-managed ACP bridges (claude, codex)
            // in the background to the versions pinned in
            // `acp-tools.lock.json`, onto the managed Node runtime in app
            // data; failures are logged and retried next launch while any
            // previously installed version keeps working.
            services::acp_tools_reconciler::spawn_startup_reconcile(app.handle());

            apply_app_window_icons(app.handle());

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
            commands::agent_skills::list_agent_skills,
            commands::agent_skills::list_berd_app_skills,
            commands::workspace_context::load_workspace_context,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                app.state::<commands::terminal::TerminalState>().stop_all();
                app.state::<services::agent_host::AgentHost>().shutdown();
            }
            RunEvent::Ready => {
                apply_app_window_icons(app);
            }
            _ => {}
        });
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, OnceLock};

    pub(crate) fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}
