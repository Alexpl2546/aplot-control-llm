# Aplot Control LLM architecture

## Goal
A local Windows control plane for llama.cpp, Strata, Ollama and QwFNfer: process ownership, launch configuration, profiles, GGUF discovery, runtime/hardware monitoring, logs, benchmarks and safe recovery. The engines are installed separately and run as managed local processes.

## Unified engines (0.7.0)

The common catalog is EngineModel with engine-specific sources. UI actions validate the chosen engine before dispatch; Rust validates the actual model before process/API loading. Legacy profiles default to llama.cpp; Ollama profiles store their engine and local tag in LaunchConfig. Router presets include llama.cpp profiles only. Ollama service ownership is separate from model residency; Start/Stop on the dashboard load/unload the selected tag, while settings manage the owned service. Runtime snapshots preserve the running engine and model independently of the current selection. See [architecture and native tests](OLLAMA_INTEGRATION_VERIFICATION.md).

## Profile and catalog synchronization (0.7.2)

The Models view scans configured directories and the directories referenced by saved llama.cpp profiles. A stopped Ollama service does not fail the shared library: its last catalog is retained in SQLite and an availability notice appears in the Ollama filter. Starting a model refreshes the actual Ollama registry before validating its completion capability. Managed Ollama uses `models/ollama` under the same installation root as the GGUF and Strata libraries.

GGUF import starts the local service, registers a unique model name, validates completion support, and runs a short generation before recording the source path and digest. This mapping merges the Ollama engine badge into the original GGUF card. A failed import validation removes only the newly created tag. Existing llama.cpp launch flags are not translated into Ollama: an Ollama profile stores its own model tag and context.

Every profile save, duplication, import and deletion rewrites the llama.cpp preset and requests `GET /models?reload=1` when a native router is running. The request uses the running router's endpoint and authentication snapshot. The returned model IDs must contain all saved llama.cpp profile names. The router process stays running. Strata and Ollama continue to expose their own HTTP APIs; they are not routes inside llama.cpp's native router.

## Boundary
```text
React / TypeScript / Zustand
  │
  │ Tauri invoke + events
  ▼
Rust application core
  ├── engine_integration.rs  Ollama catalog/import/benchmark/runtime
  ├── ollama.rs       service ownership and guarded native API actions
  ├── strata.rs       prepared native engine configurations
  ├── process.rs      managed process, stdout/stderr, stop/restart
  ├── runtime.rs      normalized runtime snapshot
  ├── llama.rs        /health, /metrics, /slots, version/help
  ├── hardware.rs     sysinfo + nvidia-smi
  ├── profiles.rs     SQLite CRUD/import/export/known-good snapshots
  ├── router.rs       generated llama.cpp router preset in app data
  ├── settings.rs     SQLite settings
  ├── models.rs       recursive GGUF discovery
  ├── gguf.rs         bounded lightweight GGUF metadata reader
  ├── benchmark.rs    completion benchmark/history
  └── db.rs           SQLite schema/events
        │
        └── llama-server.exe → single-model or native router HTTP API
```

Windows desktop services in TypeScript use official Tauri APIs/plugins for dialogs, opener, autostart, tray and window lifecycle.

## Sources of truth
1. `LaunchConfig` — launch/profile values.
2. `PARAMETER_REGISTRY` — configuration labels, CLI names, categories, dependencies and capability gates.
3. `buildServerArgs()` — translation from LaunchConfig to llama.cpp startup argv.
4. `parseCapabilities()` — actual installed binary feature discovery from `--version`/`--help`.
5. Rust `ProcessState` — managed child-process ownership.
6. SQLite — persistent profiles/settings/benchmark history and recovery snapshot.

## Process lifecycle
```text
stopped → starting → loading → ready ⇄ busy
   ↑          │          │       │
   └──── stopping ←──────┘       │
                 ↑               │
                 └─ restarting ←─┘

unexpected managed-process exit → crashed
```

`runtime_snapshot` combines managed-process state with HTTP observations:
- no managed PID → `stopped`;
- PID + endpoint unreachable → `starting`;
- reachable, not ready / HTTP 503 → `loading`;
- healthy + no active requests → `ready`;
- healthy + active requests → `busy`;
- detected unexpected child exit → `crashed`.

## Safe restart/recovery
The UI computes a field-level diff before Apply & Restart. When a single-model profile reaches `ready`, Rust stores an immutable serialized copy under `last_known_good_profile`. When the router reaches `ready`, Rust stores every profile plus the active config and router settings under `last_known_good_router`. Recovery restores that complete snapshot transactionally before restarting. Both snapshots remain recoverable if editable profile rows are subsequently overwritten.

## Native router mode
Router mode is a single managed `llama-server.exe` process using the selected binary's native `--models-preset`, `--models-max` and `--models-autoload` capabilities. The frontend compiles every saved llama.cpp profile to a generated `router-presets.ini` under Tauri app data. A saved profile's name is its OpenAI API `model` identifier. With the default maximum of one resident model, llama.cpp selects the named profile and handles unloading/loading when requests switch model IDs. The app does not run a second process per profile.

The router's bind address, port, maximum resident models and shared API key are persisted as application settings. The secret is passed to the child process as `LLAMA_API_KEY` and is not added to the generated CLI command. Non-loopback binding requires a key. Router mode is disabled when installed-binary capability detection does not find the required preset/max flags.

## Capability strategy
Run the selected binary with:
```text
llama-server.exe --version
llama-server.exe --help
```
Parse the output and gate version-specific controls. New flags can always be supplied through `extraArgs`.

## Security/network defaults
- bind host defaults to `127.0.0.1`;
- non-loopback binding without API key produces validation warning;
- runtime/benchmark requests support optional Bearer API key;
- one managed `llama-server.exe` process at a time (which can itself host multiple profile routes);
- secrets are masked in restart diff UI.

## Resource estimation
GGUF metadata for layers, embedding and attention heads is propagated into LaunchConfig. The estimator uses that metadata to improve KV/VRAM estimates and reports confidence. It remains advisory; actual llama.cpp allocation and `--fit` behavior are authoritative.

## Persistence
SQLite uses WAL mode and stores:
- profiles;
- key/value app settings and recovery snapshot;
- benchmark JSON results;
- event audit rows.

## Browser/mock mode
When Tauri is unavailable, the frontend uses deterministic mock runtime/models/profiles/benchmarks so UI work can proceed without a loaded local model.
