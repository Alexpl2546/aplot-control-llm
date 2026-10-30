# Tauri IPC contract

The maintained command reference is available [in English](en/ipc.md) and [in Russian](ru/ipc.md).

Registered native commands are defined in `src-tauri/src/lib.rs`. Typed frontend services live in `src/services` and individual feature bridges. `npm run validate:static` checks literal frontend invokes against registered handlers.

Module contracts: [runs](en/modules/runs.md), [agent tasks](en/modules/agent-tasks.md), [downloads](en/modules/model-downloads.md), [profiles](en/modules/profiles.md) and [connections](en/modules/connections.md).
