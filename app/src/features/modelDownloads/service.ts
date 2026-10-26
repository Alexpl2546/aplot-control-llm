import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../services/tauri";
import type { DownloadPlan, DownloadSearchPage, ModelSearchOptions, DownloadSelection, DownloadTask, DownloadVariant, ResolvedDownload } from "./types";
import { isDownloadTask } from "./rules";

type TaskListener = (task: DownloadTask) => void;
const demoTasks = new Map<string, DownloadTask>();
const demoListeners = new Set<TaskListener>();
let demoTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

const demoFiles = [
  { path: "demo-chat-3b-q4_k_m.gguf", sizeBytes: 1_720_000_000, role: "model" as const, quantization: "Q4_K_M" },
  { path: "demo-chat-8b-q4_k_m-00001-of-00002.gguf", sizeBytes: 2_440_000_000, role: "model" as const, quantization: "Q4_K_M" },
  { path: "demo-chat-8b-q4_k_m-00002-of-00002.gguf", sizeBytes: 2_380_000_000, role: "shard" as const, quantization: "Q4_K_M" },
  { path: "demo-chat-mmproj-f16.gguf", sizeBytes: 642_000_000, role: "mmproj" as const },
];
const demoVariants: DownloadVariant[] = [
  { id: "demo-q4-single", label: "Demo Chat 3B · Q4_K_M", files: [demoFiles[0].path], totalBytes: demoFiles[0].sizeBytes, complete: true },
  { id: "demo-q4-split", label: "Demo Chat 8B · Q4_K_M · 2 files", files: [demoFiles[1].path, demoFiles[2].path], totalBytes: demoFiles[1].sizeBytes + demoFiles[2].sizeBytes, complete: true },
  { id: "demo-incomplete", label: "Demo Chat 8B · incomplete example", files: [demoFiles[1].path], totalBytes: demoFiles[1].sizeBytes, complete: false },
];

