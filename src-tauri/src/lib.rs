mod commands;
mod deep_links;
mod renderer_recovery;
mod services;

use services::{bundled_agents, bundled_skills, distro_bundle::DistroBundleState};
use std::path::PathBuf;
use tauri::{include_image, Manager, RunEvent, WebviewWindow};
use tauri_plugin_window_state::StateFlags;

const APP_LOG_MAX_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024;
/// Archived log files kept once `flock.log` hits the size cap. `KeepSome`
/// counts archives only — the active `flock.log` is always kept on top, so
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

/// The config builds the hidden main window unfocused, because wry treats a
/// failed `MoveFocus` as fatal and WebView2 fails it whenever no window is in
/// the foreground. But wry registers its file drop target on WebView2's child
/// windows once, while it builds the webview, and an unfocused hidden webview
/// does not have the child under the cursor yet: every file drag is then
/// refused (tauri-apps/wry#1639). Ask for focus whenever it cannot fail, and
/// say whether it was asked for.
#[cfg(windows)]
fn focus_main_window_when_foreground_exists(config: &mut tauri::Config) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    // SAFETY: GetForegroundWindow takes no arguments and only reads state.
    if unsafe { GetForegroundWindow() }.is_null() {
        return false;
    }
    for window in &mut config.app.windows {
        window.focus = true;
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging_hook();

    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    let main_window_focused = focus_main_window_when_foreground_exists(context.config_mut());
    let e2e_mode = services::e2e_mode::E2eMode::from_process_env(&context.config().identifier)
        .unwrap_or_else(|error| panic!("invalid isolated E2E configuration: {error}"));
    if let Some(mode) = &e2e_mode {
        mode.enforce_process_env()
            .unwrap_or_else(|error| panic!("failed to initialize isolated E2E mode: {error}"));
        #[cfg(feature = "app-test-driver")]
        services::agent_host::execution_fixture::initialize(mode)
            .unwrap_or_else(|error| panic!("invalid invented native fixture: {error}"));
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

    // The log file lives in the Flock root, so the root is resolved here,
    // before the log plugin opens the file, the way the store resolves it
    // again in `setup` (see `services::app_log`).
    let startup_root =
        services::app_log::startup_root(e2e_mode.as_ref(), &context.config().identifier);
    let app_log_dir = services::app_log::log_dir(startup_root.as_deref());

    let builder = tauri::Builder::default();

    // Single-instance enforcement: on Windows, a second launch exits early
    // and focuses the existing window instead of starting a duplicate app
    // (log files, db connections, agent host, etc.).
    //
    // This plugin must stay registered *before* `tauri_plugin_deep_link` so
    // that the deep-link state exists by the time this callback runs. Because
    // the dependency enables the plugin's `deep-link` feature, the plugin
    // itself hands `args` to `DeepLink::handle_cli_arguments` before invoking
    // the closure below — that is what turns a `flock://…` link clicked while
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
                    services::app_log::file_target(app_log_dir.clone()),
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

    #[cfg(feature = "flockctl")]
    let builder = builder.plugin(tauri_plugin_flockctl::init());

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
            let root_state =
                commands::flock_store::initialize(app).map_err(std::io::Error::other)?;
            let flock_root = root_state.root.clone();
            app.asset_protocol_scope()
                .allow_directory(&flock_root, true)?;
            log::info!("Flock root: {}", flock_root.display());
            match &app_log_dir {
                Some(dir) => log::info!(
                    "App log: {}",
                    dir.join(services::app_log::LOG_FILE_NAME).display()
                ),
                None => log::warn!(
                    "App log: the root's logs folder could not be created; this start logs to the OS log folder"
                ),
            }
            if startup_root.as_deref() != Some(flock_root.as_path()) {
                log::warn!(
                    "App log root differs from the Flock root: {}",
                    startup_root
                        .as_deref()
                        .map(|root| root.display().to_string())
                        .unwrap_or_else(|| "none".into())
                );
            }
            app.manage(root_state);

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
                flock_root.clone(),
                bundled_runtime_config_path,
            ));
            // Construct and register the distro bundle up front (the agent host
            // and runtime-config readiness both depend on it). Seeding its bundled
            // skills/agents is filesystem work and is deferred below.
            app.manage(DistroBundleState::new(app.handle()));
            app.manage(bundled_skills::BundledSkillsState::default());
            app.manage(commands::terminal::TerminalState::default());
            app.manage(services::agent_host::AgentHost::new());
            app.manage(services::benchmarks::BenchmarkState::default());
            app.manage(commands::agent_setup::AgentSetupRegistry::default());
            app.manage(services::provider_account_status::ProviderAccountStatusState::default());
            services::provider_account_status::start_schedule(app.handle().clone());

            if services::flock_root::adoption_enabled(
                app.try_state::<services::e2e_mode::E2eMode>().is_some(),
                services::flock_root::root_override().as_deref(),
            ) {
                let home = app.path().home_dir()?;
                services::root_migration::adopt_files(&flock_root, &app_data_dir, &home)
                    .map_err(std::io::Error::other)?;
            }

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

            services::flockctl_discovery::sweep_stale_discovery_files(&app_data_dir);

            // Seed bundled skills and agents from the distro bundle registered
            // above. This touches the filesystem, so it runs after the state
            // registration.
            let e2e_agents_dir = app
                .try_state::<services::e2e_mode::E2eMode>()
                .map(|mode| mode.agents_dir());
            // An isolated E2E run starts from nothing; everywhere else the
            // seeders below must find their earlier installs in the root under
            // the names they now look for.
            if e2e_agents_dir.is_none() {
                services::upstream_names::adopt(&flock_root);
            }
            {
                let distro_state = app.state::<DistroBundleState>();
                let bundled_skills_state = app
                    .state::<bundled_skills::BundledSkillsState>()
                    .inner()
                    .clone();
                if let Some(bundle) = distro_state.bundle() {
                    let skills_bundle = bundle.clone();
                    let skills_app_data_dir = flock_root.clone();
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

                    let agents_dir = e2e_agents_dir.unwrap_or_else(|| flock_root.join("agents"));
                    match bundled_agents::seed_bundled_agents(bundle, &agents_dir) {
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

            // Install or upgrade the Flock-managed ACP bridges (claude, codex)
            // in the background to the versions pinned in
            // `acp-tools.lock.json`, onto the managed Node runtime in app
            // data; failures are logged and retried next launch while any
            // previously installed version keeps working.
            services::acp_tools_reconciler::spawn_startup_reconcile(app.handle());

            let benchmark_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = benchmark_app
                    .state::<services::benchmarks::BenchmarkState>()
                    .start_existing(&benchmark_app)
                    .await
                {
                    log::warn!("Benchmark queue startup failed: {}", error.message);
                }
            });

            apply_app_window_icons(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                renderer_recovery::reload_when_renderer_dies(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::benchmarks::benchmark_list_definitions,
            commands::benchmarks::benchmark_get_definition,
            commands::benchmarks::benchmark_get_version,
            commands::benchmarks::benchmark_get_owned_task_mode,
            commands::benchmarks::benchmark_execution_backend_metadata,
            commands::benchmarks::benchmark_owned_task_choices,
            commands::benchmarks::benchmark_owned_task_native_choices,
            commands::benchmarks::benchmark_inspect_owned_task_mode,
            commands::benchmarks::benchmark_owned_task_public_result,
            commands::benchmarks::benchmark_owned_task_artifact_facts,
            commands::benchmarks::benchmark_set_owned_task_mode,
            commands::benchmarks::benchmark_prepare_owned_task,
            commands::benchmarks::benchmark_dispatch_owned_task,
            commands::benchmarks::benchmark_owned_task_status,
            commands::benchmarks::benchmark_cancel_owned_task,
            commands::benchmarks::benchmark_reopen_owned_task,
            commands::benchmarks::benchmark_get_owned_task,
            commands::benchmarks::benchmark_qualify_version,
            commands::benchmarks::benchmark_get_qualification,
            commands::benchmarks::benchmark_qualification_bindings,
            commands::benchmarks::benchmark_revoke_qualification,
            commands::benchmarks::benchmark_register_promotion_rule,
            commands::benchmarks::benchmark_campaign_deployment,
            commands::benchmarks::benchmark_class_policies,
            commands::benchmarks::benchmark_get_promotion_rule,
            commands::benchmarks::benchmark_promote_selector,
            commands::benchmarks::benchmark_list_promotions,
            commands::benchmarks::benchmark_revoke_promotion,
            commands::benchmarks::benchmark_save_draft,
            commands::benchmarks::benchmark_validate_draft,
            commands::benchmarks::benchmark_publish_version,
            commands::benchmarks::benchmark_duplicate_definition,
            commands::benchmarks::benchmark_archive_definition,
            commands::benchmarks::benchmark_import_definition,
            commands::benchmarks::benchmark_generate_variant,
            commands::benchmarks::benchmark_preview_run,
            commands::benchmarks::benchmark_preview_workflow_policy,
            commands::benchmarks::benchmark_start_workflow_policy,
            commands::benchmarks::benchmark_get_workflow_trace,
            commands::benchmarks::benchmark_freeze_workflow_campaign,
            commands::benchmarks::benchmark_list_workflow_campaigns,
            commands::benchmarks::benchmark_get_workflow_campaign,
            commands::benchmarks::benchmark_control_workflow_campaign,
            commands::benchmarks::benchmark_workflow_campaign_report,
            commands::benchmarks::benchmark_start_run,
            commands::benchmarks::benchmark_list_runs,
            commands::benchmarks::benchmark_list_attempts,
            commands::benchmarks::benchmark_list_designs,
            commands::benchmarks::benchmark_get_run,
            commands::benchmarks::benchmark_pause_run,
            commands::benchmarks::benchmark_resume_run,
            commands::benchmarks::benchmark_extend_run,
            commands::benchmarks::benchmark_set_run_parallelism,
            commands::benchmarks::benchmark_cancel_run,
            commands::benchmarks::benchmark_get_evidence,
            commands::benchmarks::benchmark_list_diagnostics,
            commands::benchmarks::benchmark_events_since,
            commands::benchmarks::benchmark_get_inventory,
            commands::benchmarks::benchmark_renew_policy_check,
            commands::benchmarks::benchmark_get_capabilities,
            commands::benchmarks::benchmark_get_leaderboard,
            commands::benchmarks::benchmark_get_history,
            commands::benchmarks::benchmark_get_model_history_view,
            commands::benchmarks::benchmark_get_case_stats,
            commands::benchmarks::benchmark_get_home_advantage,
            commands::benchmarks::benchmark_get_credit_spend,
            commands::benchmarks::benchmark_select_candidate,
            commands::benchmarks::benchmark_fit_selector,
            commands::benchmarks::benchmark_evaluate_class,
            commands::benchmarks::benchmark_class_evaluations,
            commands::benchmarks::benchmark_list_selector_fits,
            commands::benchmarks::benchmark_get_selector_fit,
            commands::benchmarks::benchmark_predict_selector,
            commands::benchmarks::benchmark_select_executor,
            commands::benchmarks::benchmark_preview_executor_decision,
            commands::benchmarks::benchmark_prepare_executor_decision,
            commands::benchmarks::benchmark_get_executor_decision,
            commands::benchmarks::benchmark_sync_executor_outcome,
            commands::benchmarks::benchmark_observe_executor,
            commands::benchmarks::benchmark_selector_harness,
            commands::benchmarks::benchmark_get_usage_ledger,
            commands::benchmarks::benchmark_get_routing_evidence,
            commands::benchmarks::benchmark_get_candidate_observations,
            commands::benchmarks::benchmark_list_catalog,
            commands::benchmarks::benchmark_save_catalog_entry,
            commands::benchmarks::benchmark_delete_catalog_entry,
            commands::benchmarks::benchmark_list_releases,
            commands::benchmarks::benchmark_create_release,
            commands::benchmarks::benchmark_submit_review,
            commands::benchmarks::benchmark_rescore,
            commands::benchmarks::benchmark_judge_pool,
            commands::benchmarks::benchmark_get_provider_data_use,
            commands::benchmarks::benchmark_calibrate_judge,
            commands::benchmarks::benchmark_export_dataset,
            commands::benchmarks::benchmark_list_schedules,
            commands::benchmarks::benchmark_save_schedule,
            commands::agents::read_import_agent_file,
            commands::flock_store::update_flock_settings,
            commands::project_store::initialize_project_context,
            commands::agents::read_agent_source_file,
            commands::avatars::get_cached_avatars_for_refs,
            commands::avatars::import_user_avatar_data_url,
            commands::avatars::import_agent_avatar_file,
            commands::avatars::delete_user_avatar,
            commands::cache::clear_local_media_caches,
            commands::agent_host::get_agent_host_url,
            commands::agent_host::prepare_agent_host_shutdown,
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
            commands::mcp_manager::read_local_mcp_configuration,
            commands::mcp_manager::update_local_mcp_configuration,
            commands::mcp_manager::list_mcp_diagnostics,
            commands::mcp_manager::check_mcp_connection,
            commands::notifications::show_completion_notification,
            commands::agent_setup::start_agent_setup,
            commands::agent_setup::list_agent_setup_status,
            commands::agent_setup::clear_agent_setup_status,
            commands::provider_accounts::list_provider_accounts,
            commands::provider_accounts::add_provider_account,
            commands::provider_accounts::update_provider_account,
            commands::provider_accounts::remove_provider_account,
            commands::provider_accounts::set_default_provider_account,
            commands::provider_accounts::set_provider_account_routing,
            commands::provider_accounts::authenticate_provider_account,
            commands::provider_accounts::cancel_provider_account_authentication,
            commands::provider_accounts::sign_out_provider_account,
            commands::provider_account_status::get_provider_account_statuses,
            commands::provider_account_status::consume_provider_account_reset,
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
            commands::system::allow_asset_directories,
            commands::system::ensure_directory,
            commands::system::list_directory_entries,
            commands::system::inspect_attachment_paths,
            commands::system::search_file_mentions,
            commands::system::read_image_attachment,
            commands::flock_store::get_flock_root,
            commands::flock_store::set_flock_root,
            commands::flock_store::read_flock_document,
            commands::flock_store::write_flock_document,
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
            commands::agent_skills::list_flock_app_skills,
            commands::workspace_context::load_workspace_context,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(move |app, event| match event {
            RunEvent::Exit => {
                app.state::<commands::terminal::TerminalState>().stop_all();
                app.state::<services::agent_host::AgentHost>().shutdown();
            }
            RunEvent::Ready => {
                apply_app_window_icons(app);
                #[cfg(windows)]
                {
                    if !main_window_focused {
                        log::warn!(
                            "No window was in the foreground at startup, so file drops stay off until a restart"
                        );
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    pub(crate) fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// A temporary folder for tests that open SQLite databases in it.
    ///
    /// sqlx closes a database file on its own threads, and the connection a
    /// test used last goes back to its pool on a task of the test's runtime.
    /// A plain `TempDir` dropped at the end of a test therefore deletes the
    /// folder while the file is still open: Windows refuses, `TempDir` ignores
    /// the error, and the folder stays in the temp directory. A test registers
    /// each pool it opens here and ends with [`TempRoot::close`].
    pub(crate) struct TempRoot {
        pools: Mutex<Vec<sqlx::SqlitePool>>,
        dir: tempfile::TempDir,
    }

    impl TempRoot {
        pub(crate) fn new() -> Self {
            Self {
                pools: Mutex::default(),
                dir: tempfile::tempdir().unwrap(),
            }
        }

        pub(crate) fn path(&self) -> &Path {
            self.dir.path()
        }

        pub(crate) fn register(&self, pool: &sqlx::SqlitePool) {
            self.pools.lock().unwrap().push(pool.clone());
        }

        /// Closes every registered pool, waits until its files are closed,
        /// and deletes the folder.
        pub(crate) async fn close(mut self) {
            let pools = std::mem::take(self.pools.get_mut().unwrap());
            for pool in pools {
                // A connection released just before is still on its way back:
                // sqlx 0.8 pings it on release after its closed check, and on
                // a loaded machine the ping outlasts `close`, so `release`
                // parks the connection in the idle queue of the closed pool,
                // where nothing closes it (`close` itself returned early: it
                // over-releases a permit per idle connection it closes). Every
                // `close` drains that queue, so close until the pool is empty.
                // Closing the last connection checkpoints the WAL on sqlx's
                // worker thread, which a loaded CI runner can stretch past
                // 10 s; a database a task really holds still fails here, only
                // later.
                let closed = tokio::time::timeout(Duration::from_secs(120), async {
                    loop {
                        pool.close().await;
                        if pool.size() == 0 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                })
                .await;
                assert!(
                    closed.is_ok(),
                    "a database in {} is still in use; finish or abort the task that holds it",
                    self.dir.path().display()
                );
            }
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let open = !self
                .pools
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty();
            if open && !std::thread::panicking() {
                panic!(
                    "databases in {} were never closed; end the test with `.close().await`",
                    self.dir.path().display()
                );
            }
        }
    }
}
