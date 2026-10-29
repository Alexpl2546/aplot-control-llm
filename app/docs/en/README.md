<a id="docs-index"></a>
# Aplot Control LLM documentation

This guide describes the code that exists today and marks future contracts separately. It covers the current desktop application and does not imply a UI redesign.

## Sections

- [Overview](overview.md) — product purpose and current implementation boundaries.
- [Architecture](architecture.md) — the UI → service → Tauri → backend flow.
- [Code map](code-map.md) — entry files and end-to-end paths.
- [Learning path](learning-path.md) — a practical reading order for the repository.
- [Configuration](configuration.md) — settings sources and connection rules.
- [IPC](ipc.md) — registered native commands and data contracts.
- [Profiles](modules/profiles.md) — versioned storage, secrets, revisions, and recovery.
- [Launch UI](modules/launches-ui.md) — profile selection and run actions.
- [Runs](modules/runs.md) — process ownership, generations, and isolated lifecycle.
- [Engine adapters](modules/engine-adapters.md) — engine-specific validation and preparation.
- [Models](modules/models.md) — artifacts, consumers, and conservative removal preview.
- [Model downloads](modules/model-downloads.md) — Hugging Face GGUF, queueing, verification, and set publication.
- [Resources](modules/resources.md) — native advisory planning and uncertainty.
- [Jobs](modules/jobs.md) — measurements, cancellation, persistence, and evidence.
- [Connections](modules/connections.md) — ConnectionTarget, API checks, and legacy fallback.
- [Harnesses](modules/harnesses.md) — the versioned registry and safe previews.
- [Agent tasks](modules/agent-tasks.md) — host-owned sessions, event journal, commands and approvals.
- [Benchmarks](benchmarks.md) — current measurements and limits on interpretation.
- [Troubleshooting](troubleshooting.md) — symptoms, evidence sources, and next actions.

## Status of this edition

The [implementation status](../plans/IMPLEMENTATION_STATUS.en.md) records earlier slices. The current version supports exactly two local engine IDs: `llama_cpp` and `strata`. Saved profiles and external legacy files do not constitute active support; see [adapters](modules/engine-adapters.md) for import, export, and launch behavior.

Hugging Face GGUF downloads have a separate durable queue and install into the model library. The [download module](modules/model-downloads.md) describes the contract and limits. Completing a download does not mean Strata is configured or that a model will launch successfully.
