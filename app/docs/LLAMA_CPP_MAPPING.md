# llama.cpp mapping used by Aplot Control LLM

The UI is capability-aware. At runtime the selected `llama-server` is queried with `--version`, `--help` and `--list-devices`; unsupported controls should remain hidden/disabled. `extraArgs` is the escape hatch for newly added upstream flags.

## Model
| LaunchConfig | llama-server |
|---|---|
| `modelPath` | `--model` |
| `modelAlias` | `--alias` |
| `mmprojPath` | `--mmproj` |
| `loraPaths[]` | repeated `--lora` |

## Hardware / memory
| LaunchConfig | llama-server |
|---|---|
| `device` | `--device` |
| `gpuLayers` | `--gpu-layers` |
| `flashAttention` | `--flash-attn` |
| `fit` | `--fit on/off` |
| `fitTargetMiB` | `--fit-target` |
| `fitContextMin` | `--fit-ctx` |
| `kvOffload` | `--kv-offload` / `--no-kv-offload` |
| `cacheTypeK` | `--cache-type-k` |
| `cacheTypeV` | `--cache-type-v` |
| `splitMode` | `--split-mode` |
| `tensorSplit` | `--tensor-split` |
| `mainGpu` | `--main-gpu` |

`--list-devices` output is parsed into the Device selector. Current UI supports `none`, one device or a manually entered comma-separated list.

## Context / concurrency
| LaunchConfig | llama-server |
|---|---|
| `ctxSize` | `--ctx-size` |
| `batchSize` | `--batch-size` |
| `ubatchSize` | `--ubatch-size` |
| `parallel` | `--parallel` |
| `threads` | `--threads` |
| `threadsBatch` | `--threads-batch` |
| `continuousBatching` | `--cont-batching` / `--no-cont-batching` |

## Server
| LaunchConfig | llama-server |
|---|---|
| `host` | `--host` |
| `port` | `--port` |
| `apiKey` | `--api-key` |
| `corsOrigins` | `--cors-origins` |
| `corsMethods` | `--cors-methods` |
| `corsHeaders` | `--cors-headers` |
| `corsCredentials` | `--cors-credentials` / `--no-cors-credentials` |
| `webUi` | `--ui` / `--no-ui` |
| `timeoutSeconds` | `--timeout` |
| `httpThreads` | `--threads-http` |
| `metrics` | `--metrics` |
| `slots` | `--slots` / `--no-slots` |
| `props` | `--props` |
| `jinja` | `--jinja` / `--no-jinja` |
| `reasoning` | `--reasoning` |
| `reasoningFormat` | `--reasoning-format` |

## Sampling defaults
`temperature`, `topK`, `topP`, `minP`, `typicalP`, `repeatPenalty`, `repeatLastN`, `frequencyPenalty`, `presencePenalty` and `seed` map to the corresponding server startup sampler defaults.

## Forward compatibility
`extraArgs` is tokenized and appended at the end of generated argv. Since final CLI arguments can override earlier values in some parsers, the UI should visibly warn when `extraArgs` duplicates a managed flag in a future hardening pass.

## Native multi-model router
Router mode uses the selected binary's native model-router implementation; capability detection must confirm `--models-preset` and `--models-max` before enabling it, and `--models-autoload` is added when advertised. The preset uses one `[profile name]` section per saved profile. The name is the API `model` identifier; supported `PARAMETER_REGISTRY.routerKey` values are generated from that profile's LaunchConfig, with profile `extraArgs` preserved for options not represented in the registry. Unsupported capability-gated settings are omitted and surfaced as a warning.

Global server options are emitted in the `[*]` section, and the generated startup command adds the shared endpoint, loaded-model limit and compatible UI/metrics/log options. The API key is supplied to the managed process through `LLAMA_API_KEY`, rather than written to the preset or CLI preview. Default model residency is one; llama.cpp's autoload router performs the profile switch and model residency management in response to OpenAI-compatible requests.

Router presets set `jinja = true` for every route when the executable advertises `--jinja`, because OpenAI tool calls are rejected without it. This intentionally overrides older imported profiles that stored `jinja = false`; binaries without the positive `--jinja` option surface it as an unsupported router setting. Runtime monitoring reads `/models` to identify loaded routes and includes each route ID in `/metrics?model=...` and `/slots?model=...` requests.
