<a id="connection-contract"></a>
# Connections module

## Purpose and status

The module moves current data for a selected run into the API page and checks a minimal OpenAI-compatible path. Its files are [ConnectionPanel.tsx](../../../src/features/connections/ConnectionPanel.tsx), [services/connections.ts](../../../src/services/connections.ts), and the existing [ApiDocsView.tsx](../../../src/views/ApiDocsView.tsx).

The native backend registers `list_runs` and `run_connection`; the frontend consumes those commands to select one actual manager run. The manager list's `RunInfo` contract is defined in [runtime.ts](../../../src/types/runtime.ts) and [runs.rs](../../../src-tauri/src/runs.rs). On older backends that explicitly lack `list_runs`, the UI shows legacy single-run data. That compatibility path does not present a draft as an active run.

## ConnectionTarget contract

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | string | Stable run ID; legacy compatibility ID is `legacy-current`. |
| `engine` | string | One of the supported IDs: `llama_cpp` or `strata`. |
| `baseUrl` | string | HTTP(S) API URL normalized to the `/v1` suffix. |
| `modelId` | string | Exact model ID from the run API/route, not a filename or guessed alias. |
| `contextTokens` | number | Configured token count; zero means unknown. |
| `apiKey` | string | Bearer-auth secret; kept in memory only. |
| `protocol` | `openai-chat-completions` | The only protocol used by checks and templates in this edition. |
| `managed` | boolean | Service ownership; it is not equivalent to endpoint health. |

`run_connection({ runId })` is validated for all required fields, matching `runId`, an HTTP(S) URL without embedded credentials, and the supported protocol. The key is accepted only as a separate string. See the [service](../../../src/services/connections.ts) and [tests](../../../tests/connections.test.ts).

## Legacy target source

The fallback uses `runtime.endpoint`, the selected engine, runtime model name, and immutable `runningConfig`. Context comes from the running process snapshot. An unknown or legacy engine ID does not become a ConnectionTarget; the user must choose a supported profile explicitly. For a llama router, `profileName` is the route ID. Other saved profiles and card metadata are not read or exported.

The legacy target ID is `legacy-current`. Readiness comes separately from current runtime state. Only `ready` and `busy` allow network verification; `stopped`, `starting`, `loading`, `stopping`, `restarting`, and `crashed` are never labeled ready.

## Verification levels

`verifyConnectionTarget()` performs three separate requests. Each gets a timeout and the same AbortSignal:

1. `health`: GET `/health`.
2. `model-list`: GET `/v1/models`, then exact matching against `data[].id` or `models[].id/name`.
3. `stream`: POST `/v1/chat/completions` with the target model ID, `stream: true`, and a one-token test request. It checks HTTP errors, SSE JSON, error frames, and `[DONE]`.

Results stay in component memory until it unmounts. `404/405/501` and unknown list formats are `unsupported`; HTTP errors, wrong model ID, an error event, missing `[DONE]`, or timeout are `failed`; cancellation is `cancelled`. The overall result can be `passed`, `failed`, `partial`, or `cancelled`.

Diagnostics do not display raw response bodies because a server response could contain private data. Health/list and chat endpoints can vary by engine; a result applies only to that URL, model, and the three requests made. Successful generation does not prove tool calling, vision, or another API surface.

## Copying and secrets

The connection-fields button copies the base URL, exact model ID, configured context, and auth method without the key. The key has a separate explicit copy button. Harness snippets always use an environment reference instead of the key value and omit a credential field when the target key is empty.

Direct frontend fetch can be blocked by CORS. A configured `apiKey` does not guarantee that the webview origin is allowed. A real harness smoke test must run separately in the harness environment; it is not replaced by the frontend check.

## API reference and network environments

`ApiDocsView` passes the target endpoint/key/engine to the registered Rust `fetch_openapi_spec`. Rust loads the API reference for the selected supported engine and validates the address; frontend verification uses browser networking. These layers can therefore disagree.

`127.0.0.1`/`localhost` applies only within the app's namespace. For a harness in WSL, Docker, or another computer, the user must provide a reachable address. This implementation has no extra host/WSL addresses, reverse proxy, or gateway.

## RunInfo and integration limits

`list_runs` returns the native run manager's `RunInfo`: `runId`, `name`, `engine`, `mode`, `endpoint`, `modelId`, `contextTokens`, `state`, `generation`, `managed`, and optional `pid`, `startedAt`, and `lastError`. The panel currently projects run ID, engine, state, model ID, context, and endpoint for selection; the `run_connection` command resolves the selected run's actual API model ID and key. The command checks the run generation again after discovery so a target is not returned for a changed run.

Command registration is in [lib.rs](../../../src-tauri/src/lib.rs). Connection check results apply to the specific endpoint, model, and three requests performed. GUI acceptance and GPU scenarios are verified separately from unit tests. This connection task does not launch an external harness.

## Dependencies and limitations

The service imports Tauri `invoke` and `isTauri`, but not React/store. The UI assembles legacy context separately and passes a target callback. Profile database CRUD is not called. Results are not persistent.

The list consumer normalizes the RunInfo fields it uses, including Rust's `endpoint` as its display base URL and snake_case aliases. `run_connection` target fields are validated strictly. The panel loads the list when mounted and has an explicit refresh control that retains the selected run when it still exists; changes are not polled automatically.
