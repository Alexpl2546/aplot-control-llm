# Code map

## Frontend orchestration
- `src/App.tsx` — initialization, polling, events, tray lifecycle, setup/recovery/toasts and view routing.
- `src/store/control.ts` — application state and product actions.
- `src/services/tauri.ts` — typed Tauri bridge plus browser mocks.
- `src/services/desktop.ts` — autostart, tray, close/minimize-to-tray, opener.
- `src/services/dialog.ts` — native executable/GGUF/folder/profile/save pickers.

## Domain/config logic
- `src/types/config.ts` — LaunchConfig and llama capabilities.
- `src/types/runtime.ts` — normalized runtime/hardware/slot/log/history types.
- `src/types/app.ts` — app settings, profiles, models, benchmarks and notices.
- `src/lib/parameters.ts` — central parameter registry.
- `src/lib/cli.ts` — argv and PowerShell/CMD/Bash preview.
- `src/lib/capabilities.ts` — `--help`/version parser.
- `src/lib/configDiff.ts` — restart diff engine.
- `src/lib/resources.ts` — architecture-aware estimator.
- `src/lib/validation.ts` — config safety/errors.
- `src/lib/models.ts` — ModelInfo → LaunchConfig metadata mapping.
- `src/lib/history.ts`, `format.ts`, `i18n.ts` — support utilities.

## UI
- `src/views/*` — seven primary screens.
- `src/components/config/*` — editor, resource estimate, CLI preview and restart dialog.
- `src/components/runtime/*` — server/hardware/inference/recovery widgets.
- `src/components/setup/SetupWizard.tsx` — first-run setup.
- `src/components/feedback/ToastHost.tsx` — notices.
- `src/components/ui/*` — primitives and confirm dialog.
- `src/components/LogPanel.tsx` — reusable live log viewer.
- `src/index.css` — application visual system/layout.

## Rust/Tauri
- `src-tauri/src/lib.rs` — builder/plugins/state/commands and Rust-owned quit.
- `process.rs` — managed llama-server lifecycle.
- `runtime.rs` — aggregate process + HTTP + hardware snapshot.
- `llama.rs` — runtime HTTP and binary detection.
- `hardware.rs` — NVIDIA/sysinfo telemetry.
- `db.rs` — SQLite schema/event recording.
- `profiles.rs` — CRUD/import/export/immutable known-good snapshot.
- `settings.rs` — settings persistence/default migration.
- `models.rs` — recursive model discovery.
- `gguf.rs` — lightweight bounded GGUF metadata parser.
- `benchmark.rs` — completion benchmark/history.
- `strata.rs`, `ollama.rs`, `qwfnfer.rs` — engine-specific validation, launch and telemetry adapters.
- `model_library.rs`, `engine_integration.rs` — shared library operations and Ollama integration.

## Validation/tooling
- `tests/*` — Vitest domain tests.
- `scripts/validate-static.mjs` — i18n + frontend invoke/Rust-handler consistency.
- `scripts/windows-bootstrap.ps1` — Windows dependency/build preflight.
- `scripts/windows-release.ps1` — release verification/build.
- `tsconfig.core.json` — strict domain logic compile.
- `tsconfig.validate.json` — full-source static check using installed npm dependencies.
