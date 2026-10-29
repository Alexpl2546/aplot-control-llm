mod activity;
// The library test harness does not receive Tauri's bin-only Windows resource.
#[cfg(all(test, target_os = "windows", target_env = "msvc"))]
#[link(
    name = "aplot_test_resource",
    kind = "static",
    modifiers = "+whole-archive"
)]
unsafe extern "C" {}
mod agent_media;
mod agent_workspace;
mod api_docs;
mod app_lifecycle;
mod artifact_service;
mod benchmark;
mod chat;
mod chat_history;
mod chat_media;
mod claude_agent;
mod codex_agent;
mod codex_limits;
mod components;
mod connection_profiles;
mod openai_connection;
mod owned_job;
pub use components::inventory_cli as component_inventory_cli;
mod component_maintenance;
pub use component_maintenance::cli as component_maintenance_cli;
mod component_updates;
mod db;
mod dictation;
mod domain;
mod downloads;
mod engine_adapters;
mod gguf;
mod hardware;
mod hermes;
mod hermes_agent;
mod jobs;
mod knowledge;
mod llama;
mod migrations;
mod model_artifacts;
mod model_library;
mod model_preparation;
mod model_removal;
mod models;
mod process;
mod process_memory;
mod profile_store;
mod profiles;
mod resource_planner;
mod resource_service;
mod router;
mod runs;
mod runtime;
mod settings;
mod strata;
mod strata_engine_update;
mod strata_router;
mod tasks;
mod web_ui;

use process::ProcessState;
use settings::WindowBehaviorState;
use tauri::{AppHandle, Manager};

