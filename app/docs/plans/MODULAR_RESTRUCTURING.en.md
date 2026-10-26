# Aplot Control LLM restructuring plan

[Русский](MODULAR_RESTRUCTURING.ru.md) · [Plan index](README.md)

Plan date: **11 October 2026**. Status on October 12: **current iteration closed; target plan partially implemented**. Results and remaining checks: [progress](IMPLEMENTATION_STATUS.en.md).

Baseline: the project working tree with version 0.8.2 in its manifests, including uncommitted Infernix integration changes; HEAD during preparation was `4fa5829`. This identifies the base commit, not the complete current revision. Baseline sources and user SQLite were preserved before changes; progress is recorded separately from the target criteria below.

This document defines the target structure, transition sequence, verifiable outcomes and documentation policy. New file and table names are provisional; each stage will establish its final names. Preparing the plan did not change the application, user database, model files or engines.

## 1. Agreed goal and scope

**One desktop application retaining the current UI manages multiple local engines, models and profiles, helps select configurations for the hardware, and connects them to external harnesses.**

Required properties:

1. One Aplot instance, one main window, shared settings, catalog and history. Engine processes are managed within this application.
2. Multiple simultaneous runs using the same or different engines, models and profiles, subject to engine support and available resources.
3. Preservation of the current appearance, navigation, cards, dashboard layout, themes, scaling, RU/EN and familiar workflows.
4. Preservation of the five current engine integrations: llama.cpp, Strata, Ollama, QwFNfer and Infernix. The architecture does not promise identical capabilities across engines.
5. Complete profiles for every engine, independent of the global UI selection.
6. Model and configuration selection, resource estimates, real measurements and comparison history.
7. External harness connections: automatic for verified adapters, assisted or API copying for other clients.
8. Clear module boundaries and detailed synchronized Russian and English documentation.

This work excludes a custom agent loop, agent tools, conversation memory, workflow editor, embedded agent chat, distributed cluster and external plugin marketplace. It also excludes a technology-stack replacement and a general redesign.

Extensibility initially means internal modules with explicit contracts. An external plugin API can be discussed after real integrations have validated those contracts.

## 2. Current implementation and required transitions

The observations below come from source inspection rather than solely from existing documentation.

| Current area | Observed structure | Required transition |
| --- | --- | --- |
| [lib.rs](../../src-tauri/src/lib.rs) | `tauri_plugin_single_instance` already exists; a second invocation shows the main window | Preserve and verify this behavior |
| [process.rs](../../src-tauri/src/process.rs) | `ProcessRegistry.current: Option<ManagedProcess>`, shared generation, `llama://state` and `llama://log` events | Run registry, individual generations and resource ownership |
| [control.ts](../../src/store/control.ts) | One runtime, runningConfig, log/history collection and many engine branches | State indexed by run ID, separate domain stores and a compatibility facade |
| [App.tsx](../../src/App.tsx) | Shared event subscription, one runtime poll and existing views | Retain the shell; move polling and subscriptions into a dedicated service |
| [config.ts](../../src/types/config.ts), [app.ts](../../src/types/app.ts) | `LaunchConfig` mainly describes llama.cpp; other engine options also reside in `AppSettings` | Common profile envelope with typed options for each engine |
| [LibraryView.tsx](../../src/views/LibraryView.tsx) | Shared model/profile library; some engines appear as prepared configs or global settings | Consistent user-facing profile semantics without losing engine-specific options |
| [ollama.rs](../../src-tauri/src/ollama.rs) | Separate service ownership and model load/unload operations | Distinguish service, connection and resident model |
| [router.rs](../../src-tauri/src/router.rs) and store | Native llama.cpp router uses saved profiles; synchronization is coordinated by the store | Preserve the mode and associate each route set with its particular service |
| [db.rs](../../src-tauri/src/db.rs) | SQLite/WAL, backups and profiles/kv/benchmarks/benchmark_suites/events tables | Versioned migrations and additional records preserving old data |
| [parameters.ts](../../src/lib/parameters.ts) | Existing llama.cpp registry includes CLI mappings, translations and constraints | Extend the approach to other engines without another independent competing registry |
| [benchmark.rs](../../src-tauri/src/benchmark.rs), optimizer | Throughput, recall, continuity and profile search exist; progress is shared | Individual jobs, resource coordination, cancellation and reproducible conditions |

File size alone does not establish architectural problems. Prioritize areas mixing process ownership, configuration, UI and side effects.

Keep the existing documents as source material:

