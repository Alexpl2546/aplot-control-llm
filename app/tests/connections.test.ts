import { describe, expect, it, vi } from "vitest";
import {
  buildLegacyConnectionTarget,
  fetchManagedRuns,
  isConnectionRunReady,
  isUnsupportedManagerCommand,
  ManagerCommandUnsupportedError,
  runConnectionTarget,
  verifyConnectionTarget,
  type ConnectionFetch,
  type ConnectionTarget,
} from "../src/services/connections";

const target: ConnectionTarget = {
  runId: "run-a",
  engine: "llama_cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  modelId: "coding-model",
  contextTokens: 8192,
  apiKey: "test-secret",
  protocol: "openai-chat-completions",
  managed: true,
};

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function streamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("run connection bridge", () => {
  it("uses an explicit legacy single-run target and appends the OpenAI API suffix", () => {
    const legacy = buildLegacyConnectionTarget({
      engine: "llama_cpp",
      endpoint: "http://127.0.0.1:8080/",
      modelId: "qwen3.8-flash-next",
      contextTokens: 32768,
      apiKey: "key",
      managed: true,
    });
    expect(legacy).toMatchObject({
      runId: "legacy-current",
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "qwen3.8-flash-next",
      contextTokens: 32768,
      managed: true,
    });
  });

  it("accepts manager run records using camelCase or Rust snake_case fields", async () => {
    const invokeCommand = vi.fn(async () => [{ run_id: "run-a", engine: "llama_cpp", state: "ready", model_id: "coding-model", context_tokens: 8192 }]);
    const listing = await fetchManagedRuns(invokeCommand);
    expect(listing).toEqual({ mode: "manager", runs: [{ runId: "run-a", engine: "llama_cpp", state: "ready", modelId: "coding-model", contextTokens: 8192 }] });
  });
  it("preserves the human server name independently of internal model/config paths", async () => {
    const listing = await fetchManagedRuns(async () => [{ runId: 'run-a', name: 'Flash Next · 128K', engine: 'strata', state: 'ready', modelId: 'C:/engine/model-config.json' }] as never);
    expect(listing.runs[0]).toMatchObject({ name: 'Flash Next · 128K' });
  });

  it("falls back only for an explicitly missing manager command", async () => {
    const unsupported = await fetchManagedRuns(async () => { throw new Error("Command list_runs not found"); });
    expect(unsupported).toEqual({ mode: "legacy", runs: [] });
    await expect(fetchManagedRuns(async () => { throw new Error("database is busy"); })).rejects.toThrow("database is busy");
    expect(isUnsupportedManagerCommand(new Error("Command run_connection not found"), "run_connection")).toBe(true);
    expect(isUnsupportedManagerCommand(new Error("Connection target is unavailable"), "run_connection")).toBe(false);
  });

  it("normalizes and validates the exact target returned for a run", async () => {
    const invokeCommand = vi.fn(async () => ({ ...target, baseUrl: "http://127.0.0.1:8080" }));
    const result = await runConnectionTarget("run-a", invokeCommand);
    expect(result.baseUrl).toBe("http://127.0.0.1:8080/v1");
    await expect(runConnectionTarget("run-b", async () => target)).rejects.toThrow("different run");
    await expect(runConnectionTarget("run-a", async () => { throw new Error("Command run_connection not found"); }))
      .rejects.toBeInstanceOf(ManagerCommandUnsupportedError);
  });

  it("checks health, exact model ID, and a successful SSE stream with the run key", async () => {
    const requests: Array<{ url: string; auth: string | null; body?: Record<string, unknown> }> = [];
    const fetcher: ConnectionFetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      let body: Record<string, unknown> | undefined;
      if (init?.body && typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ url, auth: headers.get("authorization"), body });
      if (url.endsWith("/health")) return okJson({ status: "ok" });
      if (url.endsWith("/models")) return okJson({ data: [{ id: "coding-model" }] });
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"."}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const result = await verifyConnectionTarget(target, { fetcher });
    expect(result.status).toBe("passed");
    expect(result.checks.map(check => check.level)).toEqual(["health", "model-list", "stream"]);
    expect(requests.map(request => request.url)).toEqual([
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/v1/models",
      "http://127.0.0.1:8080/v1/chat/completions",
    ]);
    expect(requests.every(request => request.auth === "Bearer test-secret")).toBe(true);
    expect(requests[2].body).toMatchObject({ model: "coding-model", stream: true, max_tokens: 1 });
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("reports an HTTP 200 SSE error frame as a model failure", async () => {
    const fetcher: ConnectionFetch = async input => {
      const url = String(input);
      if (url.endsWith("/health")) return okJson({});
      if (url.endsWith("/models")) return okJson({ data: [{ id: target.modelId }] });
      return streamResponse(['data: {"error":{"message":"private detail"}}\n\n']);
    };
    const result = await verifyConnectionTarget(target, { fetcher });
    expect(result.checks[2]).toMatchObject({ status: "failed", detail: "The server returned an error event in its streamed response." });
    expect(JSON.stringify(result)).not.toContain("private detail");
  });

  it("keeps unsupported levels distinct from failures", async () => {
    const fetcher: ConnectionFetch = async input => String(input).endsWith("/health")
      ? new Response("", { status: 404 })
      : String(input).endsWith("/models")
        ? new Response("", { status: 404 })
        : new Response("", { status: 404 });
    const result = await verifyConnectionTarget(target, { fetcher });
    expect(result.status).toBe("partial");
    expect(result.checks.map(check => check.status)).toEqual(["unsupported", "unsupported", "unsupported"]);
  });

  it("honors the per-request timeout", async () => {
    const fetcher: ConnectionFetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const result = await verifyConnectionTarget(target, { fetcher, timeoutMs: 5 });
    expect(result.status).toBe("failed");
    expect(result.checks[0].detail).toContain("timed out after 5 ms");
  });

  it("honors user cancellation and marks remaining checks cancelled", async () => {
    const controller = new AbortController();
    const fetcher: ConnectionFetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const resultPromise = verifyConnectionTarget(target, { fetcher, timeoutMs: 500, signal: controller.signal });
    controller.abort();
    const result = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(result.checks.every(check => check.status === "cancelled")).toBe(true);
  });

  it("only treats ready or busy runs as verifiable", () => {
    const legacy = buildLegacyConnectionTarget({ engine: "llama_cpp", endpoint: "http://127.0.0.1:8080", modelId: "x", contextTokens: 0, managed: true });
    expect(legacy?.runId).toBe("legacy-current");
    expect(legacy?.contextTokens).toBe(0);
    expect(isConnectionRunReady("stopped")).toBe(false);
    expect(isConnectionRunReady("starting")).toBe(false);
    expect(isConnectionRunReady("ready")).toBe(true);
    expect(isConnectionRunReady("busy")).toBe(true);
  });
});