function demoResolved(source: string): ResolvedDownload {
  const trimmed = source.trim();
  const repository = trimmed.match(/huggingface\.co\/(?:[^/]+\/)?([^/?#]+\/[^/?#]+)/i)?.[1]
    ?? trimmed.match(/^([\w.-]+\/[\w.-]+)$/)?.[1]
    ?? "demo/model-repository";
  return {
    source: trimmed || "demo/model-repository",
    repoId: repository,
    revision: "demo-revision-2026-10-22",
    publisher: repository.split("/")[0],
    repositoryUrl: `https://huggingface.co/${repository}`,
    licenseUrl: `https://huggingface.co/${repository}/blob/demo-revision-2026-10-22/LICENSE`,
    files: demoFiles,
    variants: demoVariants,
    suggestedFile: demoFiles[0].path,
  };
}

function publishDemo(task: DownloadTask) {
  demoTasks.set(task.id, task);
  for (const listener of demoListeners) listener(task);
}

function scheduleDemo(task: DownloadTask) {
  const previous = demoTimers.get(task.id);
  previous?.forEach(clearTimeout);
  const timers = [
    setTimeout(() => publishDemo({ ...task, sequence: task.sequence + 1, state: "downloading", downloadedBytes: Math.floor(task.totalBytes * 0.42), speedBytesPerSecond: 18_500_000, currentFile: task.plan.files[0]?.path, updatedAt: new Date().toISOString() }), 450),
    setTimeout(() => publishDemo({ ...task, sequence: task.sequence + 2, state: "verifying", downloadedBytes: task.totalBytes, speedBytesPerSecond: 0, currentFile: undefined, updatedAt: new Date().toISOString() }), 1000),
    setTimeout(() => publishDemo({ ...task, sequence: task.sequence + 3, state: "installing", downloadedBytes: task.totalBytes, updatedAt: new Date().toISOString() }), 1450),
    setTimeout(() => publishDemo({ ...task, sequence: task.sequence + 4, state: "completed", downloadedBytes: task.totalBytes, installedPath: task.plan.finalPath, verification: "size", updatedAt: new Date().toISOString() }), 1900),
  ];
  demoTimers.set(task.id, timers);
}

export async function resolveModelDownload(source: string): Promise<ResolvedDownload> {
  if (!isTauri()) return demoResolved(source);
  return invoke<ResolvedDownload>("resolve_model_download", { source });
}

export async function searchModelDownloads(query: string, options: ModelSearchOptions = {}): Promise<DownloadSearchPage> {
  if (isTauri()) return invoke<DownloadSearchPage>("search_model_downloads", { query: query.trim(), engine: "llama_cpp", limit: 20, cursor: options.cursor, sort: options.sort ?? 'downloads', allGguf: options.allGguf ?? false });
  const items = ["Qwen/Qwen3-4B-GGUF", "Qwen/Qwen3-8B-GGUF", "ggml-org/gemma-3-4b-it-GGUF"]
    .filter(repoId => !query.trim() || repoId.toLowerCase().includes(query.trim().toLowerCase()))
    .map(repoId => ({ repoId, publisher: repoId.split("/")[0], repositoryUrl: `https://huggingface.co/${repoId}`, downloads: 0, likes: 0, tags: ["gguf"], gated: false, parameterCount: repoId.includes('8B') ? 8e9 : 4e9, contextLength: 32768, sizeBytes: repoId.includes('8B') ? 4.7 * 2**30 : 2.5 * 2**30, architecture: repoId.includes('gemma') ? 'gemma3' : 'qwen3' }));
  return { items, nextCursor: null };
}

export async function modelDownloadDestination(engine: 'llama_cpp' | 'strata' = 'llama_cpp'): Promise<string> {
  if (!isTauri()) return `C:/Aplot/models/${engine === 'strata' ? 'strata' : 'llama'}`;
  return invoke<string>("model_download_destination", { engine });
}

export async function prepareModelDownload(selection: DownloadSelection, destination: string): Promise<DownloadPlan> {
  if (!isTauri()) {
    const resolved = demoResolved(selection.source);
    const byPath = new Map(resolved.files.map(file => [file.path, file]));
    const files = [...new Set(selection.files)].map(path => {
      const file = byPath.get(path);
      if (!file) throw new Error(`The selected file is not in the demo repository: ${path}`);
      return file;
    });
    const id = crypto.randomUUID();
    const safeRepo = resolved.repoId.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-");
    const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    return { planId: id, source: resolved.source, repoId: resolved.repoId, revision: resolved.revision, files, destination, finalPath: `${destination.replace(/[\\/]+$/, "")}/${safeRepo}`, totalBytes, availableBytes: 50_000_000_000, warnings: [] };
  }
  return invoke<DownloadPlan>("prepare_model_download", { selection, destination });
}

export async function startModelDownload(planId: string, plan: DownloadPlan): Promise<DownloadTask> {
  if (isTauri()) return invoke<DownloadTask>("start_model_download", { planId });
  const now = new Date().toISOString();
  const task: DownloadTask = { id: crypto.randomUUID(), sequence: 1, state: "queued", plan, downloadedBytes: 0, totalBytes: plan.totalBytes, speedBytesPerSecond: 0, createdAt: now, updatedAt: now };
  publishDemo(task);
  scheduleDemo(task);
  return task;
}

export async function listModelDownloads(): Promise<DownloadTask[]> {
  if (!isTauri()) return [...demoTasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return invoke<DownloadTask[]>("list_model_downloads");
}

export async function getModelDownload(id: string): Promise<DownloadTask> {
  if (!isTauri()) {
    const task = demoTasks.get(id);
    if (!task) throw new Error("Demo download not found.");
    return task;
  }
  return invoke<DownloadTask>("get_model_download", { id });
}

async function taskAction(command: string, id: string): Promise<DownloadTask> {
  if (isTauri()) return invoke<DownloadTask>(command, { id });
  const task = await getModelDownload(id);
  const now = new Date().toISOString();
  const sequence = task.sequence + 1;
  const next = command === "pause_model_download"
    ? { ...task, sequence, state: "paused" as const, speedBytesPerSecond: 0, updatedAt: now }
    : command === "resume_model_download"
      ? { ...task, sequence, state: "queued" as const, error: undefined, updatedAt: now }
      : command === "cancel_model_download"
        ? { ...task, sequence, state: "cancelled" as const, speedBytesPerSecond: 0, updatedAt: now }
        : { ...task, sequence, downloadedBytes: 0, currentFile: undefined, updatedAt: now };
  demoTimers.get(id)?.forEach(clearTimeout);
  demoTimers.delete(id);
  publishDemo(next);
  if (command === "resume_model_download") scheduleDemo(next);
  return next;
}

export function pauseModelDownload(id: string) { return taskAction("pause_model_download", id); }
export function resumeModelDownload(id: string) { return taskAction("resume_model_download", id); }
export function cancelModelDownload(id: string) { return taskAction("cancel_model_download", id); }
export function removeModelDownloadPartial(id: string) { return taskAction("remove_model_download_partial", id); }

export async function listenForModelDownloads(onTask: (task: DownloadTask) => void): Promise<() => void> {
  if (isTauri()) return listen<DownloadTask>("download://updated", event => { if (isDownloadTask(event.payload)) onTask(event.payload); });
  demoListeners.add(onTask);
  return () => demoListeners.delete(onTask);
}