- [Architecture](../ARCHITECTURE.md), [code map](../CODE_MAP.md), [data](../DATA_MODEL.md), [IPC](../IPC_CONTRACT.md): verify and update during the transition; some sections already lag behind the five integrations.
- [Hardware launch planner plan](../HARDWARE_LAUNCH_PLANNER_PLAN.md): retain minimum-context requirements, trial isolation and evidence-based measurement; adapt its single-server limitation to run sessions and resource leases.
- [Embedded agent proposal](../AGENT_INTEGRATION.md): its embedded chat/RPC/tools are outside this plan. Keep the historical document; during implementation mark the changed direction and link the new decision.
- [Model storage catalog](../../../docs/MODEL_STORAGE.md): preserve centralized weights and shared-file rules.

## 3. Domain model

| Entity | Purpose and lifecycle |
| --- | --- |
| `EngineInstallation` | A particular engine installation/build: paths, version and discovered capabilities. One adapter can support multiple installations |
| `ModelArtifact` | Model file set, shards and dependencies; source, sizes, identity and integrity verification |
| `LaunchProfile` | Saved configuration with stable ID, revision, model/installation references and engine options |
| `LaunchPlan` | Validated execution plan: command, environment, working directory, endpoints, resources and constraints. Prepared before launch |
| `EngineService` | An owned background process or attached external service; one service may host multiple models |
| `ModelDeployment` | Model or route accessible through a service; residency/unloading differs from stopping the service |
| `RunSession` | A user-managed run based on a profile snapshot, linked to service and deployment. Has runId, generation and state |
| `ConnectionTarget` | Endpoint, protocol, actual model ID, configured context and secret reference for an external client |
| `HarnessConnection` | Harness, adapter/version, target connection, applied changes and verification level |
| `BenchmarkJob` / `BenchmarkResult` | Isolated measurement job and its preserved conditions/results |
| `ResourceLease` | Temporary resource reservation for a run or trial |

Essential distinctions:

- A profile is data; saving it does not start a process.
- A run uses an immutable profile-revision snapshot. Editing a draft does not change the live server.
- In a normal single-model mode, service and deployment roughly map to one run. Ollama and the native router require one-to-many relationships.
- A service may be ready while an individual model is loading or unloaded. These states must remain distinct.
- One weight file can serve several profiles and engines. Shared storage does not guarantee shared process RAM/VRAM.
- Two Ollama profiles of the same model with different settings are not independent deployments without confirmed service support; the adapter reports a conflict or a supported operating mode.

Relationships: profile → plan → run; run → service + deployment; connection → deployment or API alias; benchmark → run/plan snapshot + resource lease. History retains snapshots after a profile changes or is deleted.

## 4. Module boundaries and dependencies

```text
Existing React views
        ↓ typed actions and selectors
Application services / Tauri IPC
        ↓
Use cases: start, stop, connect, verify
        ↓
Domain contracts and rules
        ↑ implemented by
Engine / harness / SQLite / filesystem / HTTP adapters
```

| Module | Owns | Must not do |
| --- | --- | --- |
| `engines` | Each engine's capabilities, parameters and native API | Read the selected view or global editor draft |
| `launches` | Plans, services, runs, ports, lifecycle and recovery | Infer model quality from its name |
| `models` | Catalog, file sets, dependencies, import and integrity | Load model weights merely while scanning |
| `profiles` | Revisions, CRUD, import/export and configuration resolution | Stop every server when a profile is saved |
| `hardware` | Shared hardware and observed resource snapshot | Attribute total GPU memory to one process |
| `planner` | Compatibility, candidates, explanations and measured recommendations | Silently reduce the required minimum context |
| `benchmarks` | Protocols, jobs, cancellation, results and provenance | Overwrite a user profile with a test configuration |
| `connections` | Actual API parameters, verification and export | Execute an agent loop |
| `harnesses` | Configuration formats, applying/reverting integrations | Manage weights or the global engine lifecycle |
| `observability` | Events, logs, metrics, correlation and diagnostic export | Replace unavailable metrics with zero |
| `storage` | Repositories, transactions, migrations and backups | Expose API keys in reports |
| `api_gateway` | Optional stable endpoints/aliases and proxying | Implement harness reasoning, tools or memory |

Retain React/TypeScript/Zustand, Tauri/Rust and SQLite. Rust owns processes, executable-plan validation and persistent data. TypeScript owns presentation and editor drafts; backend validation checks UI values again.

Proposed layout, without requiring every directory to be created immediately:

```text
app/src/
  components/ + views/           existing visual foundation
  features/
    engines/ models/ profiles/ launches/
    planner/ benchmarks/ connections/
  services/                     IPC, desktop, subscription lifecycle
  store/                        domain slices and temporary control facade
  shared/                       genuinely common contracts/utilities
app/src-tauri/src/
  domain/                       types/rules without Tauri/SQL/processes
  application/                  use cases and operation coordination
  engines/{llama_cpp,strata,ollama,qwfnfer,infernix}/
  infrastructure/               processes, HTTP, files, SQLite
  ipc/                          thin command handlers
app/docs/{ru,en}/                detailed implementation documentation
```

