<a id="resources"></a>
# Resource planning module

<a id="scope"></a>
## Scope and status

This P07 slice provides pure advisory planning in [resource_planner.rs](../../../src-tauri/src/resource_planner.rs) and [planner.ts](../../../src/features/resources/planner.ts), with the TypeScript contract in [types.ts](../../../src/features/resources/types.ts). Rust also provides an application-local, mutex-protected numeric lease registry. The registered read-only [resource_service.rs](../../../src-tauri/src/resource_service.rs) connects native hardware, active run snapshots, and GGUF headers to planning; [ResourcePlanPanel.tsx](../../../src/features/resources/ResourcePlanPanel.tsx) presents it in the configuration UI.

The pure planner consumes supplied telemetry and metadata. The native service collects read-only inputs and does not change engine options, write SQLite, start/stop processes, apply variants, or create leases. A numeric registry reservation protects its supplied budget, not the operating system allocator. Foreign allocations and inaccurate metadata can still cause launch failure. The registry is not connected to production launch admission. The planner retains legacy request identifiers for conservative unknown estimates; their presence does not mean those engines remain installable or launchable in the app.

<a id="contract"></a>
## Contract v1 and entry points

All resource amounts are **bytes**, nonnegative safe integers at most `2^53 - 1`, including Rust `u64` values crossing the JSON boundary. Counts must be positive where specified. KV bytes per element may be a positive fractional value up to 8, including quantization block overhead. Negative, nonfinite, overflowing, inconsistent, duplicate, or reserved-ID data is rejected. `ram` and `pinnedRam` cannot be GPU IDs. Rust uses camelCase serde names.

| Entry point | Contract |
| --- | --- |
| TS `accountResources(input)` / Rust `account_resources(&AccountingInput)` | Account supplied occupied memory, included observations, reservations, caps, spare and snapshot age. |
| TS `planResources(input)` / Rust `plan_resources(&ResourcePlannerInput)` | Return `ResourcePlan` or an input-validation error. No reservations are created. |
| Legacy TS `mapInfernixBudgetSettings(settings, gpuId, knownAllocationFloors?)` / Rust `map_infernix_budget_settings(&InfernixBudgetSettings, &str, Option<&ResourceAmounts>)` | Compatibility helper for saved Infernix settings; converts raw configuration units into spare and informational budgets. Memory floors require a separate explicit external source. This is not an active engine integration. |
| Rust `ResourceLeaseRegistry::default()` | Construct one independent in-memory ledger. The application should own a single ledger. |
| Rust `snapshot()` | Return `{ revision, claims }`. |
| Rust `try_claim(&AccountingInput, ResourceClaim, Option<u64>)` | Atomically account authoritative registry claims and supplied external claims, then insert a numeric reservation. Optional expected revision detects stale decisions. |
| Rust `release(claim_id, owner_id, generation)` | Remove only a matching claim; an absent claim is an idempotent no-op. |

TS validation throws `ResourcePlannerError` with `code: "invalidInput"`. Rust returns `PlannerError { code, message }`; registry codes are `invalidInput`, `conflict`, `insufficient`, `unknown`, and `poisoned`. JSON deserialization may reject malformed input before these functions run.

<a id="inputs"></a>
## Input data

`ResourcePlannerInput` consists of `hardware`, `claims`, `observations`, and `request`. `AccountingInput` uses the first three fields.