#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    app_lifecycle::shutdown(&app).await?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(runs::RunManager::default())
        .manage(dictation::Dictation::default())
        .manage(strata_router::StrataRouter::default())
        .manage(model_preparation::ModelPreparation::default())
        .manage(chat::ChatRequests::default())
        .manage(codex_agent::CodexManager::default())
        .manage(tasks::TaskHost::default())
        .manage(codex_limits::CodexLimits::default())
        .manage(claude_agent::ClaudeManager::default())
        .manage(openai_connection::OpenAiConnection::default())
        .manage(connection_profiles::ProfileOperations::default())
        .manage(hermes_agent::HermesAgents::default())
        .manage(jobs::JobManager::default())
        .manage(strata_engine_update::StrataEngineOperationLock::default())
        .manage(app_lifecycle::ShutdownState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(desktop)]
            if !(cfg!(debug_assertions) && std::env::var_os("APLOT_TEST_DATA_DIR").is_some()) {
                // An isolated acceptance app must not alter the user's Windows
                // startup entry when its copied settings are initialized.
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ))?;
            }
            let db = db::init_database(app.handle())?;
            // A failed import leaves the runtime with the window path; it never blocks startup.
            if let Err(error) = tasks::startup(&mut *db.0.try_lock().map_err(|e| e.to_string())?) {
                eprintln!("agent tasks: {error}");
            }
            let downloads = {
                let mut conn = db.0.try_lock().map_err(|e| e.to_string())?;
                downloads::DownloadManager::load(&mut conn)?
            };
            app.manage(downloads);
            let knowledge = {
                let conn = db.0.try_lock().map_err(|e| e.to_string())?;
                let index_path = conn
                    .path()
                    .filter(|p| !p.is_empty())
                    .map(|p| std::path::Path::new(p).with_file_name("knowledge-index.sqlite3"));
                knowledge::KnowledgeState::start(index_path, knowledge::load_vaults(&conn))
            };
            app.manage(knowledge);
            let window_settings = settings::initial_window_settings(&db);
            app.manage(WindowBehaviorState::new(&window_settings));
            app.manage(db);
            app.manage(ProcessState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Auxiliary Web UI windows close independently of the control app.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let behavior = window.app_handle().state::<WindowBehaviorState>();
                if behavior.close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    app_lifecycle::request_exit(window.app_handle().clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            model_preparation::model_preparation_status,
            model_preparation::strata_model_catalog,
            model_preparation::start_strata_model_preparation,
            model_preparation::cancel_model_preparation,
            downloads::commands::search_model_downloads,
            downloads::commands::resolve_model_download,
            downloads::commands::prepare_model_download,
            downloads::commands::start_model_download,
            downloads::commands::list_model_downloads,
            downloads::commands::get_model_download,
            downloads::commands::pause_model_download,
            downloads::commands::resume_model_download,
            downloads::commands::cancel_model_download,
            downloads::commands::remove_model_download_partial,
            downloads::commands::model_download_destination,
            connection_profiles::connection_profiles,
            connection_profiles::connection_profile_update,
            openai_connection::openai_status,
            openai_connection::openai_login,
            openai_connection::openai_cancel_login,
            openai_connection::openai_logout,
            openai_connection::openai_models,
            openai_connection::openai_chat_send,
            openai_connection::openai_chat_cancel,
            claude_agent::claude_images,
            claude_agent::claude_catalog,
            claude_agent::claude_status,
            claude_agent::claude_login,
            claude_agent::claude_set_executable,
            claude_agent::claude_start,
            claude_agent::claude_send,
            claude_agent::claude_respond,
            claude_agent::claude_stop,
            codex_limits::codex_limits,
            codex_agent::codex_available,
            codex_agent::codex_set_executable,
            codex_agent::codex_rpc,
            codex_agent::codex_respond,
            tasks::agent_tasks_snapshot,
            tasks::agent_tasks_subscribe,
            tasks::agent_task_send,
            tasks::agent_task_prepare,
            tasks::agent_task_resume,
            tasks::agent_task_interrupt,
            tasks::agent_task_cancel_queued,
            tasks::agent_task_reset_session,
            tasks::agent_task_access,
            tasks::agent_approval_resolve,
            tasks::agent_tasks_rollback,
            tasks::agent_tasks_enable,
            components::available_engines,
            component_maintenance::component_maintenance_state,
            component_maintenance::remove_components,
            component_maintenance::remove_old_component_versions,
            component_maintenance::launch_uninstaller,
            component_maintenance::open_uninstall_settings,
            component_updates::component_update_state,
            component_updates::update_component,
            component_updates::install_component,
            artifact_service::model_catalog,
            resource_service::plan_run_resources,
            jobs::start_benchmark_job,
            jobs::cancel_job,
            jobs::list_jobs,
            runs::prepare_run,
            runs::start_run,
            runs::list_runs,
            runs::stop_run,
            runs::remove_run,
            runs::restart_run,
            runs::stop_all_runs,
            runs::run_runtime,
            runs::run_connection,
            hermes::hermes_available,
            hermes::open_in_hermes,
            hermes_agent::hermes_agent_start,
            hermes_agent::hermes_agent_prompt,
            hermes_agent::hermes_agent_respond,
            hermes_agent::hermes_agent_stop,
            hermes_agent::hermes_agent_context,
            hermes_agent::hermes_agent_voice,
            hermes_agent::hermes_agent_access,
            agent_media::hermes_agent_files,
            agent_media::hermes_agent_import,
            activity::activity_list,
            activity::activity_record,
            agent_workspace::agent_workspace_load,
            agent_workspace::agent_workspace_save,
            agent_workspace::agent_workspace_folder,
            agent_workspace::agent_workspace_files,
            agent_workspace::agent_workspace_read,
            agent_workspace::agent_workspace_open,
            agent_workspace::agent_workspace_open_document,
            agent_workspace::agent_workspace_skills,
            agent_workspace::agent_projects_root,
            knowledge::knowledge_bind,
            knowledge::knowledge_unbind,
            knowledge::knowledge_reindex,
            knowledge::knowledge_status,
            knowledge::knowledge_search,
            knowledge::knowledge_read,
            knowledge::knowledge_open_obsidian,
            chat_media::chat_attachment_read,
            chat::chat_send,
            chat::chat_cancel,
            chat_history::chat_history_load,
            chat_history::chat_history_save,
            runs::open_run_web_ui,
            process::start_server,
            process::start_strata_server,
            process::restart_strata_server,
            strata_engine_update::update_strata_engine,
            strata_engine_update::strata_engine_status,
            strata_router::configure_strata_router,
            dictation::dictation_start,
            dictation::dictation_level,
            dictation::dictation_stop,
            dictation::dictation_cancel,
            strata_router::strata_router_status,
            process::stop_server,
            process::restart_server,
            process::process_pid,
            quit_app,
            app_lifecycle::workspace_shutdown_flushed,
            hardware::hardware_snapshot,
            llama::llama_health,
            llama::llama_slots,
            llama::llama_metrics,
            llama::detect_llama,
            runtime::runtime_snapshot,
            profile_store::list_profiles_v2,
            profile_store::get_profile_v2,
            profile_store::save_profile_v2,
            profile_store::import_profile_v2,
            profile_store::import_profile_file_v2,
            profile_store::export_profile_v2,
            profile_store::export_profile_file_v2,
            profile_store::delete_profile_v2,
            profile_store::resolve_profile_launch_config,
            profile_store::recovery::duplicate_profile_v2,
            profile_store::recovery::mark_profile_good_v2,
            profile_store::recovery::last_known_good_profile_v2,
            profile_store::recovery::restore_last_known_good_profile_v2,
            profile_store::recovery::mark_router_good_v2,
            profile_store::recovery::last_known_good_router_v2,
            profile_store::recovery::restore_last_known_good_router_v2,
            model_artifacts::scan_model_artifacts_command,
            model_artifacts::preview_model_artifact_removal,
            model_removal::model_removal_plan,
            model_removal::remove_model,
            strata::strata_config_details,
            strata::save_strata_config,
            profiles::list_profiles,
            profiles::save_profile,
            profiles::delete_profile,
            profiles::export_profile,
            profiles::import_profile,
            profiles::mark_profile_good,
            profiles::last_known_good_profile,
            profiles::mark_router_good,
            profiles::last_known_good_router,
            profiles::restore_last_known_good_router,
            router::router_preset_path,
            router::write_router_preset,
            router::reload_router_models,
            settings::get_settings,
            settings::save_settings,
            strata::discover_strata_models,
            strata::create_strata_task_config,
            strata::remove_strata_task_config,
            models::scan_models,
            models::list_scan_roots,
            models::scan_llama_servers,
            models::scan_disk_models,
            model_library::model_library_path,
            model_library::import_model_directory,
            model_library::cancel_model_import,
            models::discover_common_locations,
            benchmark::run_benchmark,
            benchmark::run_benchmark_suite,
            benchmark::list_benchmark_suites,
            benchmark::list_benchmarks,
            api_docs::fetch_openapi_spec,
            models::validate_llama_models,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aplot Control LLM")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code != Some(tauri::RESTART_EXIT_CODE) && !app_lifecycle::is_complete(app) {
                    api.prevent_exit();
                    app_lifecycle::request_exit(app.clone());
                }
            }
        });
}