CI checks dependency directions. `shared` must not become a dumping ground; introduce abstractions when actual shared behavior exists. One Rust crate is initially sufficient.

## 5. Contracts and configuration

### 5.1 Engine adapter

Minimum operations: `discover`, `capabilities`, `validateProfile`, `prepareLaunch`, `health`, `listDeployments`, `runtime`. Resident-model control, token counting and special APIs are optional capabilities rather than mandatory stubs.

`prepareLaunch` returns a plan; the common supervisor performs process lifecycle operations. Build/version is part of the capability discovery key. Capability states are supported / unsupported / unknown, with evidence and conditions. Features such as tool calls are checked for engine + model + template combinations, not just the executable.

The first adapter wraps current llama.cpp behavior; then migrate Strata, QwFNfer, Infernix and Ollama's special service/deployment path. Establish compatibility through checks rather than translating all llama.cpp flags to other engines.

### 5.2 Profile v2 and value resolution

Envelope: `schemaVersion`, `id`, `revision`, `name`, `engineInstallationId`, `modelArtifactId`, `mode`, `engineOptions`, `connectionOptions`, `requestDefaults`. `engineOptions` is an engine-discriminated typed union retaining every specific option. Router settings belong to the service configuration and route set.

Resolution: installation defaults → saved profile → explicit run overrides. A preset applies a set of values to a profile; initially there is no inheritance chain. The resolved snapshot includes values and origins. For `auto`, preserve the requested value and actual discovered outcome when the engine reports it.

Separate startup parameters from HTTP request defaults. Defaults unsupported by the engine or client must not be presented as applied.

Each parameter describes its type, units, default, range, availability conditions, dependencies, change scope and RU/EN explanations. Reuse the existing `PARAMETER_REGISTRY` during migration. Validation schemas and IPC types have an assigned source of truth; generation prevents two independently maintained competing schemas. Custom forms retain current components and styling.

Unknown imported fields remain available for diagnostics/re-export but are not automatically executed. Unsupported newer versions receive an explicit status. Preserve `extraArgs` where already supported, checking conflicts with managed flags.

### 5.3 IPC and events

Provisional commands: `prepare_run`, `start_run`, `stop_run`, `restart_run`, `list_runs`, `run_snapshot`, `list_engine_installations`, `resolve_profile`, `preview_connection`, `apply_connection`, `revert_connection`, `start_benchmark`, `cancel_job`.

Every mutating operation has operationId and a target runId/serviceId; duplicate delivery must not accidentally create another process. Events include schemaVersion, eventId, timestamp, correlationId, applicable runId/serviceId/deploymentId, generation and payload. Late results from a previous generation are ignored for their own target.

Errors carry code, messageKey, details and retryability. Distinguish occupied ports, incompatible models, memory exhaustion, build errors and unavailable connections. Old commands temporarily forward to the selected run until the UI migration finishes; remove them only after checking all callers.

### 5.4 Storage and identity

Introduce sequential schema migrations with a ledger, transactions and consistent SQLite backups. Proposed records: installations, artifacts/file references, v2 profiles, run history, connections, jobs/results and migrations. Never persist `Child` or treat a stored PID as sufficient proof of ownership after restart.

Migration preserves old profile IDs, ordering/names, favorites, layout, language, themes, settings, benchmark history and recovery. Global Strata/QwFNfer/Infernix settings become individual profiles; prepared Strata configs remain source files and are not rewritten without user action. Ambiguous records are marked for clarification while preserving their originals.

Import profile v1 and raw legacy JSON; explicitly version v2 exports. Export to a legacy format only for representable subsets with explained losses. Historical results must not acquire invented engine versions or fingerprints.

Separate secrets from public configuration through references; omit them from fingerprints/logs/exports by default. Choose Windows storage in D06 with portable-installation requirements in mind; migration must retain functioning keys.

## 6. Lifecycle and multiple models

The supervisor maintains service/run registries, per-target operation locks and a short shared registration/reservation lock. HTTP waits and process termination must not hold the shared lock.

Retain familiar stopped / starting / loading / ready / busy / stopping / restarting / crashed states, separately for service and deployment. A verification operation may also be queued / cancelled / restoring / failed; these are not states of every server.

Rules:

