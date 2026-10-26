import type { DownloadFile, DownloadVariant, ResolvedDownload } from "./types";

export function selectedVariantFiles(variant: DownloadVariant | undefined): string[] {
  if (!variant || !variant.complete) return [];
  return [...new Set(variant.files)];
}

export function selectionFiles(variant: DownloadVariant | undefined, mmprojPath = ""): string[] {
  const files = selectedVariantFiles(variant);
  if (mmprojPath && !files.includes(mmprojPath)) files.push(mmprojPath);
  return files;
}

export function filesForSelection(resolved: ResolvedDownload, paths: readonly string[]): DownloadFile[] {
  const byPath = new Map(resolved.files.map(file => [file.path, file]));
  return [...new Set(paths)].map(path => {
    const file = byPath.get(path);
    if (!file) throw new Error(`The selected file is not in the resolved repository: ${path}`);
    return file;
  });
}

export function totalBytesForSelection(resolved: ResolvedDownload, paths: readonly string[]): number {
  return filesForSelection(resolved, paths).reduce((total, file) => total + file.sizeBytes, 0);
}

export function suggestedVariant(variants: readonly DownloadVariant[], suggestedFile?: string): string {
  const containingSuggestion = variants.find(variant => variant.complete && suggestedFile && variant.files.includes(suggestedFile));
  return containingSuggestion?.id ?? variants.find(variant => variant.complete)?.id ?? "";
}

export function isDownloadTask(value: unknown): value is import("./types").DownloadTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<import("./types").DownloadTask>;
  return typeof task.id === "string" && Number.isSafeInteger(task.sequence)
    && typeof task.state === "string" && typeof task.plan === "object" && task.plan !== null
    && Number.isFinite(task.downloadedBytes) && Number.isFinite(task.totalBytes)
    && typeof task.createdAt === "string" && typeof task.updatedAt === "string";
}
