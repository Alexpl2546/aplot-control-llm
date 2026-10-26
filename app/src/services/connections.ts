import { invoke } from "@tauri-apps/api/core";
import { isTauri, listRuns, getRunConnection } from "./tauri";

export type ConnectionProtocol = "openai-chat-completions";

/** A connection description for one concrete run. apiKey is kept only in in-memory UI/service state. */
export interface ConnectionTarget {
  runId: string;
  engine: string;
  baseUrl: string;
  modelId: string;
  contextTokens: number;
  apiKey: string;
  protocol: ConnectionProtocol;
  managed: boolean;
}

export interface ManagedRunInfo {
  runId: string;
  name?: string;
  engine: string;
  state: string;
  modelId?: string;
  contextTokens?: number;
  baseUrl?: string;
  managed?: boolean;
}

export type RunListing =
  | { mode: "manager"; runs: ManagedRunInfo[] }
  | { mode: "legacy"; runs: [] };

export type InvokeCommand = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

// These optional commands are used only when the run manager exposes them; older builds fall back on command-not-registered errors.
const MANAGER_COMMANDS = { listRuns: "list_runs", connectionTarget: "run_connection" } as const;

export class ManagerCommandUnsupportedError extends Error {
  constructor(command: string) {
    super(`The current desktop backend does not register ${command}; legacy single-run information is available.`);
    this.name = "ManagerCommandUnsupportedError";
  }
}

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}

