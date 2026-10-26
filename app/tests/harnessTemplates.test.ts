import { describe, expect, it } from "vitest";
import {
  HARNESS_ADAPTERS,
  HARNESS_REGISTRY_VERSION,
  previewJsonProviderMerge,
  previewJsonProviderUndo,
  renderHarnessSnippet,
  type HarnessId,
} from "../src/features/connections/harnesses";
import type { ConnectionTarget } from "../src/services/connections";

const target: ConnectionTarget = {
  runId: "run-01",
  engine: "llama_cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  modelId: "llama-3.8-code",
  contextTokens: 65536,
  apiKey: "never-export-this-secret",
  protocol: "openai-chat-completions",
  managed: true,
};

describe("versioned harness templates", () => {
  it("records the reviewed adapter schemas without claiming install smoke tests", () => {
    expect(HARNESS_REGISTRY_VERSION).toBe(1);
    expect(HARNESS_ADAPTERS.map(adapter => adapter.id)).toEqual(["hermes", "deepseek-harness", "pi", "openclaw"]);
    expect(HARNESS_ADAPTERS.every(adapter => adapter.applyEnabled === false && adapter.smokeTested === false)).toBe(true);
  });

  it.each<HarnessId>(["hermes", "deepseek-harness", "pi", "openclaw"])("renders a %s snippet with exact target and no literal key", id => {
    const snippet = renderHarnessSnippet(id, target);
    expect(snippet.text).toContain(target.baseUrl);
    expect(snippet.text).toContain(target.modelId);
    expect(snippet.text).toContain("65536");
    expect(snippet.text).not.toContain(target.apiKey);
    expect(snippet.text).toContain("APLOT_API_KEY");
  });

  it("omits secret fields when the actual target is keyless", () => {
    const snippet = renderHarnessSnippet("openclaw", { ...target, apiKey: "" });
    expect(snippet.text).not.toContain("apiKey");
    expect(snippet.text).not.toContain("APLOT_API_KEY");
  });

  it("preserves unknown OpenClaw and provider fields in an additive JSON preview", () => {
    const initial = {
      env: { vars: { CUSTOM: "value" } },
      models: {
        mode: "merge",
        providers: { existing: { baseUrl: "https://example.invalid/v1", privateOption: { enabled: true } } },
        futureField: [1, 2],
      },
      agents: { defaults: { model: { primary: "existing/model" } } },
    };
    const preview = previewJsonProviderMerge("openclaw", initial, target);
    expect(preview.status).toBe("added");
    expect(preview.path).toBe("models.providers.aplot-local");
    expect(preview.mergedConfig).toMatchObject({
      env: initial.env,
      models: { mode: "merge", providers: { existing: initial.models.providers.existing }, futureField: [1, 2] },
      agents: initial.agents,
    });
    expect(initial.models.providers).not.toHaveProperty("aplot-local");
  });

  it("keeps merge previews idempotent and refuses to overwrite a colliding provider", () => {
    const existing = { providers: { keep: { api: "existing" } } };
    const first = previewJsonProviderMerge("pi", existing, target);
    expect(first.status).toBe("added");
    const second = previewJsonProviderMerge("pi", first.mergedConfig, target);
    expect(second.status).toBe("already-present");

    const collision = previewJsonProviderMerge("pi", { providers: { "aplot-local": { api: "custom" }, keep: { api: "existing" } } }, target);
    expect(collision.status).toBe("conflict");
    expect(collision.detail).toContain("will not overwrite");
  });

  it("simulates undo without removing user edits made after preview", () => {
    const initial = { providers: { other: { setting: 1 } }, misc: { keep: true } };
    const merge = previewJsonProviderMerge("pi", initial, target);
    expect(merge.status).toBe("added");
    const afterPreview = structuredClone(merge.mergedConfig!);
    afterPreview.misc.keep = false;
    const undo = previewJsonProviderUndo(merge, afterPreview);
    expect(undo.status).toBe("removed");
    expect(undo.config).toEqual({ providers: { other: { setting: 1 } }, misc: { keep: false } });

    const editedProvider = structuredClone(merge.mergedConfig!);
    (editedProvider.providers["aplot-local"] as Record<string, unknown>).extra = "user edit";
    const conflict = previewJsonProviderUndo(merge, editedProvider);
    expect(conflict.status).toBe("conflict");
    expect(conflict.config).toBeUndefined();
    expect(conflict.detail).toContain("changed after preview");
  });

  it("refuses structural merge for documented YAML schemas", () => {
    const result = previewJsonProviderMerge("hermes", {}, target);
    expect(result.status).toBe("unsupported");
    expect(result.detail).toContain("snippet preview only");
  });

  it("detects malformed JSON provider paths rather than replacing them", () => {
    const result = previewJsonProviderMerge("openclaw", { models: "user-value" }, target);
    expect(result.status).toBe("conflict");
    expect(result.detail).toContain("non-object");
  });
});