| Object | Fields and meaning |
| --- | --- |
| `HardwareBudget` | `snapshotId`, `snapshotAgeMs`, `maxSnapshotAgeMs`, `ram`, optional `pinnedRam`, `gpus` keyed by stable device ID. The caller computes age immediately before admission. |
| `PoolBudget` | Optional `totalBytes`, `observedUsedBytes`, `freeBytes`, `limitBytes`; required `spareBytes`. `limitBytes` is a global shared allocation cap. Total capacity alone is not free capacity. |
| `ResourceClaim` | `claimId`, `ownerId`, `generation`, `amounts`. Owner identifies one process/shared service, not a profile or file. |
| `ResourceAmounts` | `ramBytes` includes `pinnedRamBytes`; `gpuBytes` is a device map. These are explicit reservation amounts, not measurements. |
| `ResourceObservation` | `snapshotId`, `ownerId`, `generation`, optional `ramBytes` / `pinnedRamBytes`, and `gpuBytes`. Values must already be included in the same global hardware sample. Missing values remain unattributed. |
| `ResourceRequest` | `engine`, `model`, `contextTokens`, `minimumContextTokens`, `options`. Minimum context must be positive and cannot exceed configured context. |
| `ModelResourceMetadata` | Optional `artifactBytes`; `format` (`gguf` / `other` / `unknown`), `weightsComplete`, `architecture` (`dense` / `moe` / `unknown`), `attention` (`standard` / `other` / `unknown`), optional `kv`. |
| `KvMetadata` | `layers`, `kvHeads`, `keyHeadDim`, `valueHeadDim`, `keyBytesPerElement`, `valueBytesPerElement`. Uniform full-cache MHA/GQA layers only. |

`artifactBytes` should sum the complete primary weight shards once. Filesystem hard-link deduplication does not prove that two processes share an allocation. Projector/draft/MTP/LoRA/ngram dependencies require separate allocation evidence; set `unmodelledAllocations: true` whenever their memory has not been covered. MoE disk size is deliberately not used as a resident-memory minimum.

<a id="options"></a>
## Engine options and configuration mapping

`EngineResourceOptions` requires `placement`, `kvOnGpu`, `kvCapacityScalesWithContext`, `unmodelledAllocations`, `extraRamBytes`, `pinnedRamBytes`, `extraGpuBytes`, `gpuBudgetBytes`, `spareRamBytes`, and `spareGpuBytes`. Optional fields are `gpuId`, `gpuLayers`, `kvCapacityTokens`, `workspaceRam`, and `workspaceGpu`.

Generic placement values `allGpu`, `hybrid`, and `cpu` are supported only for `llama_cpp`; other engines require `engineManaged`. GPU placement requires an explicit device ID. Hybrid placement requires an explicit layer count no larger than known layers. CPU placement cannot offload KV. The current strategy models one target GPU and never pools free VRAM across devices. Multi-GPU tensor splits require a separate strategy and should remain unknown here.

`kvCapacityTokens` is the **total actual cache cell capacity**, not a per-slot context value. The caller must resolve the installed build's `-c`, parallel, unified-cache, and padding semantics. No parallel multiplier is guessed. `kvCapacityScalesWithContext` permits proportional capacity reduction only when the adapter has confirmed that relationship. Request context is never reduced below `minimumContextTokens`.

`workspaceRam` / `workspaceGpu` are `{ min, max }` envelopes; `max: null` is unbounded. Supplied bounds raise dense non-hybrid confidence only to `medium`, because the allocator is still not verified. Known extra allocations must be externally established and disjoint: `extraRamBytes` excludes pinned allocations. Raw configuration budgets are not allocation floors.

| Configuration concept | Input mapping |
| --- | --- |
| Global usable RAM/VRAM budget | Pool `limitBytes`; requires known global usage to apply. |
| Global spare memory | Pool `spareBytes`. |
| Engine RAM/VRAM headroom | `spareRamBytes` / `spareGpuBytes`; effective spare is the maximum of global and engine spare, so the same safety margin is not subtracted twice. |
| Per-run GPU budget | `gpuBudgetBytes[deviceId]`; caps this candidate's available allocation separately from global free memory. |
| Legacy Infernix pinned/resident allocations | Only externally established `pinnedRamBytes`, `extraRamBytes`, and `extraGpuBytes`; unknown total upper bound. No RAMhead/hostchunks inference is provided. |
| Legacy Infernix expert RAM setting | Informational `configuredExpertRamBudgetBytes`; zero/auto becomes null. It is not a measured resident allocation or a RAM floor. |

