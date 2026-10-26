# Launch and multi-run UI

## Scope

The launch header selects a managed run and exposes its state, endpoint, and per-run start/stop/restart actions. Runtime polling and `run://log` / `run://state` subscriptions are owned by [the launch monitor](../../../src/features/launches/monitor.ts). The store keeps runtime metrics, log lines, history, and editable drafts by `runId`; late events are ignored when their generation no longer matches.

The managed-run bridge is in [tauri.ts](../../../src/services/tauri.ts), state and profile transitions are in [control.ts](../../../src/store/control.ts), and engine-specific launch controls are in [ServerHeader.tsx](../../../src/components/runtime/ServerHeader.tsx). `RunInfo` and event payload types are in [runtime.ts](../../../src/types/runtime.ts).

## Run identity and profile snapshots

Saved profiles use the stable ID `profile:<profileId>`. Each run has an independent settings/config draft. Switching the selector restores that run's draft and scoped runtime; changing another run does not replace its process or telemetry. Stop All calls the run manager once and updates each returned run state.

Profile capture/restoration lives in [profiles.ts](../../../src/features/launches/profiles.ts). It stores the current engine settings under `LaunchConfig.engineOptions`, keeps unknown keys, and restores recognized engine settings while leaving global UI preferences intact. Starting a saved profile uses the profile run ID. When its launch snapshot changes, the store stops and starts that run with the new request; an ordinary restart asks the manager to restart its stored snapshot.

The UI config keeps the complete settings map by engine. The v2 profile bridge converts the selected engine's entry to native `engineOptions: { engine, values }` and retains other engine snapshots and unknown fields in `legacyConfig.engineOptions`. Secret references move with the corresponding values and remain opaque to the editor; resolved credentials are used only for launch.

Profile CRUD uses the v2 bridge, including JSON file import/export, expected revisions for updates/deletes, and retained v2 snapshots. Invalid v2 records surface an error without legacy fallback. Unknown-engine profiles stay visible and exportable but cannot be selected or started.

The expandable model-package catalog at the bottom of Library reads native metadata through `model_catalog`. It displays roots, scan time, file/shard state, sizes, dependencies, consumers and missing references. Refresh rescans metadata; there are no deletion actions. Browser previews explicitly state that filesystem scanning requires the desktop app.

The UI consumes the `start_run`, `list_runs`, `stop_run`, `restart_run`, `run_runtime`, `run_connection`, and `stop_all_runs` commands. Runs from older global-server sessions still use the legacy facade until they are started through the managed-run UI.

## Benchmarks and cancellation

For a managed run, normal benchmarks and optimizer trials use `start_benchmark_job`. The service listens to `job://state` and `job://progress`, polls `list_jobs`, loads completed results from `list_benchmarks` using `benchmarkId`, and removes listeners when the promise settles. Cancel Benchmark and Stop Tuning call `cancel_job`; optimizer trial runs are stopped during cleanup. See [benchmark behavior and limits](../benchmarks.md).

Native benchmark snapshots separate authoritative `run` evidence from redacted `editorConfiguration`, labeled `editorConfigurationSource: "caller"`. The shared [configuration extractor](../../../src/lib/benchmarkLaunchConfig.ts) accepts legacy flat editor snapshots and this wrapper, and rejects a bare run request, invalid editor data, or engine/context mismatch. Ranking, recommendation application and profile saving use extracted editor data; redaction markers cannot become saved credentials. Applying a recommendation retains current credentials, while auto-saving profiles first clones the source through native v2 reference rebinding.

V2 known-good snapshots retain sanitized profiles and opaque references. Managed readiness marks the captured revision once per generation; trial runs are excluded. Rollback restores the target profile with a new revision, discards its stale draft and starts it through transient credential resolution. Other runs and their drafts remain available. ConfigurationView prepares resource-plan requests in memory; the explicit estimate button requests native telemetry without starting a process or writing router presets.

## Web UI windows

For a ready llama.cpp run, **Open Web UI** opens its bundled interface in a separate application window. The selected native run supplies the assigned port and actual launch-time key, so editing another profile cannot change this connection. The key is set automatically in the WebView's per-origin `LlamaUi.config` / legacy `LlamaCppWebui.config` local storage; other preferences are preserved. An empty key clears a stale credential when a port is reused. This is ordinary Web UI credential storage, separate from the profile secret vault and from Chrome's storage. Opening the URL manually in Chrome still requires entering the key there.

Single and router launches both honor the profile's `webUi` setting, including modern `--ui` / `--no-ui` and legacy `--webui` / `--no-webui` flags. Previously launched routers with disabled UI require a restart with this build. A build without bundled HTML reports an error. The bootstrap is scoped to the exact origin and main frame; navigation stays within this server. Repeated clicks focus the existing run window. Closing it keeps the model running; stop/restart closes that run's window. Other runs and their windows are independent. The main window retains its normal close-to-tray/quit behavior.

Authentication and settings preservation are covered in [webUiBootstrap.test.ts](../../../tests/webUiBootstrap.test.ts), router flags in [router.test.ts](../../../tests/router.test.ts), and native URL/window checks in [web_ui.rs](../../../src-tauri/src/web_ui.rs).

Strata also exposes **Open Web UI** when its selected run is ready or busy. It opens Strata's existing upstream interface (`serve/web`), including Chat, Monitor and settings. No additional chat frontend or server is installed. The same native run identity, actual port, window reuse and close/stop behavior apply. The engine-specific [Strata bootstrap](../../../src-tauri/src/strata_web_ui_bootstrap.js) writes a JSON string to `strata.apikey` and the optional API monitor's raw key to `sessionStorage["strata.monitor.key"]` before Strata scripts run. Chat history, theme, sampling settings and llama.cpp records are preserved. An empty launch key clears stale authentication on a reused port. The key never appears in the URL. The button is visible but unavailable while the server is loading; Strata does not use llama.cpp's `webUi` setting. An installation missing its bundled HTML reports an error.

## Verification

Run-selection and generation-isolation coverage is in [runsStore.test.ts](../../../tests/runsStore.test.ts). Profile capture/restore coverage is in [profileV2.test.ts](../../../tests/profileV2.test.ts). The application typecheck is `npm run typecheck` from `app/`.
