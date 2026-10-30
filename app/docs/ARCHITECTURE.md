# Architecture

The maintained architecture guide is available [in English](en/architecture.md) and [in Russian](ru/architecture.md).

Aplot uses React/TypeScript and Zustand for the interface, typed Tauri services for IPC, Rust for native operations, and SQLite for persistent state. The current local engines are llama.cpp and Strata.

See also [the code map](en/code-map.md), [agent tasks](en/modules/agent-tasks.md), [run management](en/modules/runs.md) and [persistent data](DATA_MODEL.md).
