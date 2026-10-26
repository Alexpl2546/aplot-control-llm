<a id="execution-jobs"></a>
# Measurement jobs

## Responsibility

[jobs.rs](../../../src-tauri/src/jobs.rs) binds a measurement to an immutable llama.cpp or Strata run, implements cancellation, and stores its outcome. Throughput/recall/continuity algorithms remain in [benchmark.rs](../../../src-tauri/src/benchmark.rs). Switching views does not cancel a native job. Model downloads use their separate queue and do not acquire a benchmark run lease.

## Contract and execution order

`start_benchmark_job({runId,request})` returns `JobInfo` after registration and persistence of the queued record. `JobInfo` contains `jobId`, `runId`, `generation`, `engine`, `status`, `createdAt`, `updatedAt`, `benchmarkId`, `error`, and `evidence`.

1. The manager obtains the run lease and the exclusive measurement lease. Other managed runs must be stopped/crashed.
2. Configuration is copied from the backend run request. The UI's supplied snapshot is not treated as authoritative.
3. `/v1/models` validates the model ID. Router measurements require an explicitly selected model.
4. SQLite receives the queued job; asynchronous execution follows.
5. A task-local `Scope` adds jobId/runId/generation to progress and collects completed samples.
6. The record is checkpointed every second. completed/failed/cancelled is persisted before releasing the lease.

## States and events

| State | Meaning |
| --- | --- |
| queued | Accepted, snapshot recorded |
| running | Measurement executing |
| cancelling | Cancellation requested |
| cancelled | HTTP future dropped; completed samples retained |
| completed | BenchmarkResult persisted; `benchmarkId` references it |
| failed | Measurement or persistence failed |
| interrupted | An unfinished job was found during application startup |

`job://progress` carries `{jobId,runId,generation,progress}`. `job://state` carries full `JobInfo`. Legacy `benchmark-progress` is suppressed inside the task-local scope so one job cannot replace another monitor. `list_jobs()` reads the latest 100 records and overlays active in-memory states.

## Cancellation and recovery

`cancel_job({jobId})` sends a watch signal. Repeated cancellation of a finished job is harmless. Cancellation wins in `tokio::select!`, dropping the HTTP wait and stream reader. Guards are released after persisting the outcome.

The `cancellation_drops_a_stalled_http_request_and_keeps_prior_sample` test finishes the first request and stalls the second. Cancellation closes that socket, retains the first measurement, and creates no successful BenchmarkResult. This does not guarantee immediate compute cancellation in every third-party engine: a server may keep working after disconnect.

On startup, queued/running/cancelling records in `execution_jobs` become interrupted while retaining the latest checkpoint. They are not automatically resumed because the previous process and HTTP stream may no longer exist.

## Evidence and limits

IPC uses a shared native core: `prepare_registration` acquires the lease, validates model ID and stores queued; `run_registered_job` executes, checkpoints and persists the outcome. Both are also tested without AppHandle. The real CPU test `real_registered_job_persists_a_native_model_result` launches Qwen2.5 0.5B, obtains one throughput sample and checks that `benchmarkId` matches its SQLite record. The full cancellation test `registered_job_cancel_records_partial_evidence_and_releases_run_lease` exercises the same core, retains the first sample and releases the lease. This proves the native core; complete GUI acceptance remains a separate scenario.

In `BenchmarkResult.configSnapshot`, `run` contains the redacted actual RunRequest. `editorConfiguration` separately stores supplied editor settings labelled `editorConfigurationSource: "caller"`; they do not replace actual evidence. Frontend `benchmarkLaunchConfig.ts` accepts old flat snapshots and the new wrapper after shape, engine and context validation. A bare RunRequest cannot be used as LaunchConfig. Exact redaction markers are removed; CLI text containing embedded redaction cannot reconstruct a profile.

`evidence` stores public RunInfo, redacted configuration/request, isolation mode, and completed samples. `public_snapshot` removes nested credential values and CLI `--api-key value`/`--token=value`. Secrets stay in request memory and the Authorization header.

RAM/VRAM/GPU counters are system-wide. Stopping other managed runs reduces interference but does not exclude external processes. Evidence retains `hardwareCounters=system-wide`. A legacy result's peak may be the maximum of sampled observations rather than a continuously observed absolute peak.

The lease does not mutate profiles or unload peer models automatically. Autotune uses a separate trial run and restores the working run. Restoration failures must remain visible instead of being hidden by a successful recommendation.

## Reading route

Start with `start_benchmark_job`, then `RunManager::measurement_lease`, the task-local Scope, `execute_suite`, `persist`, and the frontend job bridge. `execution_jobs` does not replace `benchmarks`: the former stores lifecycle and partial evidence; the latter stores finished results. See [run management](runs.md) and [benchmarks](../benchmarks.md).
