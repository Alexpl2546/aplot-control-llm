import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadTask } from "../src/features/modelDownloads/types";

const downloadMocks = vi.hoisted(() => ({
  listModelDownloads: vi.fn(),
  listenForModelDownloads: vi.fn(),
  pauseModelDownload: vi.fn(),
  resumeModelDownload: vi.fn(),
  cancelModelDownload: vi.fn(),
  removeModelDownloadPartial: vi.fn(),
}));

vi.mock("../src/features/modelDownloads/service", () => downloadMocks);
vi.mock("../src/services/tauri", () => ({ isTauri: () => true }));

import { startModelDownloadMonitor, useModelDownloadStore } from "../src/features/modelDownloads/store";

function task(id: string, sequence: number, state: DownloadTask["state"] = "queued"): DownloadTask {
  const now = "2026-10-22T12:00:00.000Z";
  return {
    id, sequence, state,
    plan: { planId: `plan-${id}`, source: "owner/model", repoId: "owner/model", revision: "main", files: [], destination: "models", finalPath: `models/${id}`, totalBytes: 100, availableBytes: 1000, warnings: [] },
    downloadedBytes: sequence, totalBytes: 100, speedBytesPerSecond: 0,
    createdAt: now, updatedAt: now,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("model download store synchronization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useModelDownloadStore.setState({ tasks: [], loading: false, initialized: false, error: undefined, demoMode: false });
  });

  it("subscribes before reading the initial snapshot and keeps a newer event", async () => {
    const listenerReady = deferred<() => void>();
    const snapshotReady = deferred<DownloadTask[]>();
    const stop = vi.fn();
    let emit!: (value: DownloadTask) => void;
    downloadMocks.listenForModelDownloads.mockImplementation((listener: (value: DownloadTask) => void) => {
      emit = listener;
      return listenerReady.promise;
    });
    downloadMocks.listModelDownloads.mockReturnValue(snapshotReady.promise);

    const dispose = startModelDownloadMonitor();
    expect(downloadMocks.listModelDownloads).not.toHaveBeenCalled();

    listenerReady.resolve(stop);
    await vi.waitFor(() => expect(downloadMocks.listModelDownloads).toHaveBeenCalledOnce());
    emit(task("download-a", 2, "downloading"));
    snapshotReady.resolve([task("download-a", 1, "queued")]);
    await vi.waitFor(() => expect(useModelDownloadStore.getState().tasks[0]?.sequence).toBe(2));

    dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps event-only tasks and the highest sequence when merging a refresh snapshot", async () => {
    const eventOnly = task("event-only", 4, "downloading");
    const older = task("listed", 2, "queued");
    useModelDownloadStore.getState().applyTask(eventOnly);
    useModelDownloadStore.getState().applyTask(task("listed", 3, "downloading"));
    downloadMocks.listModelDownloads.mockResolvedValue([older, task("new-listed", 1)]);

    await useModelDownloadStore.getState().refresh();

    expect(useModelDownloadStore.getState().tasks.map(item => [item.id, item.sequence]).sort()).toEqual([
      ["event-only", 4], ["listed", 3], ["new-listed", 1],
    ]);
  });

  it("ignores duplicate sequence events", () => {
    useModelDownloadStore.getState().applyTask(task("download-a", 5, "downloading"));
    useModelDownloadStore.getState().applyTask(task("download-a", 5, "failed"));

    expect(useModelDownloadStore.getState().tasks).toMatchObject([{ id: "download-a", sequence: 5, state: "downloading" }]);
  });

  it("releases a listener that resolves after monitor cleanup without starting a snapshot read", async () => {
    const listenerReady = deferred<() => void>();
    const stop = vi.fn();
    downloadMocks.listenForModelDownloads.mockReturnValue(listenerReady.promise);

    const dispose = startModelDownloadMonitor();
    dispose();
    listenerReady.resolve(stop);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    expect(downloadMocks.listModelDownloads).not.toHaveBeenCalled();
  });
});