/** Tauri's exact wording varies by version. Only command-registration errors qualify for legacy fallback. */
export function isUnsupportedManagerCommand(error: unknown, command: string): boolean {
  const message = errorText(error).toLowerCase();
  const name = command.toLowerCase();
  return message.includes(name) && (
    /unknown command|command.{0,30}(not found|does not exist|not registered|unavailable)|(?:not found|does not exist|not registered).{0,30}command/.test(message)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalField(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function normalizeRunList(value: unknown): ManagedRunInfo[] {
  const rows = Array.isArray(value) ? value : record(value)?.runs;
  if (!Array.isArray(rows)) throw new Error("list_runs returned an unsupported response shape.");
  return rows.map((entry, index) => {
    const row = record(entry);
    const runId = row && textField(optionalField(row, "runId", "run_id"));
    const engine = row && textField(row.engine);
    if (!row || !runId || !engine) throw new Error(`list_runs returned an invalid run at index ${index}.`);
    const modelId = textField(optionalField(row, "modelId", "model_id"));
    const contextTokens = numberField(optionalField(row, "contextTokens", "context_tokens"));
    const baseUrl = textField(optionalField(row, "baseUrl", "base_url")) ?? textField(row.endpoint);
    const managed = typeof row.managed === "boolean" ? row.managed : undefined;
    return {
      runId,
      ...(textField(row.name) ? { name: textField(row.name) } : {}),
      engine,
      state: textField(row.state) ?? "unknown",
      ...(modelId ? { modelId } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(managed !== undefined ? { managed } : {}),
    };
  });
}

export async function hermesAvailable(): Promise<boolean> {
  return isTauri() ? invoke<boolean>('hermes_available') : false;
}
export async function openInHermes(runId: string): Promise<{ sessionId: string; modelId: string }> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke('open_in_hermes', { runId });
}

export async function listManagedRuns(invokeCommand: InvokeCommand = invoke): Promise<RunListing> {
  if (!isTauri()) return { mode: "manager", runs: normalizeRunList(await listRuns()) };
  return fetchManagedRuns(invokeCommand);
}

export async function fetchManagedRuns(invokeCommand: InvokeCommand): Promise<RunListing> {
  try {
    return { mode: "manager", runs: normalizeRunList(await invokeCommand(MANAGER_COMMANDS.listRuns)) };
  } catch (error) {
    if (isUnsupportedManagerCommand(error, MANAGER_COMMANDS.listRuns)) return { mode: "legacy", runs: [] };
    throw error;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("Connection URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Credentials must be provided separately from the connection URL.");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (!/\/v1$/i.test(url.pathname)) url.pathname = `${url.pathname === "/" ? "" : url.pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}

function parseConnectionTarget(value: unknown, expectedRunId: string): ConnectionTarget {
  const row = record(value);
  if (!row) throw new Error("run_connection returned an unsupported response shape.");
  const runId = textField(optionalField(row, "runId", "run_id"));
  const engine = textField(row.engine);
  const baseUrl = textField(optionalField(row, "baseUrl", "base_url"));
  const modelId = textField(optionalField(row, "modelId", "model_id"));
  const contextTokens = numberField(optionalField(row, "contextTokens", "context_tokens"));
  const protocol = row.protocol;
  if (runId !== expectedRunId) throw new Error("run_connection returned a target for a different run.");
  if (!engine || !baseUrl || !modelId || contextTokens === undefined || typeof row.managed !== "boolean") {
    throw new Error("run_connection returned an incomplete connection target.");
  }
  if (protocol !== "openai-chat-completions") throw new Error("This run does not expose the supported OpenAI Chat Completions protocol.");
  if (row.apiKey !== undefined && row.apiKey !== null && typeof row.apiKey !== "string") {
    throw new Error("run_connection returned an invalid API key field.");
  }
  return {
    runId,
    engine,
    baseUrl: normalizeBaseUrl(baseUrl),
    modelId,
    contextTokens,
    apiKey: typeof row.apiKey === "string" ? row.apiKey : "",
    protocol,
    managed: row.managed,
  };
}

export async function runConnectionTarget(
  runId: string,
  invokeCommand: InvokeCommand = invoke,
): Promise<ConnectionTarget> {
  if (!isTauri() && invokeCommand === invoke) return parseConnectionTarget(await getRunConnection(runId), runId);
  try {
    return parseConnectionTarget(await invokeCommand(MANAGER_COMMANDS.connectionTarget, { runId }), runId);
  } catch (error) {
    if (isUnsupportedManagerCommand(error, MANAGER_COMMANDS.connectionTarget)) throw new ManagerCommandUnsupportedError(MANAGER_COMMANDS.connectionTarget);
    throw error;
  }
}

export function isConnectionRunReady(state: string): boolean {
  return state === "ready" || state === "busy";
}

export interface LegacyTargetInput {
  engine: string;
  endpoint: string;
  modelId: string;
  contextTokens: number;
  apiKey?: string;
  managed: boolean;
}

/** Compatibility target for the existing single-server UI; it is never inferred from saved profile metadata. */
export function buildLegacyConnectionTarget(input: LegacyTargetInput): ConnectionTarget | null {
  if (!input.endpoint.trim() || !input.modelId.trim() || !Number.isFinite(input.contextTokens) || input.contextTokens < 0) return null;
  try {
    return {
      runId: "legacy-current",
      engine: input.engine,
      baseUrl: normalizeBaseUrl(input.endpoint),
      modelId: input.modelId.trim(),
      contextTokens: input.contextTokens,
      apiKey: input.apiKey ?? "",
      protocol: "openai-chat-completions",
      managed: input.managed,
    };
  } catch {
    return null;
  }
}

export type CheckLevel = "health" | "model-list" | "stream";
export type CheckStatus = "passed" | "failed" | "unsupported" | "cancelled";
export interface ConnectionCheck {
  level: CheckLevel;
  status: CheckStatus;
  detail: string;
}
export interface ConnectionVerification {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "partial" | "cancelled";
  checks: ConnectionCheck[];
}
export type ConnectionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VerifyConnectionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: ConnectionFetch;
}

function urls(target: ConnectionTarget) {
  const api = new URL(target.baseUrl);
  const apiPath = api.pathname.replace(/\/+$/, "");
  const root = new URL(target.baseUrl);
  if (/\/v1$/i.test(root.pathname)) root.pathname = root.pathname.replace(/\/v1$/i, "") || "/";
  else root.pathname = root.pathname.replace(/\/+$/, "") || "/";
  root.search = "";
  root.hash = "";
  api.pathname = apiPath;
  api.search = "";
  api.hash = "";
  return { root: root.toString().replace(/\/$/, ""), api: api.toString().replace(/\/$/, "") };
}

class ProbeFailure extends Error {
  constructor(readonly status: CheckStatus, message: string) {
    super(message);
  }
}

async function performProbe<T>(
  level: CheckLevel,
  target: ConnectionTarget,
  url: string,
  options: VerifyConnectionOptions,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  requestInit: RequestInit = {},
): Promise<{ result: T } | { check: ConnectionCheck }> {
  if (options.signal?.aborted) return { check: { level, status: "cancelled", detail: "Cancelled before request." } };
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 8000);
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const headers = new Headers({ Accept: "application/json", ...(requestInit.headers ?? {}) });
  if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`);
  try {
    const response = await (options.fetcher ?? fetch)(url, { ...requestInit, method: requestInit.method ?? "GET", headers, signal: controller.signal });
    return { result: await consume(response, controller.signal) };
  } catch (error) {
    if (error instanceof ProbeFailure) return { check: { level, status: error.status, detail: error.message } };
    if (options.signal?.aborted) return { check: { level, status: "cancelled", detail: "Cancelled by the user." } };
    if (timedOut) return { check: { level, status: "failed", detail: `Request timed out after ${timeoutMs} ms.` } };
    if (controller.signal.aborted) return { check: { level, status: "cancelled", detail: "Request was cancelled." } };
    return { check: { level, status: "failed", detail: "Network request failed; the endpoint may be unreachable or blocked by browser CORS policy." } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

function httpResult(response: Response, level: CheckLevel): ConnectionCheck | undefined {
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { level, status: "unsupported", detail: `HTTP ${response.status}; this endpoint is not exposed by the engine.` };
  }
  if (response.status === 401 || response.status === 403) {
    return { level, status: "failed", detail: `HTTP ${response.status}; the API rejected the configured authentication.` };
  }
  if (!response.ok) return { level, status: "failed", detail: `HTTP ${response.status}.` };
  return undefined;
}

async function checkHealth(target: ConnectionTarget, options: VerifyConnectionOptions): Promise<ConnectionCheck> {
  const { root } = urls(target);
  const outcome = await performProbe("health", target, `${root}/health`, options, async response => {
    const error = httpResult(response, "health");
    if (error) throw new ProbeFailure(error.status, error.detail);
    return { level: "health", status: "passed", detail: `HTTP ${response.status} from /health.` } satisfies ConnectionCheck;
  });
  return "check" in outcome ? outcome.check : outcome.result;
}

function modelIds(payload: unknown): string[] | undefined {
  const row = record(payload);
  const data = Array.isArray(row?.data) ? row.data : Array.isArray(row?.models) ? row.models : undefined;
  if (!data) return undefined;
  return data.map(item => {
    const model = record(item);
    return model ? textField(model.id) ?? textField(model.name) : undefined;
  }).filter((id): id is string => Boolean(id));
}

async function checkModelList(target: ConnectionTarget, options: VerifyConnectionOptions): Promise<ConnectionCheck> {
  const { api } = urls(target);
  const outcome = await performProbe("model-list", target, `${api}/models`, options, async response => {
    const error = httpResult(response, "model-list");
    if (error) throw new ProbeFailure(error.status, error.detail);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { return { level: "model-list", status: "unsupported", detail: "The endpoint did not return a JSON model list." } satisfies ConnectionCheck; }
    const ids = modelIds(payload);
    if (!ids) return { level: "model-list", status: "unsupported", detail: "The response does not use a recognized OpenAI model-list shape." } satisfies ConnectionCheck;
    return ids.includes(target.modelId)
      ? { level: "model-list", status: "passed", detail: `The live model list contains ${target.modelId}.` } satisfies ConnectionCheck
      : { level: "model-list", status: "failed", detail: `The live model list does not contain ${target.modelId}.` } satisfies ConnectionCheck;
  });
  return "check" in outcome ? outcome.check : outcome.result;
}

async function readStream(response: Response, signal: AbortSignal): Promise<ConnectionCheck> {
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { level: "stream", status: "unsupported", detail: `HTTP ${response.status}; chat completions are not exposed.` };
  }
  if (response.status === 401 || response.status === 403) {
    return { level: "stream", status: "failed", detail: `HTTP ${response.status}; the API rejected the configured authentication.` };
  }
  if (!response.ok) return { level: "stream", status: "failed", detail: `HTTP ${response.status}.` };
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return { level: "stream", status: "unsupported", detail: "The endpoint accepted the request but did not return an event stream." };
  }
  if (!response.body) return { level: "stream", status: "unsupported", detail: "The response has no readable stream." };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "";
  let sawDone = false;
  const consumeFrame = () => {
    if (eventName === "error") throw new ProbeFailure("failed", "The server returned an error event in its streamed response.");
    if (!dataLines.length) { eventName = ""; return; }
    const data = dataLines.join("\n");
    dataLines = [];
    eventName = "";
    if (data.trim() === "[DONE]") { sawDone = true; return; }
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { throw new ProbeFailure("failed", "The stream contained an invalid JSON event."); }
    if (record(payload)?.error != null) throw new ProbeFailure("failed", "The server returned an error event in its streamed response.");
  };
  try {
    while (!sawDone) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) consumeFrame();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    consumeFrame();
    return sawDone
      ? { level: "stream", status: "passed", detail: "The streamed chat request reached [DONE] without an error event." }
      : { level: "stream", status: "failed", detail: "The stream closed before the OpenAI [DONE] marker." };
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function checkStream(target: ConnectionTarget, options: VerifyConnectionOptions): Promise<ConnectionCheck> {
  const { api } = urls(target);
  const outcome = await performProbe("stream", target, `${api}/chat/completions`, options, async (response, signal) => {
    const error = httpResult(response, "stream");
    if (error) throw new ProbeFailure(error.status, error.detail);
    return readStream(response, signal);
  }, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: target.modelId,
      messages: [{ role: "user", content: "Reply with a single period." }],
      max_tokens: 1,
      stream: true,
    }),
  });
  return "check" in outcome ? outcome.check : outcome.result;
}

function summarize(checks: ConnectionCheck[]): ConnectionVerification["status"] {
  if (checks.length && checks.every(check => check.status === "cancelled")) return "cancelled";
  if (checks.every(check => check.status === "passed")) return "passed";
  if (checks.some(check => check.status === "failed")) return "failed";
  return "partial";
}

export async function verifyConnectionTarget(
  target: ConnectionTarget,
  options: VerifyConnectionOptions = {},
): Promise<ConnectionVerification> {
  const startedAt = new Date().toISOString();
  const checks: ConnectionCheck[] = [];
  for (const check of [checkHealth, checkModelList, checkStream]) {
    if (options.signal?.aborted) {
      checks.push({ level: check === checkHealth ? "health" : check === checkModelList ? "model-list" : "stream", status: "cancelled", detail: "Cancelled before request." });
      continue;
    }
    checks.push(await check(target, options));
  }
  return { runId: target.runId, startedAt, finishedAt: new Date().toISOString(), status: summarize(checks), checks };
}
