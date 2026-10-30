# Validation

Run commands from `app`. Browser previews use mock services; native behavior needs the desktop application or isolated Rust tests.

## Automated checks

```powershell
npm run build
npm test
npm run verify:source
npm run verify:docs
npm run verify:modules
python -m unittest discover -s tests -p "test_*.py"
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

The [CI workflow](../../.github/workflows/ci.yml) also checks installer components, builds the Windows package and runs installer/maintenance acceptance scripts. Browser interaction suites and their Playwright configurations are in `app/e2e` and `app/playwright.*.config.ts`.

## Desktop acceptance

- Start two small local models on separate managed runs. Check automatic port selection, readiness, independent stop/restart and generation changes.
- Exercise llama.cpp native routing with supported binary flags, multiple saved profiles and a protected API endpoint. Confirm profile names match API model identifiers.
- Prepare a Strata model, select its configuration and check startup, chat and metrics. Test vision separately with a compatible projector/model.
- Download a small public GGUF, pause/resume it and verify that incomplete files stay outside the library. Check model removal with shared dependencies.
- Run a benchmark and cancel another after a completed sample. Confirm partial evidence and release of the run lease; verify recovery after a failed restart.
- Create an agent task for each installed runtime. Check queued messages, approvals, interruption, window reload and persisted history. Use isolated test accounts and folders where appropriate.
- Bind a test Markdown vault, search and read notes, then check reindexing after edits without changing source files from the app.
- Check chat history, attachments, local voice input and per-model reasoning controls with compatible providers.
- Verify the custom file picker, keyboard shortcuts under different layouts, light mode, mini-window, tray behavior and application shutdown.
- Check navigation, translations, light/dark themes and common Windows DPI settings. Confirm unsupported telemetry is shown as unavailable.

Record the application/engine versions, model and configuration, commands, outcomes and any limitations when validating a release. A passing source or mock test does not establish native GPU behavior.