1. Starting B does not stop A. Stopping/restarting B does not change A's snapshots or logs.
2. Centrally reserve ports before spawn. A bind check does not eliminate external races; an actual startup failure releases the reservation and reports its cause.
3. Serialize operations on one run; one engine crash does not terminate the application or other processes.
4. Normal Aplot termination stops owned processes with bounded waits. Minimizing/closing to tray retains runs. Initially there is no separate persistent daemon.
5. Do not stop or kill an external service as an owned process. Clearly show managed/external status; distinguish model-mutating actions from observation.
6. A shared Ollama service has multiple consumers; stopping one deployment does not kill everyone else's service. Check model/context conflicts.
7. Native llama.cpp router is one service with a route set. The first migration reproduces the current profile set; subsequently apply changes only to routers referencing those profiles. Recovery restores that router's consistent set, not unrelated newly created profiles.
8. Recovery stores a working snapshot per run/route set. An unsuccessful candidate cannot destroy the working revision.
9. On application startup, recheck prior run records; PID coincidence does not establish ownership. Restoring a run list automatically is an explicit preference, initially disabled.

Collect hardware once per interval and engine runtime per service; do not poll shared services again for every profile. Bound concurrency, polling rates, log retention and chart history. One endpoint failure must not block all polling.

Memory reservations account for observations and leases without subtracting already-resident memory twice. An estimate does not guarantee allocation; include load peaks, KV, workspaces, pinned RAM, expert caches and SSD I/O. Do not promise one exact formula for every architecture.

## 7. Preserve the current interface

| Existing view | Permitted addition |
| --- | --- |
| Dashboard | Compact run selection/list in the current header; selected-run inference cards and shared hardware cards |
| Configuration | Profile/engine selection and draft; explicit application to a named run using the existing diff |
| Library | Same model/profile tabs; multiple profiles per engine and usage state |
| Performance | Target run/profile, job progress, history filters and measurement conditions |
| Logs | Run/service filtering and a combined journal with clear sources |
| API | Existing reference plus Connect, parameter copying and verification outcome |
| Settings | Engine installations, shared resource/start policies and integration options |

No mandatory new top-level Agent or Runs screen. Discuss a separate view only if existing surfaces prove inconvenient.

The selected run is UI context, not the only running process. Changing selection does not stop a server. With multiple runs, Stop, Restart and Rollback name their target. Global actions such as Stop All are separate. Tray status is aggregate and its actions have unambiguous targets.

Preserve dashboard layouts. Inference history belongs to a run; shared hardware history is not duplicated. Do not sum incomparable engine throughput figures into a total without defining the metric.

## 8. Model catalog, selection and benchmarking

### 8.1 Models

Retain the current `models/` root; restructuring does not automatically move existing weights. Register file sets/dependencies: primary/shards, tokenizer, mmproj, LoRA, MTP/draft, n-gram, prepared config and Ollama blobs/manifests. Account for shared files/hardlinks separately from logical model size.

Catalog IDs must not lose favorites when paths change or incorrectly deduplicate different quantizations. Prefer existing digests/checksums; otherwise explicitly describe identity confidence. Do not hash tens of gigabytes every time a view opens.

Show dependencies and active consumers before deletion. Do not delete an in-use file set before stopping its consumers; consider other models referencing shared files. Account for hardlinks when estimating physically freed space or state that the amount is unknown. A missing file produces a missing state rather than erasing associated profiles.

Downloads/imports are cancellable jobs with staging, integrity checks and completed registration. Preserve Ollama pull/import and local imports; add generic download sources for other formats through separate adapters when needed. Retain source/license metadata when available rather than inventing it.

### 8.2 Selection

Three evidence levels: estimate → verified startup → measured workload/context. Minimum context is a hard user requirement. Speed / context / balanced goals rank eligible candidates only; bit width and recall do not determine general coding/reasoning quality.

The first complete selection workflow supports llama.cpp on local hardware; follow with engine-specific Strata/Infernix strategies, then QwFNfer/Ollama within exposed controls. All engines retain manual operation from the first migration stage. A general llama.cpp estimator is not verified MoE/pinned-memory allocation evidence.

Consider simultaneous residency: fits alone differs from fits alongside current runs. Temporarily occupied memory differs from permanent incompatibility. Trials do not change profiles, recovery, routers or settings; they have separate runId and purpose.

### 8.3 Verification and measurement

BenchmarkJob includes a cancellation token, time/candidate budget, resource lease and correlationId. Initially serialize jobs sharing a GPU/service. Never automatically stop unrelated runs; show a resource-release plan and retain original snapshots if a trial needs to suspend work.

Cancellation interrupts requests/waits and releases its processes/leases. Restoring an affected run has its own outcome. Successful cancellation does not hide a restoration failure.

Preserve throughput, exact recall, continuity and history. Record model/binary identity, parameters, hardware/driver when available, resource availability, other active runs, protocol version, seed, actual tokens, output reserve, raw evidence and missing metrics. Label cold/warm prefixes, process startup and OS file-cache state separately; do not claim cache eviction without actually performing it.

