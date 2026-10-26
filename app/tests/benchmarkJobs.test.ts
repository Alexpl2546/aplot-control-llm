import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_BENCHMARKS } from "../src/mocks/runtime";
import type { BenchmarkRequest } from "../src/types/app";
import type { JobInfo } from "../src/types/jobs";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

import { BenchmarkJobCancelledError } from "../src/types/jobs";
import { runBenchmarkJob } from "../src/services/tauri";

const queued: JobInfo = { jobId: "job-1", runId: "run-a", generation: 7, engine: "llama_cpp", status: "queued", createdAt: "now", updatedAt: "now", evidence: {} };

describe("benchmark job bridge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    tauriMocks.listeners = {};
    tauriMocks.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
      tauriMocks.listeners[name] = callback;
      return tauriMocks.unlisten;
    });
  });

  it("subscribes before start, resolves by benchmark ID, and removes listeners", async () => {
    const running = { ...queued, status: "running" };
    const completed = { ...queued, status: "completed", benchmarkId: MOCK_BENCHMARKS[0].id };
    const progress = { jobId: queued.jobId, runId: queued.runId, generation: queued.generation, progress: { phase: "sample", completed: 1, total: 1, sample: MOCK_BENCHMARKS[0].samples[0] } };
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "start_benchmark_job") {
        tauriMocks.listeners["job://state"]?.({ payload: running });
        tauriMocks.listeners["job://progress"]?.({ payload: progress });
        return queued;
      }
      if (command === "list_jobs") return [completed];
      if (command === "list_benchmarks") return MOCK_BENCHMARKS;
      throw new Error(`Unexpected command ${command}`);
    });
    const callbacks = { onStarted: vi.fn(), onState: vi.fn(), onProgress: vi.fn() };
    const request: BenchmarkRequest = { promptTokens: 128, generationTokens: 16, runs: 1 };

    const result = await runBenchmarkJob("run-a", request, callbacks);

    expect(result).toEqual(MOCK_BENCHMARKS[0]);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_benchmark_job", { runId: "run-a", request });
    expect(callbacks.onStarted).toHaveBeenCalledWith(queued);
    expect(callbacks.onState.mock.calls.map(([job]) => job.status)).toEqual(["queued", "running", "completed"]);
    expect(callbacks.onProgress).toHaveBeenCalledWith(progress);
    expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2);
  });

  it("rejects a cancelled job and still removes its subscriptions", async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "start_benchmark_job") return queued;
      if (command === "list_jobs") return [{ ...queued, status: "cancelled" }];
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runBenchmarkJob("run-a", { promptTokens: 128, generationTokens: 16, runs: 1 })).rejects.toBeInstanceOf(BenchmarkJobCancelledError);
    expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2);
  });
});
