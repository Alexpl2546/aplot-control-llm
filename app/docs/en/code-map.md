<a id="entrypoints"></a>
# Code map

## Main entry points

| Area | Existing files | Responsibility |
| --- | --- | --- |
| Shell | [App.tsx](../../src/App.tsx), [KSidebar.tsx](../../src/components/shell/KSidebar.tsx), [KTopbar.tsx](../../src/components/shell/KTopbar.tsx), [KStatusBar.tsx](../../src/components/shell/KStatusBar.tsx) | Navigation, initialization and shared layout; [shell boundaries](modules/shell.md) |
| UI launch actions | [launchActions.ts](../../src/features/launches/launchActions.ts), [useLaunchAction.ts](../../src/features/launches/useLaunchAction.ts) | Shared draft confirmation for the card and palette; lifecycle remains owned by the run manager |
| Memory presentation | [memoryUsage.ts](../../src/features/resources/memoryUsage.ts), [MemoryMap.tsx](../../src/components/shell/MemoryMap.tsx) | Pure advisory share calculation and separate system measurement presentation |
| State | [control.ts](../../src/store/control.ts) | Settings, current runtime, profiles, and UI actions |
| Native bridge | [tauri.ts](../../src/services/tauri.ts) | Tauri commands, mocks, runtime, and OpenAPI call |
| API UI | [ApiDocsView.tsx](../../src/views/ApiDocsView.tsx), [ConnectionPanel.tsx](../../src/features/connections/ConnectionPanel.tsx) | OpenAPI, target, copying, and preview |
| Connection domain | [connections.ts](../../src/services/connections.ts), [harnesses.ts](../../src/features/connections/harnesses.ts) | Manager fallback, API checks, schema registry, and pure merge previews |
| Native API docs | [api_docs.rs](../../src-tauri/src/api_docs.rs), registered in [lib.rs](../../src-tauri/src/lib.rs) | Local URL validation, auth, and OpenAPI response |
| Profile storage | [profile_store.rs](../../src-tauri/src/profile_store.rs), [profile.rs](../../src-tauri/src/domain/profile.rs) | Versioned profiles, revisions, secret references, and recovery |
| Run lifecycle | [runs.rs](../../src-tauri/src/runs.rs), [engine_adapters.rs](../../src-tauri/src/engine_adapters.rs) | Immutable request, per-run operation locks, generations, and engine preparation |
| Artifact catalogue | [artifact_service.rs](../../src-tauri/src/artifact_service.rs), [model_artifacts.rs](../../src-tauri/src/model_artifacts.rs) | Actual roots/consumers, scan, and removal preview |
| Model downloads | [Rust module](../../src-tauri/src/downloads/mod.rs), [frontend service](../../src/features/modelDownloads/service.ts), [model-downloads.md](modules/model-downloads.md) | Hugging Face resolve, durable queue, verification, and GGUF publication |
| Resource plan | [resource_service.rs](../../src-tauri/src/resource_service.rs), [resource_planner.rs](../../src-tauri/src/resource_planner.rs), [ResourcePlanPanel.tsx](../../src/features/resources/ResourcePlanPanel.tsx) | Read-only native snapshots, pure accounting, and explicit advisory UI |
| Measurement jobs | [jobs.rs](../../src-tauri/src/jobs.rs), [benchmark.rs](../../src-tauri/src/benchmark.rs) | Run leases, cancellation, checkpoints, and results |
| Application exit | [app_lifecycle.rs](../../src-tauri/src/app_lifecycle.rs), [lib.rs](../../src-tauri/src/lib.rs) | Shared Quit/close/ExitRequested cleanup, job outcomes, owned shutdown, and tray behavior |
| Engines | [engine_adapters.rs](../../src-tauri/src/engine_adapters.rs), [strata.rs](../../src-tauri/src/strata.rs), llama.cpp command builder | Two launchable engines: llama.cpp and Strata |
| Installer and maintenance | `src-tauri/installer/components.json`, `Install-Components.ps1`, NSIS/WPF, `components.rs` / `component_maintenance.rs` | Installs only llama.cpp/Strata and manages agents separately; preserves user data |
| Types and localization | `src/types/{app,config,runtime}.ts`, `src/locales/{en,ru}/{common,kontur}.json` | Frontend DTOs and RU/EN strings |

## Data paths

1. `App.tsx` initializes the store.
2. `control.ts` loads settings/profiles and requests runtime state through `tauri.ts`.
3. The dashboard opens the API page through existing navigation.
4. `ConnectionPanel` reads the manager run list; legacy mode uses the current store snapshot.
5. `connections.ts` normalizes `run_connection`, falls back only when a manager command is explicitly unsupported, and checks health/list/SSE.
6. `ApiDocsView` calls the registered native documentation command and renders OpenAPI operations.
7. `createRunStartRequest` captures engine settings; `start_run` validates/prepares them and creates a managed run. `restart_run` reuses the native snapshot; referenced Strata/router files are not frozen with it.
8. The explicit resource button sends a preview request to `plan_run_resources`; metadata, active run snapshots, and current hardware feed the pure planner. The panel never applies variants.
9. The library resolves and prepares an HF source, then starts the queue; Rust persists the revision/task, streams files into scanner-excluded staging, and publishes only a verified set.
10. `start_benchmark_job` owns the selected run lease, executes the suite, and persists job outcome and completed evidence.

For job execution, read `prepare_registration` → `run_registered_job` in [jobs.rs](../../src-tauri/src/jobs.rs). The IPC wrapper and isolated tests share that core; optional AppHandle controls app events. The [real CPU job report](../../artifacts/restructuring/native-job.json) records queued/completed persistence and one sample, while the cancellation fixture checks retained partial evidence and lease release. Native GUI IPC acceptance remains separate.

## Connection edition

The harness registry and pure transformations are outside React. They do not open harness files or call apply. See the detailed [connections](modules/connections.md) and [harnesses](modules/harnesses.md) contracts.

The new tests are `app/tests/connections.test.ts` and `app/tests/harnessTemplates.test.ts`; the documentation checker is `app/scripts/verify-docs.mjs`. A link to those files does not imply that their commands have been run; execution evidence belongs in the handoff.

## Module reading routes

See [profiles](modules/profiles.md), [launch UI](modules/launches-ui.md), [runs](modules/runs.md), [engine adapters](modules/engine-adapters.md), [models](modules/models.md), [downloads](modules/model-downloads.md), [resources](modules/resources.md), and [jobs](modules/jobs.md) for detailed contracts. The only current local engine IDs are `llama_cpp` and `strata`; legacy IDs are retained for export and never launched automatically.