The legacy `mapInfernixBudgetSettings` helper accepts raw `ramHeadroomMiB`, `vramHeadroomMiB`, `expertRamMiB`, `hostContextMiB`, and `prefillChunk`. It converts headroom MiB to spare bytes only. Expert RAM becomes an informational configured budget; host context becomes informational `configuredHostContextPoolBytes`. Neither becomes resident or pinned memory. `prefillChunk` is returned unchanged with `prefillChunkUnit: "unverified"`: this module has not inspected an engine allocator's chunk units and never treats the value as MiB/bytes.

Without a separate `knownAllocationFloors` argument, mapped RAM/pinned/GPU floors are zero and `allocationSource` is `configurationOnly`. An explicit external `ResourceAmounts` source produces `externalAllocationFloors`; its `ramBytes` includes pinned, so the helper computes `extraRamBytes = ramBytes - pinnedRamBytes`. Mapping always returns `unmodelledAllocations: true`, reasons, and no finite fit envelope. A numeric pinned budget cannot guarantee OS/CUDA pinning success; pinning limits and fragmentation require runtime evidence.

<a id="accounting"></a>
## Accounting occupied memory without double counting

For each pool, baseline free memory is the lower of supplied `freeBytes` and `totalBytes - observedUsedBytes`, using whichever values are known. If a shared `limitBytes` exists, this is also capped at `max(0, limitBytes - globalUsed)`. Global usage is supplied directly, or inferred from a known total/free pair. Total bytes without usage/free does not imply an idle device.

Only an observation with matching **snapshot ID, owner ID, and generation** can offset a reservation, and only when global usage is known. The residual reservation is `max(0, reserved - includedObserved)`. Available memory is `max(0, baselineFree - sum(residualReservations) - spare)`. Stale/unattributed observations do not reduce reservations. If included owner observations sum beyond global observed usage, the input is rejected rather than inventing overlap.

Example: a 16 GiB GPU has 8 GiB globally used, including 4 GiB from a run that reserved 6 GiB. With 1 GiB spare, availability is `16 - 8 - (6 - 4) - 1 = 5 GiB`. Adding both full reservation and observed run usage would double count that allocation. External processes remain part of the global 8 GiB even when they have no claims.

Pinned allocations are independently checked against a pinned pool, while their bytes are already included in RAM. They are never added to RAM a second time. Duplicate claim IDs or duplicate owner/generation claims are rejected. Shared router or service ownership must be aggregated by the caller; model IDs alone are not allocation owners. Unattributed reservations are conservative and can reject a fit that would succeed with better attribution.

<a id="estimates"></a>
## Dense llama approximation and honest unknown results

The bounded approximation requires `llama_cpp`, complete GGUF weights, dense architecture, standard uniform attention, all KV dimensions/types, actual KV capacity, explicit placement, and no unmodelled allocations. Otherwise only explicit RAM/pinned/GPU allocation floors are returned with `max: null`, `source: "knownFloorsOnly"`, and `confidence: "unknown"`. Strata and all legacy engine identifiers accepted by the planner remain unbounded; MoE, SWA, MLA, recurrent, and mixed architectures do not inherit a generic dense fit claim.

For the eligible case:

```text
nominalKV = layers * kvHeads *
            (keyHeadDim * keyBytesPerElement + valueHeadDim * valueBytesPerElement) *
            kvCapacityTokens
KV range = [ceil(nominalKV), ceil(1.10 * nominalKV + 16 MiB)]
```

These KV dimensions correspond to the current upstream [llama KV cache implementation](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-kv-cache.cpp); other memory implementations are represented in [llama-memory.h](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-memory.h). Cache capacity/offload behavior must be checked against the installed build's [server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). The 10%/16 MiB padding is this planner's engineering allowance, not a guarantee from upstream.

For weight file bytes `W` and offload fraction `f`, CPU uses `f=0`, all-GPU uses `f=1`, and hybrid uses `gpuLayers/layers`. Hybrid expands this by ±0.15, clamped to `[0,1]`, for non-layer tensors. GPU weight range is `[0.95*W*fLow, 1.20*W*fHigh]`. RAM weight/staging range is `[0.95*W*(1-fHigh), 1.25*W]`, retaining host staging even with full GPU offload. KV is added to its selected pool; known pinned/extra allocations and workspace are added separately. Bytes are rounded upward.

