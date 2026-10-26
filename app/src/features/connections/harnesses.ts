import type { ConnectionTarget } from "../../services/connections";

export type HarnessId = "hermes" | "deepseek-harness" | "pi" | "openclaw";
export type HarnessMergeMode = "snippet-only" | "json-provider-add";

export interface HarnessAdapterRegistration {
  id: HarnessId;
  displayName: string;
  schemaId: string;
  docsUrl: string;
  configLocation: string;
  mergeMode: HarnessMergeMode;
  schemaReviewedAt: string;
  applyEnabled: false;
  smokeTested: false;
}

/** These entries version the schemas reviewed for snippets; they do not claim a tested harness installation. */
export const HARNESS_REGISTRY_VERSION = 1;
export const HARNESS_ADAPTERS: readonly HarnessAdapterRegistration[] = [
  {
    id: "hermes",
    displayName: "Hermes Agent",
    schemaId: "hermes.config.custom-openai-endpoint.2026-10-11",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/integrations/providers/",
    configLocation: "~/.hermes/config.yaml",
    mergeMode: "snippet-only",
    schemaReviewedAt: "2026-10-11",
    applyEnabled: false,
    smokeTested: false,
  },
  {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    schemaId: "deepseek-harness.cordis-patch.llm-pi-ai.2026-10-11",
    docsUrl: "https://deepseek-harness.github.io/deepseek-harness/en/guide/providers",
    configLocation: "$DSH_HOME/profiles/<profile>/cordis.patch.yml",
    mergeMode: "snippet-only",
    schemaReviewedAt: "2026-10-11",
    applyEnabled: false,
    smokeTested: false,
  },
  {
    id: "pi",
    displayName: "Pi coding agent",
    schemaId: "pi.models-json.openai-completions.2026-10-11",
    docsUrl: "https://pi.dev/docs/latest/models",
    configLocation: "~/.pi/agent/models.json",
    mergeMode: "json-provider-add",
    schemaReviewedAt: "2026-10-11",
    applyEnabled: false,
    smokeTested: false,
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    schemaId: "openclaw.models-providers.openai-completions.2026-10-11",
    docsUrl: "https://docs.openclaw.ai/concepts/model-providers/custom-providers",
    configLocation: "OpenClaw config or agent models.json",
    mergeMode: "json-provider-add",
    schemaReviewedAt: "2026-10-11",
    applyEnabled: false,
    smokeTested: false,
  },
];

const providerId = "aplot-local";
const apiKeyEnv = "APLOT_API_KEY";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function targetIsUsable(target: ConnectionTarget): void {
  if (target.protocol !== "openai-chat-completions") throw new Error("No template is registered for this connection protocol.");
  if (!target.baseUrl.trim() || !target.modelId.trim()) throw new Error("A base URL and exact API model ID are required for a template.");
}

export interface HarnessSnippet {
  adapter: HarnessAdapterRegistration;
  text: string;
  notes: string[];
}

