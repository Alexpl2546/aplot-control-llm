# Windows build checklist

## Required software
- Windows 11 x64.
- Node.js 22.12 or newer (CI uses Node.js 22).
- npm.
- Rust stable MSVC toolchain.
- Visual Studio Build Tools 2022 with Desktop development with C++.
- WebView2 Runtime (normally present on Windows 11).
- NVIDIA driver and `nvidia-smi` for NVIDIA telemetry.

## One-command preflight
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-bootstrap.ps1
```
This checks Node/npm/Rust/Cargo, reports NVIDIA telemetry if present, installs locked npm dependencies with `npm ci`, runs TypeScript/static validation, `cargo check --locked` and frontend tests. Scripts stop on a failed command.

## Development
```powershell
npm run tauri:dev
```
Browser/mock UI is also available through:
```powershell
npm run dev
```

## Release verification + bundle
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-release.ps1
```
Equivalent manual commands:
```powershell
npm run typecheck
npm test
node .\scripts\validate-static.mjs
cargo test --locked --manifest-path .\src-tauri\Cargo.toml
cargo check --locked --manifest-path .\src-tauri\Cargo.toml
npm run build
npm run tauri:build
```

Expected bundle directory:
```text
src-tauri\target\release\bundle\
```

The executable is built in `src-tauri/target/release/`. The application source and dependency locks are published; inference engines and model weights are installed separately. See the root README and CHANGELOG for the current version and verification limits.

## Release acceptance
1. Real CUDA model lifecycle passes `docs/TEST_PLAN.md`.
2. Tray/autostart/opener/dialogs work on Windows 11.
3. RTX 5080 telemetry is correct.
4. Protected runtime endpoints work with API key.
5. Failed restart recovery restores last-known-good configuration.
6. RU/EN visual smoke tests pass at common DPI scales.
7. App icon, metadata and installer are polished.
8. Code-sign installer/executable when signing credentials are available.