Missing workspace envelopes use uncalibrated RAM 256–1024 MiB and GPU 256–2048 MiB allowances, with `confidence: "low"`. Hybrid remains `low` even with supplied workspace. These are broad advisory ranges for startup/runtime allocation; copies, mmap residency, cache sharing, batch/ubatch graphs, backend alignment and fragmentation may exceed them. They are not measured or certified upper bounds.

<a id="results"></a>
## Output statuses and variants

`ResourcePlan` contains `contractVersion: 1`, `availability`, `candidates`, and `automaticApplication: false`. Each candidate exposes its ID, placement, layer count, context/cache capacity, `estimate`, per-pool `assessments`, and status. The estimate includes informative `artifactBytes`, a `kv` range or null, RAM/pinned/GPU ranges, confidence, source, and reasons.

| Status | Meaning |
| --- | --- |
| `insufficient` | At least one known minimum exceeds known available memory or a per-run GPU cap. |
| `unknown` | No definite insufficiency, but a required pool has missing/stale availability or an unbounded allocation maximum. |
| `advisory` | Known minima fit, but at least one finite upper estimate crosses available memory. |
| `withinEstimate` | All finite upper estimates are within the supplied accounted budgets. This is not verified fit. |

Priority is `insufficient` → `unknown` → `advisory` → `withinEstimate`. Exactly zero bounded demand does not require telemetry for that unused pool. The configured candidate always appears. Eligible llama requests can additionally propose all-GPU, a half-layer hybrid, CPU, and one context reduction; they use the explicit known GPU and preserve remaining options. Other engines/unknown strategies expose only the configured advisory target. No variant is applied automatically or ranked as universally best.

<a id="leases"></a>
## Atomic claims, generations and lifecycle integration

The native registry locks around merge, accounting, validation and claim insertion. Concurrent starts cannot both spend the same registry budget. Exact active claim retries are idempotent; different amounts under the same ID conflict. External copies of registry claims are deduplicated only when identical; mismatches conflict. A currently observed process can be adopted using the same identity/sample, reserving only its incremental unobserved amount.

Optional expected revision checks happen before idempotent retry handling. The caller must refresh/recalculate after a revision conflict. An owner cannot have two active registry claims, and a released generation cannot be reused. `release` checks owner/generation, so delayed cleanup from generation N cannot release generation N+1. An absent claim is a no-op and does not advance revision.

`try_claim` accepts explicit numerical amounts and the global accounting input. It **does not** derive amounts from a candidate, enforce engine-specific `gpuBudgetBytes`/headroom automatically, or verify that an unknown engine will fit. The caller must first review planner status, apply applicable spare/caps to the admission budget, choose a justified reservation envelope, and explicitly handle unknown estimates. Releasing a reservation does not prove that OS memory has been freed; refresh telemetry after process/service shutdown. On launch failure/cancellation, release that exact owner's generation; keep claims while owned allocation remains alive.

The ledger is application-local and nonpersistent. It has no cross-process mutex, TTL, event journal, recovery scanner, automatic lease expiration, or protection against foreign allocations occurring after a snapshot. The caller must provide honest same-sample attribution and fresh age. Missing GPU or pinned pool availability returns `unknown` for a positive reservation. Run lifecycle admission/release integration remains separate work; native advisory planning does not spend this ledger.

<a id="native-service"></a>
## Registered read-only native service

`plan_run_resources({ request: RunRequest })` is registered in [lib.rs](../../../src-tauri/src/lib.rs). It returns the flattened contract-v1 `ResourcePlan`, `warnings: string[]`, and `activeRuns`, whose entries contain `runId`, `generation`, `state`, `estimate`, and `accountingMode`. It copies active requests from `RunManager::resource_requests()`, including internal launch snapshots rather than mutable frontend settings, then runs metadata/hardware work in `spawn_blocking`. Public output excludes launch arguments and credentials.