Complete comparisons run sequentially under comparable conditions. Define repetitions and candidate ordering in the protocol when close results influence selection. Old measurements remain historical; do not assign new conditions to old results.

## 9. External harness connections

Main workflow: select a ready run → Connect in the current API view/header → choose harness → inspect parameters → apply → inspect outcome. Do not require the user to re-enter data Aplot already knows.

| Mode | Outcome |
| --- | --- |
| Automatic | Adapter uses supported API/CLI/config mechanisms of a particular version; preview diff, backup, verification and undo |
| Assisted | Ready file/snippet/command specifying where to apply it and the remaining action |
| Manual | Copy base URL, exact model ID, authentication method and actual configured context individually or as a block |

Adapter contract: discover installation/version, read relevant configuration, validate compatibility, create preview, apply, verify and revert its changes. Recompute the diff if a file changed after preview; undo must not overwrite subsequent external edits. Multi-file updates require an operation journal and compensating rollback, not a promise of a filesystem-wide transaction.

Preserve user providers, models, comments and unknown fields as far as the format allows. Re-adding the same connection is idempotent. The harness remains a separate application; automatically starting its agent tasks is not part of adding a connection.

Build ConnectionTarget from the live run/API rather than the selected editor draft. Use the actual model ID, correct URL suffix, current credentials and configured context, not the model card's maximum context.

Keep verification statuses separate: configuration prepared / written / endpoint responds / model responds / verified from harness. Aplot-side checks do not prove reachability from WSL, a container or another machine. Different network environments need appropriate endpoints and checks.

Choose the first automatic adapter with the user. Before implementing it, inspect official documentation and actual configuration for the selected version; no particular harness names/support promises are fixed yet. A second adapter validates extension without modifying core logic.

Discuss an optional local gateway after the first direct connection. Stable endpoints/aliases require correct streaming, cancellation, authentication and model discovery. Start with transparent forwarding for one selected protocol, normally OpenAI Chat Completions; do not claim Responses/Anthropic support without implementing and verifying it. Reject unsupported requests explicitly rather than silently translating them. Rebinding an alias does not change an in-flight request; stopped targets return clear errors. On-demand loading/fallback policies are separate future work.

## 10. RU/EN documentation and learning path

Write documentation alongside implementation, with matching `app/docs/ru/` and `app/docs/en/` structures. This bilingual plan is the initial map, not completed documentation of future code.

Proposed contents:

| Section | Required depth |
| --- | --- |
| `overview` | Application purpose, scope, module map and entity glossary |
| `architecture` | Dependencies, responsibilities and start/stop/error sequences |
| `code-map` | Actual files, entry points and layer transitions |
| `modules/*` | Purpose, contracts, state, invariants, dependencies, concurrency, errors and real examples |
| `configuration` | Every supported parameter: units, defaults, auto, dependencies, restart and memory/performance effects |
| `data` | Tables/JSON, migrations, backups, import/export, recovery and compatibility |
| `ipc` | Commands/events, payloads, errors, generations, cancellation and guarantees |
| `engines/*` | Installation, formats, capabilities, launch translation, runtime mappings and limitations |
| `harnesses/*` | Supported versions/environments, applying, verifying and reverting connections |
| `benchmarks` | Protocols, metric interpretation, limitations and reproducibility |
| `recipes` | Add an engine, parameter, model source, test or harness adapter |
| `troubleshooting` | Concrete symptom → evidence sources → cause identification → action |
| `learning-path` | Code-reading sequence from initial launch to extending the system |
| `decisions` | ADR: context, alternatives, decision, consequences and reconsideration conditions |

For every end-to-end workflow: initial state → UI action → store/service → IPC → backend → engine/storage → events → UI; include success, failure and cancellation. Required examples: Infernix startup, profile change/restart, two engines, router/Ollama, trial/restoration, harness connection and model deletion with dependencies.

Explain public function purposes, key internal algorithms, relationships and tests rather than paraphrasing every line in comments. Rustdoc/TSDoc describe contracts and nontrivial constraints; decision rationale belongs near the code and in ADRs.

Freshness policy: matching section IDs, schema/contract versions, actual symbol links and implemented/planned labels. Generate schema references where this prevents drift. CI checks local links, RU/EN section parity, parameter-reference completeness and translations. Review checks explanation accuracy; a valid link does not prove correctness.

## 11. Implementation stages

The target stage criteria remain below; their presence does not mean completion. Actual results and unchecked items are listed in [progress](IMPLEMENTATION_STATUS.en.md). S/M/L/XL indicates relative complexity, not a schedule promise. Each stage produces a verifiable working revision.

### P00 — Baseline, audit and UI preservation criteria [M]

