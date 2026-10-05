export function mergeModelDirectories(existing: string[], selected: string): string[] {
  const result = new Map<string, string>();
  for (const rawPath of [...existing, selected]) {
    const path = rawPath.trim();
    if (!path) continue;
    const key = path.replaceAll("/", "\\").replace(/[\\]+$/, "").toLocaleLowerCase();
    if (!result.has(key)) result.set(key, path);
  }
  return [...result.values()];
}
