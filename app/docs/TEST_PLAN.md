# Test plan

## Automated frontend/domain
Run:
```powershell
npm run typecheck
npm test
npm run build
node .\scripts\validate-static.mjs
```
Existing Vitest coverage targets:
- CLI argument generation and shell quoting;
- resource estimator invariants;
- capability parsing;
- configuration validation;
- EN/RU parity;
- config diff behavior including API-key masking;
- router preset generation and option mapping;
- router capability gating and API-key/request targeting.

## Rust
Run:
```powershell
cargo fmt --manifest-path .\src-tauri\Cargo.toml -- --check
cargo test --manifest-path .\src-tauri\Cargo.toml
cargo check --manifest-path .\src-tauri\Cargo.toml
```
Add/fix tests as compile/runtime findings require, especially:
- SQLite empty-db startup and round trips;
- immutable known-good snapshot;
- complete router known-good snapshots and transactional restore;
- router benchmark selection and OpenAI SSE parsing;
- Prometheus parser fixtures;
- `/slots` fixtures;
- inaccessible model directories;
- duplicate managed process rejection;
- Windows child-tree termination.

## Real llama-server integration
1. Select the actual CUDA `llama-server.exe`.
2. Detect version/help and confirm capability UI matches it.
3. Scan a real GGUF folder and inspect parsed architecture metadata.
4. Launch a known model.
5. Verify PID and log streaming.
6. Observe `starting → loading → ready`.
7. Generate a request and observe `busy`, throughput and request counters.
8. Verify `/slots` with `--parallel 2+`.
9. Change context/KV/batch and inspect restart diff/generated CLI.
10. Apply & Restart and confirm spawned argv corresponds to generated args.
11. Enable API key and confirm `/health`, `/metrics`, `/slots` and benchmark remain functional.
12. Stop server and verify child tree is gone.
13. Kill server externally and verify `crashed`.
14. Save an invalid config, force failed restart, then restore the immutable last-known-good snapshot.

## Hardware
On the target RTX 5080 PC verify:
- correct GPU name;
- VRAM used/total;
- utilization;
- temperature;
- power draw/limit;
- clock;
- CPU/RAM values;
- graceful behavior if `nvidia-smi` is temporarily unavailable.

## Router integration
1. Confirm `--help` exposes `--models-preset`, `--models-max` and `--models-autoload`; verify the app disables router mode when required flags are missing.
2. Save multiple profiles and start router mode with the default loaded-model limit of one.
3. Inspect the generated app-data `router-presets.ini` and confirm every profile name maps to the intended GGUF and LaunchConfig options.
4. Verify `GET /v1/models` lists the profile names and `GET /health` reaches ready.
5. Submit an OpenAI-compatible request with `model` set to a second profile name; confirm llama.cpp unloads the first model and loads the requested one, and the runtime remains healthy.
6. Confirm a wrong model ID returns an API error without taking down the router; verify key-protected requests when a shared key is configured.
7. Save a router last-known-good snapshot, introduce a bad route/configuration, restart, restore the snapshot and verify the full profile set and settings return.
8. Stop the managed router and verify its process tree exits.

Do not load large models just to test CLI construction or endpoint discovery. For the model-switch test, use two small local GGUFs or perform it on the designated runtime test machine.

## Windows desktop integration
- native executable/file/folder/save dialogs;
- Open Web UI in default browser;
- Reveal model in Explorer;
- system tray left-click restores window;
- tray Show/Quit menu;
- close-to-tray;
- minimize-to-tray;
- Windows autostart enable/disable survives restart;
- Quit stops the managed server before app exit.

## UI/locale
- every primary view renders at 1280×720 and 1920×1080;
- Windows scaling 100/125/150%;
- switch EN ↔ RU without restart;
- Russian labels do not overflow important controls;
- setup wizard works in both languages;
- dirty config and restart dialog work;
- toasts, confirm dialogs and recovery banner work;
- log pause freezes the visible snapshot while collection continues.

## Benchmark caveat
Current benchmark prompt length is approximate and TTFT is based on non-streaming prompt timing. `/tokenize` calibration and streaming first-token timing are post-baseline refinements.