The GGUF reader examines only bounded metadata headers: 64 MiB scan limit, 64 KiB captured strings/keys, 100,000 metadata entries, and 2 million array elements. Unsupported/partial metadata, per-layer arrays, absent KV shape, missing shards, dependencies, and nonstandard attention prevent a bounded dense strategy. File sizes sum recognized complete shard names once; tensor payloads are not read. The native strategy currently recognizes only canonical dense `llama` GGUF. Explicit key/value head dimensions are used; embedding/head fallback is allowed only when those dimensions are absent. Nonzero or malformed expert/SWA metadata blocks the standard strategy.

Effective CLI values use the last occurrence, including `--flag=value`. A bounded native cache estimate requires explicit positive `--ctx-size`, `--parallel 1`, explicit K/V cache types, fixed placement, and `--fit off`/`0`. No default cache type, parallel multiplier, or auto-fit outcome is guessed. `--gpu-layers`, `--n-gpu-layers`, and `-ngl` are accepted. Only GPU 0 with explicit supported device selection is mapped; unsupported devices, splits, router residency, or projector/draft/LoRA/ngram dependencies remain unknown. The context floor is preserved and invalid floors are rejected. Non-llama requests use their configured context and return unknown envelopes; the legacy Infernix settings helper maps headroom only to spare.

Cache type fractions include quantization block overhead from upstream [ggml-common.h](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h), for example q5_1 uses 24 bytes per 32 values. Supported type names are f32, f16, bf16, q8_0, q4_0, iq4_nl, q4_1, q5_0, and q5_1; this mapping does not certify installed backend support or allocation alignment.

Hardware currently supplies RAM and the first NVIDIA GPU as separate pools. Invalid/missing telemetry is unknown; pinned capacity and same-sample per-PID allocation observations are absent. Snapshot age includes the hardware cache's 750 ms window and collection duration; readings older than 2,000 ms become unavailable to the planner. These readings and run snapshots are not an atomic OS allocation transaction.

For active bounded estimates, the service adds temporary full upper-envelope claims with `accountingMode: "conservativeEstimateClaim"`. They may overlap global observed memory because no PID attribution exists. Pressure created only by such unverified overlap is advisory, not proven insufficiency. An unbounded active estimate uses `globalObservedOnly`; future active growth remains unknown. Known current free-memory insufficiency is retained. No active process is silently assumed to use zero memory, and these temporary claims never enter the lease registry.

<a id="panel"></a>
## Explicit resource panel

`ResourcePlanPanel` accepts `{ request: StartRunRequest | null, disabled?: boolean }`. The configuration view builds input with `createRunStartRequest({ ...input, preview: true })`; preview skips stored-secret resolution, native launch validation, and router-preset writes. Router placeholders intentionally produce unknown allocation.

Only the Estimate resources button invokes native planning. The panel shows configured/hypothetical variants, context, RAM/VRAM ranges, confidence, statuses, reasons, and telemetry/active-run warnings. RU/EN labels are local; native diagnostic reasons currently remain English. Request changes clear the old result, and request epochs discard late responses or unmounted results. Browser mode disables planning because there is no real hardware snapshot. There are no apply actions, configuration writes, or automatic recalculation.

<a id="verification"></a>
## Verification and remaining evidence

[resourcePlanner.test.ts](../../../tests/resourcePlanner.test.ts) covers dense ranges/KV capacity, unsupported architectures/engines, unknown/incomplete dependencies, insufficient/advisory/unknown distinctions, context floors, GPU separation/caps, spare rules, stale/missing telemetry, attribution, duplicates, pinned accounting, and the legacy Infernix settings helper. Rust planner tests cover concurrent admission/release, revision/identity/generation conflicts, idempotence, observations/adoption, numeric rejection, and unknown pinned capacity. Native service tests use temporary fake GGUF headers, actual CLI/settings mapping, and active unknown growth without launching a model.

The registered modules support `cargo test --lib resource_`; TS uses `npm test -- tests/resourcePlanner.test.ts`. A successful two-server CPU run established supervisor behavior only. Browser-to-native resource invocation, allocator calibration, performance ranking, resource events, lease lifecycle admission, and actual multi-engine/GPU load tests remain separate validation work. No observed fit from another engine/model is transferred to this estimate.