**Tasks:** capture the working tree including current changes; build the current dependency/workflow map; inventory settings/profile fields and side-effect paths; verify build/test commands; capture existing UI reference states. Use a copied database and isolated installation root, not the working installation for tests.

**Deliverables:** baseline report, known-defect list, file migration map, visual reference and initial ADRs. Agree D01–D03 and the first external integration D04.

**Acceptance:** the current startup path of every available engine and major UI actions have documented scenarios; known failures are visible. Cover profile/import/export/recovery, router/Ollama, layout, tray and singleton. Missing engines/models are unavailable, not passed.

**Rollback:** retain the original build and consistent backup. Documentation: overview, actual code map and baseline checks.

### P01 — Domain contracts and compatible facade [M]

**Tasks:** introduce section 3 entities, IDs, snapshots, capability/error/event types and repository interfaces. Define IPC/profile format versions. Route existing actions through a facade without changing single-run behavior.

**Deliverables:** domain modules, typed bridge, dependency design and fixtures.

**Acceptance:** normal startup, metrics and profiles behave as before; domain does not import React/Tauri/SQL. Target contracts serialize across Rust↔TS without losing engine-specific fields.

**Rollback:** switch callers back to the legacy path; no database restructuring yet. Documentation: entities, contracts and command flow.

### P02 — Profiles for all engines and storage migrations [L]

**Tasks:** migrations, profile v2, default/override resolution, revisions, secret references and compatible import. Preserve old profiles and turn global engine settings into complete profiles. Initially use legacy path references for artifacts until P06.

**Deliverables:** every current engine supports multiple independent saved profiles; configuring one does not overwrite others. Choose D06 and migrate credentials without losing access.

**Acceptance:** migrating a real-data copy preserves IDs, values, favorites, layout, history and recovery; migrations are repeatable/idempotent and failures roll back transactions. Verify v1/raw import and v2 round trips; missing paths do not delete records.

**Rollback:** close the new version and restore its full consistent backup with the prior EXE. Prevent the old EXE from opening an incompatible new schema. Documentation: complete schema and return procedure.

### P03 — Five engine adapters, initially one run [L]

**Tasks:** extract preparation, validation, capabilities and runtime mappings from current branches. Wrap existing working implementations one engine at a time; do not rewrite native kernels. Define Ollama/router service/deployment semantics.

**Deliverables:** a common startup use case with explicit adapters; settings/capability registries preserve current controls.

**Acceptance:** compare CLI/config/request behavior against baseline; the library cannot send a native artifact to an incompatible engine; unsupported and unknown remain distinct. Run available-installation smoke checks and mapping/auth/error tests including native-router and Ollama paths.

**Rollback:** switch the affected adapter back to its legacy implementation. Documentation: five engine manuals and new-adapter recipe.

### P04 — Multi-service/run backend supervisor [XL]

**Tasks:** replace the single current process with a registry; scoped generations, operations, ownership, ports, event routing and shutdown. Add run listing/history and individual recovery. Implement shared-service reference tracking for Ollama/router.

**Deliverables:** backend independently starts, observes, stops and restarts multiple targets; the old UI temporarily controls the selected target through the facade.

**Acceptance:** A+B work; stop/restart/crash of B does not alter A; one occupied port does not break others; late B events cannot update A; repeated Start does not duplicate processes. Quit stops owned services while retaining external ones. Lightweight fixtures cover races without large weights.

**Rollback:** temporarily limit the new manager to one run after cleanly stopping others; return to P03, restoring backups for schema changes. Documentation: locks, state machines, generations and ownership.

### P05 — Multiple runs in the existing UI [L]

**Tasks:** domain slices/selectors; separate runtime/log/history; integrate run selection in the existing header, filters and endpoints. Move polling/subscriptions out of App. Clarify tray/restart/recovery actions.

**Deliverables:** one window manages multiple runs in the current visual style; changing selection does not affect servers.

**Acceptance:** compare against P00 visuals; RU/EN, both themes, saved layout, long names, keyboard, 1100×720/1500×900 and Windows scaling 100/150/200%. Preserve unfinished drafts while switching; selected runtime never receives another run's settings. Actions have explicit targets.

**Rollback:** restore the selected-run facade UI without deleting other run records. Documentation: updated UI→backend flows and run-management guide.

### P06 — Model file sets and dependencies [L]

**Tasks:** artifact manifest/index over existing directories, shared files, digest/confidence, missing states and file dependencies; bind profiles to artifacts without moving weights. Preserve import/pull and document cancellation/staging/integrity.

**Deliverables:** users can understand model location, consumers and file composition; profiles no longer depend solely on an arbitrary single path.

**Acceptance:** distinguish primary/shards/MTP/ngram/mmproj; migrate favorites and legacy paths; do not count shared n-grams/hardlinks as two physical copies. Deletion preview lists all consumers; active files cannot be deleted. Test incomplete sets, cancelled import and shared files in fixture directories.

