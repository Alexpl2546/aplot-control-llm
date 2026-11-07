# Agent tasks on the host

`src-tauri/src/tasks/` owns agent task sessions in the app process instead of the window. Codex, Claude and Hermes are moved. A Hermes task that starts its local server automatically still does that from the window before it sends the message; voice capture runs in the host's Hermes session and its frames are forwarded live without being journaled.

## Data

Task storage, approval transitions, the Codex event decoder and workspace persistence are shared through the Tauri-independent `aplot-core` crate. The `aplot_list_projects`, `aplot_list_agents` and `aplot_task_result` tools read persisted host data without waiting for the window. Reads require an active caller session and descendant ownership for task results; result polling is limited to 30 seconds. Delegation and agent proposals still use the window.

Migration 3 adds `agent_tasks`, `agent_messages`, `agent_turns`, `agent_commands`, `agent_approvals`, `agent_task_imports` and the `task_events(seq, task_id, kind, revision, at, payload)` journal. The legacy `events` table is unrelated. On first start the workspace snapshot is imported per runtime with IDs kept; `agent_tasks_rollback` writes the host history back into the snapshot.

## Commands

`agent_tasks_snapshot` returns tasks and a cursor; `agent_tasks_subscribe` replays events after the cursor over a channel, then streams. `agent_task_send` takes a client `commandId`; a repeat returns the first result. One turn runs per session; others wait in `agent_turns`. Approvals move `pending` → `approved`/`denied`/`expired`/`stale` and are bound to the worker generation.

## Codex controls

[CodexTaskControls.tsx](../../../src/features/agent/CodexTaskControls.tsx) adds steering of the active turn, review of uncommitted changes, and a child task created with fork. The host verifies the source account, project, worker generation, and active turn ID. Steering is distinct from a queued message. Repeating the same `commandId` does not dispatch another operation; an uncertain fork result is not automatically retried.

## Git and saved results

The Git panel shows the branch, changed files, and separate staged and unstaged diffs. Reads are scoped to the task project; external diff programs and textconv are disabled. The panel does not commit, reset, manage worktrees, or create pull requests.

The results panel saves a selected project file as an independent copy with a version, size, and SHA-256. The `aplot_save_artifact` tool is available to active agent sessions and accepts only a relative path; the host resolves the task identity. Removing a result deletes the managed copy and preserves the source. Saved copies remain accessible when the original project folder is unavailable; images support explicit preview.

Codex image-generation events appear as a tool. When Codex reports a completed image file inside the project, the host verifies its path, size, and signature and saves a result copy. A CLI feature does not establish availability for a particular model, account, or connection configuration.

## Project file library

The Project files panel uses the same library as chat: saved versions, search, original-copy export, and explicit removal. Files are not automatically copied into the task's working directory.

In new sessions, the internal `aplot_search_project_files` and `aplot_read_project_file` tools let the agent discover files and read bounded UTF-8/DOCX/XLSX text. The project comes from the task associated with the private token, and the host session must be active. The model cannot supply another project's ID or a working path. Contents are labeled as reference data rather than instructions or authorization. PDFs and images can be attached in chat; these tools do not extract their text.

## Agent document creation

The `aplot_create_document` tool builds DOCX/PDF from typed paragraphs, headings, lists, and tables, or XLSX from worksheets and cells. Results are saved to the current project's library without changing working files. The project comes from the active task associated with the private token rather than a model argument.

XLSX cells accept text, finite numbers, booleans, empty values, or explicit formulas. The limited subset supports arithmetic, current-sheet cell references, and SUM, AVERAGE, MIN, MAX, COUNT, ROUND, IF. External references, DDE, network and arbitrary functions are rejected. Aplot does not evaluate formulas or invent cached results; the workbook requests recalculation when opened in a spreadsheet editor. Ordinary strings beginning with `=` remain text.

## External MCP servers

A Codex project can configure a stdio server with an argument array or an HTTP server. Remote addresses require HTTPS; localhost may use HTTP. Credentials in arguments and URLs are rejected. Manual bearer tokens are stored by Aplot with Windows DPAPI and passed to Codex in the individual session configuration; the external runtime controls its own configuration storage separately.

Settings apply when creating, resuming, and forking sessions. Disabled and removed servers receive explicit disabled configurations with valid transports. Changes do not stop a server already used by an active session. Saving does not check connectivity; OAuth sign-in and server health diagnostics are not yet provided.
