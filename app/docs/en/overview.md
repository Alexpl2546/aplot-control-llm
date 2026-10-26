<a id="purpose"></a>
# Overview

## Purpose

Aplot Control LLM is a desktop control surface for local LLM servers. It stores settings and profiles, starts supported engines, shows process and API state, opens API documentation, and helps pass an endpoint to another program.

The current stack is React + TypeScript + Zustand in the frontend, Tauri 2 and Rust in the desktop backend, and SQLite for persistent settings, profiles, and results. The application entry point is [App.tsx](../../src/App.tsx); most actions and state live in [control.ts](../../src/store/control.ts).

## Engines and screens

The existing UI keeps its dashboard, configuration, models, profiles, performance, logs, settings, and API pages. The only supported local engines are `llama_cpp` and `strata`; their separate requirements are documented in [adapters](modules/engine-adapters.md). Chat, agents, and external API connections have their own lifecycle.

The library can resolve, verify, and download GGUF files from public Hugging Face Hub repositories. Its background queue is independent from the selected screen, while model compatibility is checked separately for each engine. Strata still requires prepared configuration and companion files; see the [download contract](modules/model-downloads.md).

The API page retains its OpenAPI reference. This edition adds current connection details, manual field copying, and harness template previews. See the [connections module](modules/connections.md).

## Connection status today

The current native backend registers `list_runs` and `run_connection({ runId })`. The list returns the run manager's `RunInfo`; the target contains the selected run's engine, URL, discovered model ID, configured context, key, protocol, and managed flag. On an older backend that explicitly lacks `list_runs`, the UI uses the existing single-runtime `legacy-current` snapshot. That fallback is not a multi-run registry.

Harness requests are checked from the frontend against the endpoint. Browser CORS limits and differences between localhost in Windows, WSL, and a container remain visible. The harness registry describes officially documented schemas; it does not claim that an installed harness version passed a smoke test.

## Future boundaries

The planned supervisor, independent run history, persistent connection records, harness config writes, and checks performed from inside a harness are not implemented by this module. The UI does not write Hermes, DeepSeek Harness, Pi, or OpenClaw files.