export function renderHarnessSnippet(id: HarnessId, target: ConnectionTarget): HarnessSnippet {
  targetIsUsable(target);
  const adapter = HARNESS_ADAPTERS.find(item => item.id === id);
  if (!adapter) throw new Error(`Unknown harness adapter: ${id}`);
  const contextLine = target.contextTokens > 0 ? String(target.contextTokens) : undefined;
  const hasKey = Boolean(target.apiKey);
  let text: string;
  let notes: string[];

  switch (id) {
    case "hermes": {
      text = [
        "model:",
        `  default: ${yamlString(target.modelId)}`,
        "  provider: custom",
        `  base_url: ${yamlString(target.baseUrl)}`,
        ...(contextLine ? [`  context_length: ${contextLine}`] : []),
        ...(hasKey ? [`  key_env: ${apiKeyEnv}`] : []),
      ].join("\n");
      notes = ["Merge these keys into the existing model section manually; the preview does not retain your current model values."];
      break;
    }
    case "deepseek-harness": {
      text = [
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        `      ${providerId}:`,
        "        displayName: Aplot local",
        ...(hasKey ? [`        apiKeyEnv: ${apiKeyEnv}`] : []),
        "        api: openai-completions",
        `        baseURL: ${yamlString(target.baseUrl)}`,
        "        models:",
        `          - id: ${yamlString(target.modelId)}`,
        ...(contextLine ? [`            contextWindow: ${contextLine}`] : []),
      ].join("\n");
      notes = ["Insert under the existing llm-pi-ai config entry and preserve its other config fields and providers."];
      break;
    }
    case "pi": {
      const config = {
        providers: {
          [providerId]: {
            baseUrl: target.baseUrl,
            api: "openai-completions",
            ...(hasKey ? { apiKey: `$${apiKeyEnv}` } : {}),
            models: [{ id: target.modelId, ...(contextLine ? { contextWindow: target.contextTokens } : {}) }],
          },
        },
      };
      text = JSON.stringify(config, null, 2);
      notes = ["This is an additive provider fragment. Pi loads compatible endpoints from models.json."];
      break;
    }
    case "openclaw": {
      const config = {
        models: {
          mode: "merge",
          providers: {
            [providerId]: {
              baseUrl: target.baseUrl,
              ...(hasKey ? { apiKey: `\u0024{${apiKeyEnv}}` } : {}),
              api: "openai-completions",
              models: [{ id: target.modelId, name: "Aplot local", ...(contextLine ? { contextWindow: target.contextTokens, contextTokens: target.contextTokens } : {}) }],
            },
          },
        },
      };
      text = JSON.stringify(config, null, 2);
      notes = ["This adds provider metadata only. Select the provider/model in OpenClaw separately if you want it to be the default."];
      break;
    }
  }

  return {
    adapter,
    text,
    notes: [...notes, ...(hasKey ? [`The snippet references ${apiKeyEnv}; it never contains the configured key.`] : ["No key is configured in the active Aplot target; no credential field was added."])],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function providerPath(id: HarnessId): string[] | undefined {
  if (id === "pi") return ["providers"];
  if (id === "openclaw") return ["models", "providers"];
  return undefined;
}

export type ConfigMergeStatus = "added" | "already-present" | "conflict" | "unsupported" | "invalid";

export interface JsonProviderMergePreview {
  adapterId: HarnessId;
  status: ConfigMergeStatus;
  path: string;
  providerId: string;
  proposedProvider: Record<string, unknown>;
  mergedConfig?: Record<string, unknown>;
  detail: string;
}

/** Pure JSON-object preview. It never reads or writes a harness file and refuses to replace an existing provider. */
export function previewJsonProviderMerge(
  id: HarnessId,
  existingConfig: unknown,
  target: ConnectionTarget,
): JsonProviderMergePreview {
  targetIsUsable(target);
  const path = providerPath(id);
  const adapter = HARNESS_ADAPTERS.find(item => item.id === id);
  let providerMap: unknown;
  if (id === "pi" || id === "openclaw") {
    const rendered: unknown = JSON.parse(renderHarnessSnippet(id, target).text);
    if (id === "pi" && isRecord(rendered) && isRecord(rendered.providers)) providerMap = rendered.providers[providerId];
    if (id === "openclaw" && isRecord(rendered) && isRecord(rendered.models) && isRecord(rendered.models.providers)) {
      providerMap = rendered.models.providers[providerId];
    }
  }
  if (!adapter || !path || !isRecord(providerMap)) {
    return { adapterId: id, status: "unsupported", path: path?.join(".") ?? "", providerId, proposedProvider: {}, detail: "This YAML schema supports snippet preview only; structural merge is unavailable." };
  }
  if (!isRecord(existingConfig)) {
    return { adapterId: id, status: "invalid", path: path.join("."), providerId, proposedProvider: cloneJson(providerMap), detail: "Paste a JSON object to preview a structural provider merge." };
  }
  const output = cloneJson(existingConfig);
  let parent: Record<string, unknown> = output;
  for (const key of path.slice(0, -1)) {
    const value = parent[key];
    if (value === undefined) parent[key] = {};
    else if (!isRecord(value)) {
      return { adapterId: id, status: "conflict", path: `${path.slice(0, -1).join(".")}.${key}`, providerId, proposedProvider: cloneJson(providerMap), detail: `Cannot merge: ${key} is present with a non-object value.` };
    }
    parent = parent[key] as Record<string, unknown>;
  }
  const mapKey = path[path.length - 1];
  const map = parent[mapKey];
  if (map === undefined) parent[mapKey] = {};
  else if (!isRecord(map)) {
    return { adapterId: id, status: "conflict", path: path.join("."), providerId, proposedProvider: cloneJson(providerMap), detail: `Cannot merge: ${path.join(".")} is present with a non-object value.` };
  }
  const providers = parent[mapKey] as Record<string, unknown>;
  const existingProvider = providers[providerId];
  const providerPathValue = `${path.join(".")}.${providerId}`;
  if (existingProvider !== undefined) {
    if (deepEqual(existingProvider, providerMap)) {
      return { adapterId: id, status: "already-present", path: providerPathValue, providerId, proposedProvider: cloneJson(providerMap), mergedConfig: cloneJson(existingConfig), detail: "The exact provider already exists; the preview is idempotent." };
    }
    return { adapterId: id, status: "conflict", path: providerPathValue, providerId, proposedProvider: cloneJson(providerMap), detail: "A provider with this ID already exists and differs. Review it manually; this preview will not overwrite it." };
  }
  providers[providerId] = cloneJson(providerMap);
  return { adapterId: id, status: "added", path: providerPathValue, providerId, proposedProvider: cloneJson(providerMap), mergedConfig: output, detail: "The preview adds one provider and preserves the other JSON fields and providers." };
}

export interface JsonProviderUndoPreview {
  status: "removed" | "already-absent" | "conflict" | "unsupported";
  path: string;
  config?: Record<string, unknown>;
  detail: string;
}

/** Pure undo simulation for an added-provider preview; later edits to that provider are a conflict. */
export function previewJsonProviderUndo(
  preview: JsonProviderMergePreview,
  currentConfig: unknown,
): JsonProviderUndoPreview {
  if (preview.status === "unsupported" || preview.status === "invalid") {
    return { status: "unsupported", path: preview.path, detail: "No structural undo plan exists for this schema." };
  }
  if (preview.status === "already-present") {
    return { status: "already-absent", path: preview.path, config: isRecord(currentConfig) ? cloneJson(currentConfig) : undefined, detail: "The preview did not add or own this provider, so undo leaves it unchanged." };
  }
  if (preview.status === "conflict") return { status: "conflict", path: preview.path, detail: "The merge preview was conflicted and has no undo operation." };
  const path = providerPath(preview.adapterId);
  if (!path || !isRecord(currentConfig)) return { status: "conflict", path: preview.path, detail: "The current JSON config cannot be inspected safely." };
  const output = cloneJson(currentConfig);
  let parent: Record<string, unknown> = output;
  for (const key of path.slice(0, -1)) {
    const value = parent[key];
    if (!isRecord(value)) return { status: "already-absent", path: preview.path, config: output, detail: "The provider path is already absent; undo is idempotent." };
    parent = value;
  }
  const map = parent[path[path.length - 1]];
  if (!isRecord(map) || map[preview.providerId] === undefined) {
    return { status: "already-absent", path: preview.path, config: output, detail: "The provider is already absent; undo is idempotent." };
  }
  if (!deepEqual(map[preview.providerId], preview.proposedProvider)) {
    return { status: "conflict", path: preview.path, detail: "The provider changed after preview; undo leaves those edits untouched." };
  }
  delete map[preview.providerId];
  return { status: "removed", path: preview.path, config: output, detail: "The unchanged preview-added provider was removed; other config fields were preserved." };
}
