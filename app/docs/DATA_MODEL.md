# Persistent data model

The application database is `llama-control.sqlite3`, with WAL enabled and a consistent backup at startup. A portable layout with `engines` and `models` uses its `data` directory; other installations use the Tauri application data directory. Debug acceptance runs can select an isolated directory with `APLOT_TEST_DATA_DIR`.

## Stores

| Store | Purpose | Implementation |
| --- | --- | --- |
| `profiles`, `kv`, `benchmarks`, `benchmark_suites`, `events` | Original profiles, settings, recovery snapshots and measurements | `src-tauri/src/db.rs` |
| `launch_profiles_v2`, `profile_secrets` | Versioned profiles and separately stored secrets | `src-tauri/src/migrations.rs`, `profile_store.rs` |
| `engine_scope_legacy_state` | Append-only archive for settings from retired engines | `src-tauri/src/migrations.rs` |
| `model_artifacts`, `artifact_files`, `artifact_consumers` | Rebuildable model inventory and dependencies | `src-tauri/src/migrations.rs`, `model_artifacts.rs` |
| `model_downloads`, `model_download_files`, `model_installations` | Download checkpoints and installed-file manifests | `src-tauri/src/downloads/repository.rs` |
| `execution_jobs` | Measurement lifecycle and partial results | `src-tauri/src/jobs.rs` |
| `agent_tasks`, `agent_messages`, `agent_turns`, `agent_commands`, `agent_approvals`, `agent_task_imports`, `task_events` | Host-owned agent sessions, queue, approvals and replay journal | `src-tauri/src/tasks/store.rs` |

Application migrations are additive and transactional; `app_schema_migrations` records their versions. A database newer than the supported schema is rejected. Runtime processes and active HTTP streams are not reconstructed from stored rows automatically.

## Knowledge index

`knowledge-index.sqlite3` is a separate derived index beside the application database. It stores documents, chunks, links and full-text indexes. Markdown vaults are read without modifying their source files; bindings are saved in the application database.

## Credentials and exports

Connection credentials and agent homes use a separate application-data location. Versioned profile secrets are stored separately from profile envelopes. Database files, credentials, local snapshots and generated router presets are excluded from the repository. Review exported profiles before sharing them.

See [profiles](en/modules/profiles.md), [jobs](en/modules/jobs.md), [agent tasks](en/modules/agent-tasks.md) and the [configuration guide](en/configuration.md).
