<a id="adapter-registry"></a>
# Harness adapters

## Scope

`features/connections/harnesses.ts` contains registry schema version 1 and four pure config previews: Hermes Agent, DeepSeek Harness, Pi coding agent, and OpenClaw. A preview does not discover an installation, open a config file, or apply a write. Every adapter has `applyEnabled=false` and `smokeTested=false`.

“DeepSeek Harness” here means DeepSeek's official open-source project (`deepseek-ai/deepseek-harness`), not a generic “harness for a DeepSeek model.” “Pi” means the Pi coding agent at official `pi.dev`, not another product named Pi.

| Adapter ID | Documented path/format | Preview |
| --- | --- | --- |
| `hermes` | `~/.hermes/config.yaml`, custom OpenAI-compatible endpoint | YAML snippet for `model.default`, `provider`, `base_url`, `context_length`; `key_env` only when a key is configured |
| `deepseek-harness` | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, `llm-pi-ai` provider map | YAML fragment with `api: openai-completions`, `baseURL`, model ID/context, and optional `apiKeyEnv` |
| `pi` | `~/.pi/agent/models.json`, `providers` | JSON provider with `baseUrl`, `api`, model, and optional env-interpolated `apiKey` |
| `openclaw` | OpenClaw config or agent `models.json`, `models.providers` | JSON-compatible fragment with `baseUrl`, `api`, model ID, `contextWindow`, and `contextTokens` |

The current schema version records official docs reviewed on October 11, 2026; its version ID does not pin an installed app version. The adapter does not discover installed versions, paths, network environments, or user CLI commands.

## Official sources

- [Hermes Agent — provider setup](https://hermes-agent.nousresearch.com/docs/integrations/providers/): custom endpoint, `config.yaml`, `context_length`, and `key_env`.
- [DeepSeek Harness — configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers): custom model API and `cordis.patch.yml`; keys use credential references.
- [Pi — choose a model](https://pi.dev/docs/latest/models) and [custom providers](https://pi.dev/docs/latest/custom-provider): `models.json`, `openai-completions`, and environment interpolation.
- [OpenClaw — custom providers](https://docs.openclaw.ai/concepts/model-providers/custom-providers): provider map, `openai-completions`, and model metadata.

## JSON merge preview

Pi and OpenClaw support a pure structural merge on a JSON object:

1. Only provider ID `aplot-local` is added at the documented path.
2. Unknown root fields, neighboring providers, and their settings are copied into the preview unchanged.
3. Repeating the preview with the same provider ID/value is idempotent.
4. If that provider ID already has different content or a path is not an object, the result is `conflict`; replacement is refused.
5. Preview undo removes only the exact provider added by the plan. If the provider changed after preview, undo refuses and preserves that edit.

These helpers use a structure supplied by the caller and do not read or write config files. They accept strict JSON objects; they do not parse JSON5 comments or YAML. The UI redacts secret-like fields from the displayed result; this is a review-only preview, not a ready-to-apply file.

Hermes and DeepSeek Harness get snippets without structural merge. Their YAML must be manually merged with the existing `model` or `llm-pi-ai.config`, preserving unknown fields and comments. Field names were checked against official docs; the parser from an installed release was not run.

## Authentication and actual status

The target secret is never inserted into snippets. When a key is configured, templates reference `APLOT_API_KEY`; setting that variable in the harness remains an explicit user action. For a keyless target, the auth field is omitted.

No external harness was installed or modified. Previews produce a manual snippet/config merge plan only. Harness-side model, streaming, tool-calling, and context checks remain pending. These adapters must not be described as automatic, applied, or verified integrations.

## Tests and adding an adapter

`harnessTemplates.test.ts` covers all four snippets, key exclusion, unknown JSON preservation, idempotency, provider collision, and undo after a concurrent edit. Add an adapter only after checking its official schema: record `schemaId`, source URL, and config location; keep `applyEnabled=false` and `smokeTested=false` by default; use no-secret templates; and test merge/undo for formats the code actually supports.
