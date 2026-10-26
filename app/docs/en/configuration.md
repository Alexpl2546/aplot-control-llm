<a id="connection-settings"></a>
# Connection configuration

## Value sources

The manager `ConnectionTarget` comes from the active `run_connection`. A compatibility target for the current single-run mode is built from the runtime snapshot, engine settings, and immutable `runningConfig` when available. Editable drafts and the saved profile catalog are not used as a list of active connections.

## Current target fields

| Parameter | Value and source |
| --- | --- |
| `runId` | ID of one run; fallback uses `legacy-current`. |
| `engine` | Engine for the selected run. |
| `baseUrl` | API base URL; the frontend normalizes a root address to `/v1`. |
| `modelId` | Actual API model ID, or the active route/profile name for a router. |
| `contextTokens` | Configured context from the runtime snapshot; `0` is shown as unknown. |
| `apiKey` | Key for the current target; hidden and excluded from templates. |
| `protocol` | Supported target contract: `openai-chat-completions`. |
| `managed` | Backend ownership flag for the selected run. |

## Engine settings

| Configuration fields | How the fallback uses them |
| --- | --- |
| `serverEngine`, `serverMode`, `routerHost`, `routerPort`, `routerApiKey` | Engine ID is `llama_cpp` or `strata`; host/port and router settings apply to llama.cpp. |
| `strataHost`, `strataPort`, `strataApiKey` | Strata address and Bearer auth; context comes from the run snapshot. |
| `LaunchConfig.host`, `port`, `apiKey`, `ctxSize`, `profileName`, `modelAlias` | Run snapshot; for router mode the profile name supplies the API route ID. |

Old settings found in a user's database may remain in its raw backup or exported legacy fields. They do not create an active connection or silently select a different engine.

## Secrets and network

`apiKey` is passed as a separate Bearer secret. The ordinary copy block reports only whether auth is configured. The full value reaches the clipboard only through its separate button; templates use `APLOT_API_KEY` as an environment reference when a key is configured.

A harness adapter should use the same `/v1/chat/completions` route. Template context comes from the active target, not the model's maximum. If the app and harness are in different network environments, configure an address reachable from the harness; the current frontend check is subject to CORS.

## Profile and run snapshots

Versioned profiles retain engine options, model references, extensions, and secret references; see [profiles](modules/profiles.md). [createRunStartRequest](../../src/services/tauri.ts) captures the selected profile/draft into the engine-specific request. `start_run` validates/prepares it, and native `restart_run` reuses its own request. Editing a draft does not change a running process. Strata configuration files and router preset contents remain dependencies outside the immutable settings snapshot.

`createRunStartRequest({ ...input, preview: true })` prepares resource UI input without resolving stored secrets, native launch validation, or writing router presets. Router preview uses a placeholder, so its resource demand remains unknown. The [resource panel](modules/resources.md#panel) sends the preview only after an explicit button click.

## Local component store

The installer and maintenance default to `%LOCALAPPDATA%\Aplot Control LLM\components`. A local launch can set `APLOT_COMPONENT_ROOT` to an absolute dedicated folder, for example `C:\Dev\Aplot-Control-LLM\project\components`. Pass the same path to the installer through `-InstallRoot`. The store uses the regular `installations.json` and `<component>/<version>/aplot-component.json` files; maintenance retains its ownership, active-process and reparse-point checks. An invalid explicit path blocks maintenance instead of switching to another store.

The variable selects the store for this process and its children; it does not move external installations or change explicitly saved engine paths. Select the new installation path in Settings after installing it. Model downloads reject destinations inside the selected store so component maintenance cannot remove model weights or partial downloads. Keep models separately.

## Resource estimates

The llama.cpp estimate uses GGUF metadata and effective launch settings when available. Otherwise the planner reports an unknown range; Strata uses only values explicitly confirmed by its integration. Neither an estimate nor downloaded file size guarantees that a model fits in RAM/VRAM or will launch. See the [resource module](modules/resources.md#options) for rules and limits.