**Rollback:** rebuild the index from existing directories; restructuring does not require reversing weight moves. Documentation: storage, manifests, verification and deletion.

### P07 — Shared resource accounting and selection [L]

**Tasks:** hardware service, resource leases, allocation peaks and explained admission; adapt the existing hardware planner. Common pipeline begins with llama.cpp, followed by measured Strata/Infernix strategies; QwFNfer/Ollama follow confirmed capabilities.

**Deliverables:** recommendations account for running models, required minimum context and user priorities. Trials are isolated; estimates differ from measurements.

**Acceptance:** concurrent starts cannot reserve the same free budget; unknown memory remains unknown; occupied ≠ incompatible; never lower minimum context. Cover offload, pinned RAM, workspaces and shared services. Verified profiles retain conditions rather than being declared universally suitable.

**Rollback:** retain manual runs and previous advisory estimates; disable automatic recommendations. Documentation: estimator formulas/limits and ranking rationale.

### P08 — Benchmark jobs, isolation and evidence [L]

**Tasks:** move existing suites/optimizer to jobs, cancellation and leases; scoped progress; preserve snapshots, provenance, raw evidence and restoration outcome. Adapt the existing trial plan rather than implementing a competing version.

**Deliverables:** selection/tests work alongside multiple servers without mixing history or silently affecting working connections.

**Acceptance:** successful, failed and cancelled trials do not change profiles/recovery; late progress belongs to its job. Recall/continuity use actual token counts when supported; missing APIs are unavailable. Distinguish cold/warm and background loads. Old results remain readable; comparisons are reproducible.

**Rollback:** use existing suites through the selected run while preventing resource conflicts; saved results remain readable. Documentation: exact protocols, result format and interpretation limits.

### P09 — Universal manual/assisted connection [M]

**Tasks:** ConnectionTarget, ID discovery and endpoint/auth checks; field/block copying, data export and entry points in the current API reference. Separate server settings from client connection status.

**Deliverables:** connect a ready model manually in a few actions without reading logs or command lines.

**Acceptance:** parameters match the selected live run, router profile ID and Ollama tag; hide secrets until explicit reveal/copy; stopped targets are not ready. Check streaming, HTTP/SSE errors, authentication and cancellation; tool/vision/context claims show their evidence.

**Rollback:** keep the current API reference and direct endpoints. Documentation: manual connection and network-environment differences.

### P10 — Automatic harness adapters [L]

**Tasks:** choose the first harness/supported version, inspect official integration mechanisms; preview/backup/apply/verify/undo and operation journal. Validate reusable contracts with a second adapter.

**Deliverables:** priority Connect workflow for selected harnesses; export/copy fallback for others.

**Acceptance:** preserve existing configs/providers/comments within format limits; repeat application does not duplicate records; detect edits between preview/apply. Partial failure and undo after external edits must not overwrite user changes. Distinguish verification from the harness from Aplot-only checks.

**Rollback:** revert only journaled changes; conflicts produce a restoration diff. Documentation: each integration, supported versions and adapter recipe.

### P11 — Optional stable API gateway [L, separate decision]

**Tasks:** after D05, if needed add a small Rust HTTP server, persistent aliases, discovery, authentication, streaming/cancellation/backpressure and accurate target-state errors. Preserve direct endpoints.

**Deliverables:** harnesses can retain their address/model name across backend changes; the gateway belongs to the single Aplot instance.

**Acceptance:** compare identical direct/proxied requests and measure added latency; stopping/rebinding an alias cannot redirect an in-flight stream. Cover client disconnect, HTTP 200 SSE error, slow clients, unknown fields/methods, idle timeouts and request sizes.

**Rollback:** disable the gateway and provide a direct ConnectionTarget without losing profiles. Documentation: protocol matrix, aliases, limits and diagnostics. This stage can be skipped; P12 does not depend on it.

### P12 — Complete transition, documentation and release [L]

**Tasks:** remove the legacy facade only after migrating callers; resolve dependency violations; check RU/EN parity; prepare release artifacts, hashes and migration/rollback instructions. Run end-to-end checks in an isolated installation copy, then agree use of the working database.

**Deliverables:** a working release with the current UI, five adapters, multiple runs, profiles, laboratory and verified connections.

**Acceptance:** complete section 12 matrix; documented parameters/public contracts; recipes allow adding engines/harnesses without widespread core/UI edits. Publish known limits; do not report prior measurements as new ones. Restructuring is complete only after preserving user data and validating user workflows.

**Rollback:** retained EXE plus compatible database backup; instructions account for harness config changes and optional gateway. Documentation is part of release readiness, not deferred work after release.

## 12. Verification matrix

