<a id="current-evidence"></a>
# Benchmarks and evidence

## Current behavior

The application stores results in SQLite and starts scenarios through the current store/Rust benchmark flow. Methods and payloads are in [PerformanceView.tsx](../../src/views/PerformanceView.tsx), [benchmarkOptimizer.ts](../../src/lib/benchmarkOptimizer.ts), and `src-tauri/src/benchmark.rs`. Suites can measure throughput, recall, and continuity; availability depends on the engine and model.

Managed runs use a cancellable job wrapper: it listens for job events, polls `list_jobs`, then loads the persisted result by `benchmarkId` from `list_benchmarks`. Auto tune runs each candidate on a temporary managed run and cancels its current job when requested. Legacy, unmanaged server sessions retain the older benchmark path.

The native `start_benchmark_job` wrapper uses `prepare_registration` and `run_registered_job` in [jobs.rs](../../src-tauri/src/jobs.rs). The same core accepts explicit DB/job managers and an optional AppHandle, allowing isolated native tests without a GUI. A missing AppHandle suppresses app events; it does not replace queueing, measurement, cancellation, or persistence with a mock implementation.

## Configuration snapshot sources

Managed `BenchmarkResult.configSnapshot` is an envelope `{ run, editorConfiguration, editorConfigurationSource: "caller" }`. `run` is the authoritative, redacted native `RunRequest` captured under the run lease. `editorConfiguration` is the redacted caller's `LaunchConfig`, or null when absent; it is editor data, not proof that the active engine used those values. Both fields remove secrets. Job evidence separately retains the authoritative configuration and completed samples.

Consumers must extract and validate the editor configuration before applying a result or using optimizer comparisons. A bare `RunRequest` has an engine-specific `launch` object and cannot be applied as a `LaunchConfig`. Legacy results may still contain a bare editor configuration; compatibility helpers must distinguish these shapes. Refer to [jobs](modules/jobs.md) and [runs](modules/runs.md) for ownership and immutable request behavior.

## Limits on conclusions

Each result belongs to a specific engine, model, parameters, endpoint, and time. A comparison is meaningful only with comparable input, generation, context, warm-up, and background load. Results from one engine do not transfer to another, and missing optional telemetry does not mean zero load.

Hardware peaks are system-wide. They can include other applications and external activity; the benchmark does not isolate or subtract that load. Cancellation drops the client HTTP future and keeps completed samples in the job evidence, but it cannot guarantee that every engine aborts the server-side generation immediately.

## Connection check

`verifyConnectionTarget` is a short reachability check with one streamed generation; it is not a benchmark, does not measure performance, and does not persist a result. A separate CPU smoke test covers only its endpoint and model; it does not validate Strata, GPU, tools, vision, or long context. Those scenarios need separate runs for meaningful evaluation.

## Native job evidence

The parent passed the full registered-core cancellation fixture: discovery → persisted queued job → completed first sample → stalled second HTTP request → cancellation → persisted cancelled partial evidence → released run lease → stop. The socket closes, the first sample survives, and no successful BenchmarkResult is created for cancellation. This checks the actual shared native core with a fixture endpoint and isolated in-memory DB.

A real CPU llama.cpp job also completed with one measured sample and a persisted benchmark whose ID matches the job's benchmarkId. It uses the authoritative-run/caller-editor snapshot envelope and labels counters system-wide. These checks establish native core execution/persistence; browser event delivery, Tauri IPC invocation, UI cancellation/result loading, and GPU/multi-engine acceptance still require desktop scenarios.

## Historical baseline

Pre-restructuring baseline evidence is saved under `app/artifacts/restructuring/baseline`; it is a separate historical snapshot. It does not mean those checks were rerun after the new frontend changes.
