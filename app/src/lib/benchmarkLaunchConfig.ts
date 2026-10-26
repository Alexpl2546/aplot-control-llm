import { DEFAULT_CONFIG, type LaunchConfig } from "../types/config";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const credential = (key: string) => {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return !normalized.includes("secretref") && (normalized.endsWith("apikey") || normalized.endsWith("token") || normalized.includes("password") || normalized.includes("secret") || normalized === "authorization");
};

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== "[redacted]").map(([key, child]) => [key, scrub(child)]));
}

/** Caller snapshots are redacted; keep credentials from the selected editor/profile. */
export function mergeBenchmarkLaunchConfig(base: LaunchConfig, changes: LaunchConfig): LaunchConfig {
  const merge = (original: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> => {
    const result = structuredClone(original);
    for (const [key, value] of Object.entries(update)) {
      if (credential(key) && (value === "" || value === undefined || value === "[redacted]")) continue;
      Object.defineProperty(result, key, { enumerable: true, writable: true, configurable: true,
        value: record(value) ? merge(record(original[key]) ? original[key] : {}, value) : structuredClone(value) });
    }
    return result;
  };
  return merge(base as unknown as Record<string, unknown>, changes as unknown as Record<string, unknown>) as unknown as LaunchConfig;
}

/** Extract editor reproduction data, never reinterpret authoritative run evidence. */
export function extractBenchmarkLaunchConfig(snapshot: unknown): LaunchConfig | undefined {
  if (!record(snapshot)) return undefined;
  let candidate = snapshot;
  if (Object.prototype.hasOwnProperty.call(snapshot, "run") || Object.prototype.hasOwnProperty.call(snapshot, "editorConfiguration")) {
    if (snapshot.editorConfigurationSource !== "caller" || !record(snapshot.run) || !record(snapshot.run.launch) || !record(snapshot.editorConfiguration)
      || typeof snapshot.run.runId !== "string" || typeof snapshot.run.engine !== "string" || !Number.isSafeInteger(snapshot.run.contextTokens)) return undefined;
    candidate = snapshot.editorConfiguration;
    if (typeof snapshot.run.contextTokens === "number" && candidate.ctxSize !== snapshot.run.contextTokens) return undefined;
    if ((candidate.engine ?? "llama_cpp") !== snapshot.run.engine) return undefined;
  } else if (Object.prototype.hasOwnProperty.call(snapshot, "launch") || Object.prototype.hasOwnProperty.call(snapshot, "runId")) return undefined;
  if (typeof candidate.profileId !== "string" || typeof candidate.profileName !== "string" || typeof candidate.modelPath !== "string"
    || !Number.isSafeInteger(candidate.ctxSize) || (candidate.ctxSize as number) <= 0
    || !Number.isSafeInteger(candidate.parallel) || (candidate.parallel as number) <= 0 || typeof candidate.fit !== "boolean") return undefined;
  const clean = scrub(candidate) as Record<string, unknown>;
  // Embedded CLI redactions cannot safely be reconstructed as a launch config.
  if (JSON.stringify(clean).includes("[redacted]")) return undefined;
  return { ...structuredClone(DEFAULT_CONFIG), ...clean } as LaunchConfig;
}
