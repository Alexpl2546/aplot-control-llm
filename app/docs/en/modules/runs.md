<a id="run-manager"></a>
# Run management

## Purpose and source files

[runs.rs](../../../src-tauri/src/runs.rs) manages run lifetimes. [engine_adapters.rs](../../../src-tauri/src/engine_adapters.rs) validates options and prepares the engine command. [process.rs](../../../src-tauri/src/process.rs) creates and terminates the child process. [runtime.rs](../../../src-tauri/src/runtime.rs) normalizes observed metrics. Changing an engine CLI does not require changing run selection logic.

One application instance contains a `RunManager`. A run is identified by `runId`; replacing its process advances `generation`. Together these distinguish current work from delayed logs of an older process. Sharing a model or profile does not make two runs identical.

## Contracts

`RunRequest` contains `runId`, `name`, `engine`, `mode`, `modelId`, `contextTokens`, `autoPort`, and `launch`. The engine adapter parses the last field. The full request stays in memory; public `RunInfo` excludes `launch` and credentials.

| `RunInfo` field | Meaning |
| --- | --- |
| `runId`, `generation` | Logical action target and its incarnation |
| `engine`, `mode` | Engine and single/router mode |
| `endpoint`, `modelId`, `contextTokens` | Prepared run parameters; discovery additionally validates the actual API model ID |
| `state` | starting/loading/ready/busy/stopping/stopped/crashed |
| `pid`, `startedAt` | Child process and start timestamp |
| `managed` | Whether the run process belongs to the application; API readiness is checked separately |
| `lastError` | Latest process or observation error |

## Commands and actions

| Command | Arguments | Behavior |
| --- | --- | --- |
| `prepare_run` | `{request}` | Validates model/options and returns a description without spawning |
| `start_run` | `{request}` | Creates or starts a slot; the same active request returns the existing process |
| `list_runs` | — | Lists known runs and detects exited children |
| `stop_run` | `{runId}` | Stops only the target; repeated stop is harmless |
| `restart_run` | `{runId}` | Restarts the previous immutable request |
| `stop_all_runs` | — | Shuts down owned runs/services and aggregates errors |
| `run_runtime` | `{runId}` | Collects the target's metrics and rejects a changed generation |
| `run_connection` | `{runId}` | Queries `/v1/models` and returns a verified ConnectionTarget |

Editing settings does not change a running process. To apply a draft, the UI performs stop → prepare/start with a new snapshot. `restart_run` itself does not read current global settings.

## Automatic port selection

`autoPort` is optional and defaults to `false` for direct IPC callers, preserving strict collision errors. The UI enables it for llama.cpp (single/router) and Strata. The profile port is preferred: the manager checks it and then subsequent ports, up to 256 candidates before 65535. An OS bind probe skips ports occupied by external processes; the registry lock prevents concurrent application starts from choosing the same port.

The selected port updates the CLI, endpoint and run snapshot. `RunInfo.endpoint` is the actual address; the overview, selected run settings, API Docs and benchmarks use it. The saved profile is not rewritten. Repeating the original request returns the same active process; restart prefers the assigned port. `prepare_run` previews the preferred address without reserving a port.

The bind probe does not pass its socket to the child: an external program can claim the port between the probe and engine startup. That remains a launch error and releases the application's reservation.

## Locks and races

`runs` stores `Arc<RunSlot>`. Its registry lock is held only to obtain a slot. Process waits hold `RunSlot.operation`, rather than the registry. `RunSlot.data` protects the snapshot/RunInfo; `ProcessState` protects the child.

The port registry reserves a port atomically before spawning. Release removes only the current owner's entries. Conservative checks by port number prevent wildcard/loopback overlaps. Failed start releases its reservation and retains a crashed record for diagnostics.

A measurement owns an exclusive `activity` lease and its slot's lease. Start/stop/restart during a measurement fail with an instruction to cancel the benchmark. This prevents unnoticed configuration changes between samples. Completion drops the guards automatically.

## Router runs

Router runs have separate presets under `data/routers/run-…/router-presets.ini`. `owner.json` checks directory ownership; its derived name contains no user-supplied path. Writing an active run's preset is rejected.

The frontend [router.ts](../../../src/lib/router.ts) assigns API IDs consistently across the preset, launch request, connection panel and benchmarks. Unique profile names keep their existing ID. Duplicate names (case-insensitive) use `name--encoded-profile-id`; a further numeric suffix resolves collisions with explicitly named routes. Profile names and stored IDs are unchanged. Reordering profiles does not change the mapping. The running route list is a snapshot: editing, adding or deleting profiles takes effect after restart. Copy the discovered running ID from API Docs when connecting a client.

## Events and exit

`run://log` carries `{runId,generation,line}`. `run://state` carries `{runId,generation,state}`. The UI stores per-run logs/history and rejects old generations. Legacy `llama://…` remains for the compatibility facade and service messages.

Normal Quit first cancels jobs and records outcomes, then stops owned runs. Closing to tray leaves processes running. A persistent daemon and recovery of processes after an application crash are not implemented.

## Verification and limits

The ignored `real_multi_run_supervisor_smoke` test is explicitly enabled with `APLOT_SMOKE_BINARY` and `APLOT_SMOKE_MODEL`. It starts two CPU servers with the same preferred port, checks automatic separation, verifies both responses, duplicate start, port conflict, isolated stop/restart/crash, and full shutdown. `APLOT_SMOKE_REPORT` selects the report destination.

CPU process checks do not prove every model/GPU combination works. GPU/RAM telemetry remains system-wide. A separate planner assesses memory; process isolation does not promise that several large models fit.
