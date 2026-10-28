# Agent tasks on the host

`src-tauri/src/tasks/` owns agent task sessions in the app process instead of the window. Codex is moved; Claude and Hermes still use the window path.

## Data

Migration 3 adds `agent_tasks`, `agent_messages`, `agent_turns`, `agent_commands`, `agent_approvals`, `agent_task_imports` and the `task_events(seq, task_id, kind, revision, at, payload)` journal. The legacy `events` table is unrelated. On first start the workspace snapshot is imported per runtime with IDs kept; `agent_tasks_rollback` writes the host history back into the snapshot.

## Commands

`agent_tasks_snapshot` returns tasks and a cursor; `agent_tasks_subscribe` replays events after the cursor over a channel, then streams. `agent_task_send` takes a client `commandId`; a repeat returns the first result. One turn runs per session; others wait in `agent_turns`. Approvals move `pending` → `approved`/`denied`/`expired`/`stale` and are bound to the worker generation.
