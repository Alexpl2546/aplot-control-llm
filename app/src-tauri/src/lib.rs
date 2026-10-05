mod api_docs;
mod benchmark;
mod db;
mod engine_integration;
mod gguf;
mod hardware;
mod llama;
mod model_library;
mod models;
mod ollama;
mod process;
mod profiles;
mod qwfnfer;
mod router;
mod runtime;
mod settings;
mod strata;

use process::ProcessState;
use settings::WindowBehaviorState;
use tauri::{AppHandle, Manager};

#[tauri::command]
async fn quit_app(
    app: AppHandle,
    state: tauri::State<'_, ProcessState>,
    ollama: tauri::State<'_, ollama::OllamaState>,
) -> Result<(), String> {
    let stop_result = process::stop_managed(&app, &state).await;
    let _ = ollama::stop_ollama(ollama).await;
    app.exit(0);
    stop_result
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
        .manage(ollama::OllamaState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;
            let db = db::init_database(app.handle())?;
            let window_settings = settings::initial_window_settings(&db);
            app.manage(WindowBehaviorState::new(&window_settings));
            app.manage(db);
            app.manage(ProcessState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let behavior = window.app_handle().state::<WindowBehaviorState>();
                if behavior.close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            process::start_server,
            process::start_strata_server,
            process::restart_strata_server,
            process::start_qwfn_server,
            process::restart_qwfn_server,
            process::stop_server,
            process::restart_server,
            process::process_pid,
            quit_app,
            hardware::hardware_snapshot,
            llama::llama_health,
            llama::llama_slots,
            llama::llama_metrics,
            llama::detect_llama,
            runtime::runtime_snapshot,
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
            engine_integration::ollama_cached_library,
            settings::get_settings,
            settings::save_settings,
            strata::discover_strata_models,
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
            engine_integration::ollama_library,
            engine_integration::ollama_runtime,
            engine_integration::ollama_import,
            engine_integration::ollama_pull,
            engine_integration::ollama_benchmark,
            models::validate_llama_models,
            ollama::ollama_status,
            ollama::ollama_model_action,
            ollama::start_ollama,
            ollama::stop_ollama,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aplot Control LLM");
}