| Area | Required scenarios |
| --- | --- |
| Data | v1/raw/v2 import, repeated/failed migrations, existing settings/layout/history/keys, known-good snapshots, missing paths |
| Lifecycle | A+B, same/different engines, repeated start, stop during loading, restart, crash, occupied port, late events |
| Shared service | Router routes, Ollama load/unload, same-tag conflicts, multiple consumers, external endpoint |
| Resources | Concurrent reservations, allocation failure, unknown estimates, shared GPU, released leases, restore failure |
| Benchmarks | Old/new results, SSE errors, token-count unavailable, cancellation in each phase, comparable cold/warm conditions |
| Harness | Preview/apply/repeat/partial failure/undo/conflict, credentials, actual model and different network environments |
| UI | Existing navigation/cards/layout, RU/EN, themes, scaling, keyboard, target actions/tray/singleton |
| Documentation | Section/parameter parity, local links, actual symbols, recipes, implemented vs planned |
| Gateway, if enabled | SSE fidelity, cancellation/backpressure, errors/auth, alias routing, latency, target shutdown |

Three levels: rule unit tests, contract/integration tests with lightweight fixture processes/mock HTTP, and native end-to-end tests using available models. Prove multi-process control with small models; test heavy Flash-Next separately within its budget. Insufficient resources for two large models test honest admission, not a claim that unusable launches are supported.

Current commands from `app/` (confirmed in manifests/CI, not rerun while preparing this plan):

```powershell
npm run build
npm test
npm run verify:source
python -m unittest discover -s tests -p "test_*.py"
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

For releases: `npm run tauri:build` and actual EXE/installer checks. Add contract/migration/documentation checks to CI without replacing native verification. Run relevant checks for small changes and the full gate at stage/release completion. Previous passing tests do not constitute validation of future restructuring.

## 13. Sequence, priorities and collaboration

Dependencies:

```text
P00 → P01 → P02 → P03 → P04 → P05
                                  ↓
                                 P06 → P07 → P08
                                  ↓
                                 P09 → P10
                                         ↓ subject to D05
                                        P11 (optional)
P05 + P06 + P07 + P08 + P09 + P10 → P12
```

P09 can follow P05 if ConnectionTarget works with temporary artifact references. Documentation accompanies every stage. Parallel tasks do not imply multiple people editing the same files; delegation is discussed separately.

Verifiable milestones:

- **M1 — internal foundation:** P00–P03. Current UI and single-run workflows work; all engines have profiles.
- **M2 — multiple runs:** P04–P05. One window independently controls multiple services/models.
- **M3 — laboratory:** P06–P08. Models, resources and measurements use the new run model.
- **M4 — convenient connection:** P09–P10. API copying and initial automatic adapters.
- **M5 — ready release:** P12; include P11 only by separate decision.

Before each stage, jointly establish expected behavior and examples. Then deliver small complete changes, show them in the current UI, check data/regressions, update both documentation languages and record outcomes. Refine effort/scheduling after P00 and the first transition; do not make calendar promises before the audit.

Task template: stage ID, user workflow, input/output, affected contracts/files, migration/rollback, acceptance checks, RU/EN documentation, evidence and limitations. Update the plan after agreed decisions rather than keeping it frozen.

## 14. Decisions to establish

| ID | Proposed initial choice | Decision point |
| --- | --- | --- |
| D01 | One application, existing UI/stack; internal modules and one Rust crate | P00; main boundaries already agreed by the user |
| D02 | Individual lifecycle plus shared Ollama/router services; concurrent runs without automatically killing neighbors | P00–P01 |
| D03 | Existing views; compact header run selection and API-view connections | P00/P05 before visual changes |
| D04 | User chooses the first harness; universal manual fallback | Before P10 research/implementation; does not block P00–P09 |
| D05 | Direct endpoints first; gateway as a separate optional stage | After P09/first connection |
| D06 | Secret references and Windows storage accounting for portable mode | P02 before credential migration |
| D07 | Normal Quit stops owned services; tray retains them; persistent daemon out of scope | P04 |
| D08 | Existing models root without automatic weight relocation; common index/dependencies | P06 |

D04–D07 contain open details. A proposed choice does not constitute user authorization for future external configuration writes or changed application-exit policies. Those actions belong to their respective user workflows.

## 15. Definition of completion

The plan is implemented when the current UI is preserved; multiple runs are independent and observable; all five engines have complete profiles; the catalog shows actual file sets; selection/tests account for hardware and other runs; API connections work manually and through selected verified harness adapters; migration/rollback are proven; and RU/EN documentation traces every main path from UI to engine and provides concrete module-extension recipes.

At preparation time, only this document is complete. Architectural changes, migrations, new checks and harness connections have not been implemented.
