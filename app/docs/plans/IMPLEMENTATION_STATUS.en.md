# Restructuring progress

[Plan](MODULAR_RESTRUCTURING.en.md) · [Русский](IMPLEMENTATION_STATUS.ru.md)

Edition: 2026-10-12. This iteration is closed and all three parallel workstreams are integrated in the working tree. This does not declare all P00–P12 complete; remaining criteria are listed below.

Concurrent-run fix: the current build is [multi-run-fix-2026-10-12](../../../releases/multi-run-fix-2026-10-12/README.md). The UI enables automatic free-port selection for owned processes and synchronizes the actual endpoint and snapshot without rewriting the saved profile. API Docs initially selects the dashboard run. Validation passed 225 frontend tests, 123 native tests and the Windows integration test; the actual CPU smoke now gives both servers the same preferred port. Isolated native UI verification confirms two active router runs on different ports, with second-run API generation and streamed UI verification. Evidence: `app/artifacts/multi-port-fix-2026-10-12/`.

Launch-fix addendum: the current build is [launch-fix-strata-2026-10-12](../../../releases/launch-fix-strata-2026-10-12/README.md). Duplicate API route names and attempts to rewrite an active router preset were corrected. Validation now includes 223 frontend tests and 297 server tests for Strata v0.1.43. An isolated database copy was used for native desktop router start/restart with duplicate profile names, responses from both routes and the actual API Docs model ID. Strata desktop start and Qwen IQ2_XS generation with context configured to 131072 also passed. Normal close cleaned up owned processes in both cases. These results supplement the original iteration results below; tray, single-instance, all GPU combinations and full-context benchmarks remain outside this acceptance. Evidence: `app/artifacts/launch-fix-2026-10-12/`.

| Stage | Delivered in this iteration | Remaining acceptance |
| --- | --- | --- |
| P00 | 293 baseline files, patch/manifest, consistent SQLite backup; baseline gates passed | Full native UI scenarios/scaling comparison |
| P01 | Domain profiles/artifacts/secrets; launches/jobs/connections/resources features; compatible store facade | Further decomposition of the large control store, complete contract catalogue |
| P02 | Additive migration, five-engine profiles, revisions, import/export, DPAPI refs/resolver, immutable LKG and duplicate rebind | Final combined frontend/backend acceptance |
| P03 | Engine dispatcher and existing five typed builders, bind endpoint consistency | Pinning binary versions/external configuration contents; real launches for every engine |
| P04 | Run registry, generations, ports, independent stop/restart, shared Ollama ownership, quit cleanup | Real GPU engine combinations, native quit/tray/single-instance acceptance |
| P05 | Run selection, separate drafts/logs/history/runtime, preserved UI shell | Both languages/themes, long names, keyboard and native Windows 100/150/200% |
| P06 | Metadata catalogue, shared files/hardlink sizes, native shards, Ollama manifests, consumers/dependencies, missing references; real root: 103 artifacts/110 files without missing/issues | Destructive deletion is not enabled |
| P07 | Advisory RAM/GPU/KV ranges, read-only native request bridge, explicit estimate button, active-run uncertainty | Calibrated engine/model strategies; estimates are not OS reservation/admission |
| P08 | Scoped cancellable jobs, checkpoint/outcome storage, exclusive measurement lease, isolated optimizer trial; optimizer wrapper snapshots; real CPU job core → persisted result | Full native UI → job → persisted result acceptance |
| P09 | Concrete ConnectionTarget, model discovery, copying and cancellable API checks | Full native GUI connection acceptance |
| P10 | Hermes, DeepSeek Harness, Pi, OpenClaw registry/snippets/previews | Automatic connection deferred by the user; harness configs unchanged |
| P11 | Not enabled | Optional gateway needs a separate decision; direct endpoints remain |
| P12 | RU/EN module documents, parity/link checker in CI/release script, final gates and EXE build | Extended desktop acceptance before a full release declaration |

Final checks on October 12: frontend 34 files/220 tests; native 122 passed/6 ignored plus a separate Windows integration test; fmt, source/contracts, RU/EN docs and release build passed. Docs checker: 18 pairs/342 local links. Six environment-dependent tests are excluded from the normal run; migration-copy, real catalogue, CPU multi-run and CPU job were run explicitly and passed. Warnings remain for frontend chunk size, a mixed Tauri import and unused resource ledger prototypes.

Iteration build: `releases/modular-preview-2026-10-12/Aplot-Control-LLM.exe`, manifest version 0.8.2. This is a modular restructuring preview; the earlier build is preserved. The native desktop loads embedded assets; a debug DB copy verified the RU interface, hardware telemetry, profile/run selection, configuration/library/settings pages and 110% scale. The required Tauri webview zoom permission was added. Full desktop smoke remains incomplete: Computer Use could not correctly click a WebView dropdown option (`point ... is over msedgewebview2.exe ... not target window`). The test stopped after the retry failed; GUI launch/quit/tray are not claimed as verified. The isolated app was stopped; tests did not use the working DB.

The real CPU smoke uses two llama.cpp servers with Qwen2.5 0.5B: both generate, duplicate start, port conflict, peer stop/restart/crash, and shutdown. It does not establish GPU fit or 131072 support for every engine. A separate API fixture verifies shared external Ollama: targeted unload, common endpoint identity, measurement lifecycle exclusion, and external service survival.

Copy migration: 40 legacy profiles plus four global-engine profiles produce 44 v2 records; old tables/settings/recovery are compared with the original bytes. The working user DB was not launched through a test application. Weights are neither moved nor deleted in this iteration.

Evidence lives in `app/artifacts/restructuring/`: `baseline/`, `user-data-preservation.json`, `migration-copy-report.json`, `model-catalog-report.json`, `native-runs.json`, `native-job.json`, `native-ui-report.json`, and each parallel chat's handoff. The October 12 comparison confirms exact preservation of rows/values in all five original working DB tables. Evidence files are ignored by Git; they do not replace source and reproducible tests.
