# Tauri IPC contract

Frontend calls are centralized in `src/services/tauri.ts`, with desktop-only lifecycle actions in `src/services/desktop.ts`.

## Process
### `start_server`
Input:
```json
{
  "request": {
    "binaryPath": "C:\\AI\\llama.cpp\\llama-server.exe",
    "args": ["--model", "..."],
    "endpoint": "http://127.0.0.1:8080",
    "profileId": "router",
    "apiKey": "optional shared router key"
  }
}
```
Output: `{ "pid": 12345 }`.

### `stop_server`
Stops the managed process tree.

### `restart_server`
Same request as `start_server`; stop then spawn.

For router mode, `args` contains `--models-preset`, `--models-max` and detected router flags. `apiKey` is set as the child `LLAMA_API_KEY` environment variable and is not placed in argv.

### `process_pid`
Returns the live managed PID if present.

### `quit_app`
Rust-owned application termination used by the tray Quit action.

Events:
- `llama://log` → normalized log line containing original llama-server message.
- `llama://state` → process/runtime state hint.

## Runtime
### `runtime_snapshot`
Input:
```json
{
  "endpoint": "http://127.0.0.1:8080",
  "apiKey": null,
  "routerMode": false,
  "fallbackModelId": null
}
```
Returns normalized process + hardware + health + metrics + slots state. When `apiKey` is set, Bearer auth is sent to runtime endpoints. In router mode, the backend discovers loaded profile IDs through `GET /models`, then requests per-profile telemetry with `?model=<profile-id>`; the selected profile ID is a fallback only when the model list endpoint is unavailable.

Additional low-level handlers registered for direct diagnostics:
- `hardware_snapshot`
- `llama_health`
- `llama_metrics`
- `llama_slots`

### `detect_llama`
Input `{ "binaryPath": "..." }`.
Returns raw `versionOutput` + `helpOutput`; frontend parses capabilities.

## Persistence
### Profiles
- `list_profiles`
- `save_profile { profile }`
- `delete_profile { id }`
- `export_profile { id, path }`
- `import_profile { path }`
- `mark_profile_good { id }`
- `last_known_good_profile`
- `mark_router_good { snapshot }`
- `last_known_good_router`
- `restore_last_known_good_router`

`mark_profile_good` stores both the database flag and a serialized immutable profile snapshot used by rollback. `mark_router_good` stores an immutable snapshot of the full profile list, active configuration and router settings. Restore replaces the profile rows and relevant router settings in a single SQLite transaction.

### Settings
- `get_settings`
- `save_settings { settings }`

### Models
- `scan_models { directories }`

### Router preset
- `router_preset_path` — returns the app-data `router-presets.ini` path.
- `write_router_preset { preset }` — atomically writes the generated router INI.

### Benchmarks
- `run_benchmark { request, endpoint, profileName, apiKey }`
- `list_benchmarks`

## llama.cpp HTTP endpoints used
- `GET /health`
- `GET /metrics?model=<profile-id>` and `GET /slots?model=<profile-id>` in router mode; the model query is omitted in single-model mode.
- `GET /models` to discover currently loaded router profiles.
- `POST /completion` for benchmark
- `POST /v1/chat/completions` with the selected profile name as `model` for router benchmark
- `GET /v1/models` for clients discovering router profile IDs (served by llama.cpp)

Metrics recognized include:
- `llamacpp:prompt_tokens_seconds`
- `llamacpp:predicted_tokens_seconds`
- `llamacpp:requests_processing`
- `llamacpp:requests_deferred`
- `llamacpp:kv_cache_usage_ratio` when exposed
- `llamacpp:kv_cache_tokens` when exposed
- `llamacpp:n_tokens_max`

Missing optional metrics/slots degrade the UI rather than making server health fail.
