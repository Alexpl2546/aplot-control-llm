<a id="engine-adapters"></a>
# Engine launch adapters

## Responsibility and source map

[engine_adapters.rs](../../../src-tauri/src/engine_adapters.rs) prepares launches for the two supported local engines: `llama_cpp` and `strata`. [runs.rs](../../../src-tauri/src/runs.rs) owns the lifecycle, and [process.rs](../../../src-tauri/src/process.rs) creates and stops child processes. The shared `RunRequest` does not make engine settings interchangeable.

The adapter is an internal typed dispatcher, not a dynamic plugin system. It validates engine IDs during request preparation; an unknown or legacy ID returns a clear error and is never rewritten to `llama_cpp`.

## Common validation and snapshots

Preparation rejects blank identifiers, unsupported engines, and router mode outside llama.cpp. A declared endpoint must match the final effective `--port`; `--flag=value` is supported. The executable, model, and required settings are checked before a process is created.

The manager retains the request and prepared command for restart. Editing the UI does not change an active process. This is not a snapshot of external file contents: the executable, weights, Strata JSON, and router preset remain filesystem references. Replacing them outside the app can affect a later start.

Each runtime owns a separate Windows Job with kill-on-close semantics, including native children of Strata's Python server. A failed job assignment rolls back the launch. Port availability is checked before spawning; automatic port selection also avoids other managed reservations. Wildcard bind addresses remain in the engine arguments while local API requests use the corresponding loopback address.

`prepare_run` does not start a model. Resource planning is a separate read-only `plan_run_resources` command; it returns an advisory result and unknown values without writing a router preset or reserving memory.

## llama.cpp and router

llama.cpp launches through [StartServerRequest](../../../src-tauri/src/process.rs), which contains the executable, arguments, endpoint, and process settings. Single mode validates the primary generation model. Router mode uses a preset; API IDs are derived from profiles without changing saved names.

The frontend argument registry is [parameters.ts](../../../src/lib/parameters.ts), and command construction stays in [cli.ts](../../../src/lib/cli.ts). The endpoint port must match the final `--port`. A router preset for a run is prepared before launch and belongs to that run.

## Strata

[strata.rs](../../../src-tauri/src/strata.rs) accepts the installation root, a selected `strata-*.json`, host, port, and API key. It checks the Python environment, Strata layout, executable, tokenizer, and paths from the configuration. Binding outside loopback requires an API key.

Launch runs `.venv/Scripts/python.exe -m serve.server --engine strata --config … --host … --port …` from the Strata root. A prepared configuration is separate from downloading GGUF: a downloaded file does not create a tokenizer or `strata-*.json`, and does not prove compatibility. See [model downloads](models.md#hugging-face-downloads).

Launch metadata comes from the same validated config as the command: native model paths use the config's `cwd`, while tokenizer paths use the Python process root. Missing working directories and non-string engine arguments fail before launch.

## Saved legacy profiles

Profiles and exports retain original fields and unknown engine IDs for recovery or manual handling. Launch accepts only `llama_cpp` and `strata`; a legacy ID is rejected and never receives another engine's settings. A different engine is used only after an explicit user choice and validation.

Restart uses the active run's snapshot rather than fresh global settings. Router presets and Strata JSON remain external files; their contents are not frozen here.
