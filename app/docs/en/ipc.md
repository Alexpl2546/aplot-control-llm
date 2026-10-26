<a id="registered-commands"></a>
# IPC

## Model download commands

Local launches accept only `llama_cpp` or `strata`. The Hugging Face GGUF downloader has its own IPC and SQLite lifecycle; it does not use the `JobManager` queue.

| Command | Arguments | Result |
| --- | --- | --- |
| `resolve_model_download` | `{ source }` | `ResolvedDownload` with immutable revision, files, and GGUF variants |
| `prepare_model_download` | `{ selection, destination }` | `DownloadPlan` with the complete set, paths, size, and available space |
| `start_model_download` | `{ planId }` | Persisted `DownloadTask`; transfer continues asynchronously |
| `list_model_downloads` | none | `DownloadTask[]` |
| `get_model_download` | `{ id }` | One `DownloadTask` |
| `pause_model_download`, `resume_model_download`, `cancel_model_download`, `remove_model_download_partial` | `{ id }` | Updated `DownloadTask`; removal is limited to that task's staging folder |
| `model_download_destination` | `{ engine? }` | Engine model folder inside the application |

`download://updated` carries the full `DownloadTask` with a monotonic `sequence`. The UI subscribes and then fetches a snapshot; persisted state remains authoritative. Staging is excluded from scanning, and the final set is registered in the library after atomic publication. See the [download module](modules/model-downloads.md) for structures and state transitions.

## Registered connection command

The frontend bridge is in [tauri.ts](../../src/services/tauri.ts); the OpenAPI handler is in [api_docs.rs](../../src-tauri/src/api_docs.rs). The current API page uses:

| Command | Arguments | Result |
| --- | --- | --- |
| `fetch_openapi_spec` | `endpoint`, `apiKey`, `engine` | OpenAPI reference for the selected engine or a validation/request error |

The key is passed to the Rust command for this explicit call and is not placed in the OpenAPI URL. Rust rejects URL credentials, HTTPS, and non-local addresses for API documentation.

## Registered run-manager commands

The connection service expects:

| Command | Argument | Expected result |
| --- | --- | --- |
| `list_runs` | none | `RunInfo[]` |
| `prepare_run` | `{ request }` | Validated `RunInfo`, without spawning |
| `start_run` | `{ request }` | Started/current `RunInfo` |
| `stop_run`, `restart_run` | `{ runId }` | Target lifecycle action |
| `stop_all_runs` | none | Owned service/process shutdown |
| `run_runtime` | `{ runId }` | Target runtime metrics, guarded by generation |
| `run_connection` | `{ runId }` | `{ runId, engine, baseUrl, modelId, contextTokens, apiKey, protocol, managed }` |
| `open_run_web_ui` | `{ runId }` | Opens/focuses an authenticated auxiliary Web UI window for this ready llama.cpp or Strata run; returns no credentials |

The frontend `RunInfo` shape is defined in [runtime.ts](../../src/types/runtime.ts); the Rust struct and command handlers are in [runs.rs](../../src-tauri/src/runs.rs), and both commands are registered in [lib.rs](../../src-tauri/src/lib.rs). `RunInfo` contains `runId`, `name`, `engine`, `mode`, `endpoint`, `modelId`, `contextTokens`, `state`, `generation`, `managed`, plus optional `pid`, `startedAt`, and `lastError`. The connection panel projects the subset it needs from the list.

`run_connection` returns `protocol: "openai-chat-completions"`. The consumer accepts camelCase and snake_case list aliases but validates target fields strictly. In older backends that explicitly lack `list_runs`, the UI uses a single-run compatibility fallback. If `run_connection` is missing after a successful list, the UI reports it separately and lets the user explicitly select the legacy target.

`open_run_web_ui` holds the target operation lock while checking the actual prepared arguments, assigned endpoint and launch-time key. It checks that `/` serves HTML before creating a window. Disabled llama.cpp UI or an installation without bundled HTML produces an explicit error; opening does not start or restart a server. [web_ui.rs](../../src-tauri/src/web_ui.rs) selects the engine's authentication bootstrap before page scripts execute, without including the key in a URL or an IPC response. Strata uses its own `strata.apikey` JSON record and `strata.monitor.key` session record. Remote Web UI windows receive no Tauri capabilities. Closing an auxiliary window does not trigger application shutdown; stopping/restarting a run closes its window.

## API verification

After a target is received, the service sends GET `/health`, GET `/v1/models`, and POST `/v1/chat/completions` with `stream: true`. Each operation uses Bearer auth when a non-empty key exists, an independent 30-second timeout, and a shared cancellation AbortSignal. Results are not persisted.

## Resource, artifact, profile, and job commands

These handlers are registered in [lib.rs](../../src-tauri/src/lib.rs). Detailed arguments and limitations belong to their domain pages.

| Command | Arguments | Result and boundary |
| --- | --- | --- |
| `plan_run_resources` | `{ request: RunRequest }` | Contract-v1 `ResourcePlan` plus `warnings` and `activeRuns`; read-only advisory planning |
| `model_catalog` | none | Actual artifact catalogue and removal preview based on configured roots and native consumers |
| `list_profiles_v2`, `get_profile_v2`, `save_profile_v2` | Domain-specific profile/revision arguments | Versioned profiles; secret references and optimistic revisions |
| `start_benchmark_job` | `{ runId, request }` | Persisted queued `JobInfo`; execution continues asynchronously |
| `cancel_job` | `{ jobId }` | Cancellation request; partial evidence is retained |
| `list_jobs` | none | Latest persisted records overlaid with active states |

`plan_run_resources` accepts the same `runId`, `name`, `engine`, `mode`, `modelId`, `contextTokens`, and `launch` request shape as the run manager. It reads metadata/telemetry, creates no reservation, and returns no launch arguments or credentials. The frontend explicitly invokes it through [ResourcePlanPanel.tsx](../../src/features/resources/ResourcePlanPanel.tsx); the browser preview has no fabricated hardware response. The pure numeric lease registry has no IPC command or automatic launch admission.

See [resources](modules/resources.md), [models](modules/models.md), [profiles](modules/profiles.md), [jobs](modules/jobs.md), and [engine adapters](modules/engine-adapters.md). Run events use `run://log`/`run://state` with runId and generation; job events use `job://progress`/`job://state` with job identity. Public lists exclude full secret-bearing launch requests.

Managed benchmark `configSnapshot` uses `{ run, editorConfiguration, editorConfigurationSource: "caller" }`: `run` is the authoritative redacted native request, while editorConfiguration is optional redacted caller LaunchConfig. These are distinct contracts; a bare RunRequest cannot be applied as editor configuration. See [benchmark snapshot sources](benchmarks.md) before consuming old/new results.

The job IPC wrapper delegates to `prepare_registration`/`run_registered_job`; isolated fixtures call that same core with explicit DB/job managers and no AppHandle. Tests cover the cancellation pipeline and a real CPU job that completed and persisted its result. These are native core checks. They do not verify GUI event delivery or a browser-to-Tauri IPC call.
