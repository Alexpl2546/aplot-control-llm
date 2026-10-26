<a id="resources"></a>
# Модуль планирования ресурсов

<a id="scope"></a>
## Границы и статус

Часть P07 содержит чистое рекомендательное планирование в [resource_planner.rs](../../../src-tauri/src/resource_planner.rs) и [planner.ts](../../../src/features/resources/planner.ts); TypeScript-контракт находится в [types.ts](../../../src/features/resources/types.ts). Rust также предоставляет локальный реестр числовых резервов с mutex. Зарегистрированный [resource_service.rs](../../../src-tauri/src/resource_service.rs) подключает native hardware, snapshots активных запусков и заголовки GGUF к planning; [ResourcePlanPanel.tsx](../../../src/features/resources/ResourcePlanPanel.tsx) показывает результат в configuration UI.

Чистый planner получает telemetry и metadata извне. Native service собирает входы только для чтения: не меняет engine options, не записывает SQLite, не управляет процессами, не применяет варианты и не создаёт leases. Числовой резерв защищает переданный бюджет реестра, а не OS allocator. Посторонние allocations и неточная metadata могут привести к отказу запуска. Реестр не подключён к production launch admission. Planner сохраняет legacy request IDs для консервативных unknown estimates; это не означает, что такие движки всё ещё можно установить или запустить в приложении.

<a id="contract"></a>
## Контракт v1 и точки входа

Все объёмы памяти задаются в **байтах** как неотрицательные safe integers до `2^53 - 1`, включая Rust `u64` на JSON-границе. Счётчики в указанных местах должны быть положительными. KV bytes per element допускают положительные дробные значения до 8, включая overhead блоков quantization. Отрицательные, нечисловые, переполненные, противоречивые и дублированные данные отклоняются. `ram` и `pinnedRam` не могут быть GPU ID. Rust использует camelCase serde names.

| Точка входа | Контракт |
| --- | --- |
| TS `accountResources(input)` / Rust `account_resources(&AccountingInput)` | Учёт occupied memory, включённых observations, резервов, caps, spare и возраста snapshot. |
| TS `planResources(input)` / Rust `plan_resources(&ResourcePlannerInput)` | Возвращает `ResourcePlan` либо ошибку валидации. Резервы не создаёт. |
| Legacy TS `mapInfernixBudgetSettings(settings, gpuId, knownAllocationFloors?)` / Rust `map_infernix_budget_settings(&InfernixBudgetSettings, &str, Option<&ResourceAmounts>)` | Совместимость с сохранёнными настройками Infernix: переводит raw configuration units в spare и информационные budgets. Floors требуют отдельного явного внешнего источника. Это не активная интеграция движка. |
| Rust `ResourceLeaseRegistry::default()` | Новый независимый реестр в памяти; вызывающий код должен владеть одним реестром на приложение. |
| Rust `snapshot()` | Возвращает `{ revision, claims }`. |
| Rust `try_claim(&AccountingInput, ResourceClaim, Option<u64>)` | Атомарно учитывает authoritative registry claims и внешние claims, затем вставляет числовой резерв. Expected revision обнаруживает устаревшее решение. |
| Rust `release(claim_id, owner_id, generation)` | Удаляет только совпадающий claim; отсутствующий claim — идемпотентный no-op. |

TS validation выбрасывает `ResourcePlannerError` с `code: "invalidInput"`. Rust возвращает `PlannerError { code, message }`; коды реестра — `invalidInput`, `conflict`, `insufficient`, `unknown`, `poisoned`. Некорректный JSON может быть отклонён десериализацией до вызова функций.

<a id="inputs"></a>
## Входные данные

`ResourcePlannerInput` состоит из `hardware`, `claims`, `observations`, `request`. `AccountingInput` использует первые три поля.

| Объект | Поля и смысл |
| --- | --- |
| `HardwareBudget` | `snapshotId`, `snapshotAgeMs`, `maxSnapshotAgeMs`, `ram`, необязательный `pinnedRam`, `gpus` по устойчивому device ID. Caller вычисляет возраст непосредственно перед допуском. |
| `PoolBudget` | Необязательные `totalBytes`, `observedUsedBytes`, `freeBytes`, `limitBytes`; обязательный `spareBytes`. `limitBytes` — общий глобальный allocation cap. Total capacity сама по себе не free capacity. |
| `ResourceClaim` | `claimId`, `ownerId`, `generation`, `amounts`. Owner обозначает процесс/shared service, не профиль или файл. |
| `ResourceAmounts` | `ramBytes` уже включает `pinnedRamBytes`; `gpuBytes` — карта устройств. Это явные резервируемые объёмы, а не измерения. |
| `ResourceObservation` | `snapshotId`, `ownerId`, `generation`, необязательные `ramBytes` / `pinnedRamBytes`, `gpuBytes`. Данные должны уже входить в тот же global hardware sample. Отсутствующие поля не атрибутированы. |
| `ResourceRequest` | `engine`, `model`, `contextTokens`, `minimumContextTokens`, `options`. Minimum context положителен и не превышает настроенный context. |
| `ModelResourceMetadata` | Необязательный `artifactBytes`; `format` (`gguf` / `other` / `unknown`), `weightsComplete`, `architecture` (`dense` / `moe` / `unknown`), `attention` (`standard` / `other` / `unknown`), необязательный `kv`. |
| `KvMetadata` | `layers`, `kvHeads`, `keyHeadDim`, `valueHeadDim`, `keyBytesPerElement`, `valueBytesPerElement`. Только uniform full-cache MHA/GQA layers. |

`artifactBytes` должен суммировать полный набор primary weight shards по одному разу. Filesystem hard-link deduplication не доказывает общий allocation у двух процессов. Projector/draft/MTP/LoRA/ngram требуют отдельного memory evidence; при непокрытой памяти dependencies устанавливайте `unmodelledAllocations: true`. Размер MoE-файла намеренно не используется как минимум resident memory.

<a id="options"></a>
## Engine options и mapping конфигурации

Обязательные поля `EngineResourceOptions`: `placement`, `kvOnGpu`, `kvCapacityScalesWithContext`, `unmodelledAllocations`, `extraRamBytes`, `pinnedRamBytes`, `extraGpuBytes`, `gpuBudgetBytes`, `spareRamBytes`, `spareGpuBytes`. Необязательные: `gpuId`, `gpuLayers`, `kvCapacityTokens`, `workspaceRam`, `workspaceGpu`.

Универсальные placement `allGpu`, `hybrid`, `cpu` разрешены только для `llama_cpp`; другие движки используют `engineManaged`. GPU placement требует явный device ID. Hybrid требует явный layer count не выше известного количества слоёв. CPU placement не может offload KV. Стратегия моделирует один target GPU и не складывает свободную VRAM разных устройств. Multi-GPU tensor split требует отдельной стратегии и здесь должен оставаться unknown.

`kvCapacityTokens` — **фактическая общая ёмкость cache cells**, не context одного slot. Caller обязан разрешить semantics `-c`, parallel, unified cache и padding установленного build. Неявного parallel multiplier нет. `kvCapacityScalesWithContext` разрешает пропорциональное уменьшение capacity только после подтверждения этого отношения адаптером. Context никогда не опускается ниже `minimumContextTokens`.

`workspaceRam` / `workspaceGpu` — envelopes `{ min, max }`; `max: null` означает отсутствие верхней границы. Переданные границы повышают confidence dense non-hybrid только до `medium`: allocator всё ещё не проверен. Известные extra allocations должны иметь внешнее подтверждение и быть disjoint: `extraRamBytes` исключает pinned. Raw configuration budgets не являются allocation floors.

| Концепция конфигурации | Mapping входа |
| --- | --- |
| Общий usable RAM/VRAM budget | Pool `limitBytes`; для применения требуется known global usage. |
| Общая spare memory | Pool `spareBytes`. |
| Engine RAM/VRAM headroom | `spareRamBytes` / `spareGpuBytes`; эффективный spare — максимум global и engine spare, поэтому одна safety margin не вычитается дважды. |
| GPU budget конкретного run | `gpuBudgetBytes[deviceId]`; ограничивает allocation этого кандидата отдельно от global free memory. |
| Legacy Infernix pinned/resident allocations | Только внешне подтверждённые `pinnedRamBytes`, `extraRamBytes`, `extraGpuBytes`; общая верхняя граница unknown. Нет вывода RAMhead/hostchunks из settings. |
| Legacy Infernix expert RAM setting | Информационный `configuredExpertRamBudgetBytes`; zero/auto становится null. Это не measured resident allocation и не RAM floor. |

Legacy helper `mapInfernixBudgetSettings` принимает raw `ramHeadroomMiB`, `vramHeadroomMiB`, `expertRamMiB`, `hostContextMiB`, `prefillChunk`. Только headroom MiB переводятся в spare bytes. Expert RAM остаётся информационным configured budget; host context — информационным `configuredHostContextPoolBytes`. Resident/pinned memory из них не выводится. `prefillChunk` возвращается без изменения с `prefillChunkUnit: "unverified"`: модуль не проверял chunk units engine allocator и никогда не считает это значение MiB/bytes.

Без отдельного аргумента `knownAllocationFloors` mapped RAM/pinned/GPU floors равны нулю, `allocationSource` — `configurationOnly`. Явный внешний `ResourceAmounts` создаёт `externalAllocationFloors`; его `ramBytes` включает pinned, поэтому helper вычисляет `extraRamBytes = ramBytes - pinnedRamBytes`. Mapping всегда возвращает `unmodelledAllocations: true`, reasons и не даёт конечного fit envelope. Числовой pinned budget не гарантирует OS/CUDA pinning: ограничения pinning и fragmentation требуют runtime evidence.

<a id="accounting"></a>
## Учёт occupied memory без двойного подсчёта

Для каждого pool baseline free берётся как минимум переданных `freeBytes` и `totalBytes - observedUsedBytes`, используя известные величины. Общий `limitBytes` дополнительно ограничивает его значением `max(0, limitBytes - globalUsed)`. Global usage задаётся явно либо выводится из known total/free pair. Один total не означает idle device.

Резерв уменьшает только observation с совпадающими **snapshot ID, owner ID, generation**, и только при known global usage. Остаточный резерв — `max(0, reserved - includedObserved)`. Доступная память — `max(0, baselineFree - sum(residualReservations) - spare)`. Stale/unattributed observations не уменьшают резервы. Если включённые observations владельцев в сумме превышают global observed usage, вход отклоняется без предположений о пересечении.

Пример: у GPU 16 GiB глобально занято 8 GiB, включая 4 GiB процесса с резервом 6 GiB. При spare 1 GiB доступность равна `16 - 8 - (6 - 4) - 1 = 5 GiB`. Добавление полного резерва поверх измеренной памяти процесса посчитало бы allocation дважды. Посторонние процессы остаются частью global 8 GiB даже без claims.

Pinned allocation отдельно проверяется pinned pool, но его байты уже входят в RAM и повторно к RAM не прибавляются. Duplicate claim IDs и owner/generation claims отклоняются. Вызывающий код обязан агрегировать ownership общего router или service; model ID не является allocation owner. Unattributed reservations учитываются консервативно и могут отклонить фактически возможный запуск до появления точной атрибуции.

<a id="estimates"></a>
## Приближение dense llama и честные unknown результаты

Ограниченное приближение требует `llama_cpp`, полный GGUF, dense architecture, standard uniform attention, все KV dimensions/types, фактическую KV capacity, explicit placement и отсутствие unmodelled allocations. В противном случае возвращаются только явные RAM/pinned/GPU floors с `max: null`, `source: "knownFloorsOnly"`, `confidence: "unknown"`. Strata и все legacy engine IDs, принимаемые planner, остаются unbounded; MoE, SWA, MLA, recurrent и mixed architectures не наследуют generic dense fit claim.

Для подходящего случая:

```text
nominalKV = layers * kvHeads *
            (keyHeadDim * keyBytesPerElement + valueHeadDim * valueBytesPerElement) *
            kvCapacityTokens
KV range = [ceil(nominalKV), ceil(1.10 * nominalKV + 16 MiB)]
```

KV dimensions соответствуют текущему upstream [llama KV cache implementation](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-kv-cache.cpp); другие memory implementations представлены в [llama-memory.h](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-memory.h). Cache capacity/offload нужно сверять с установленным build и его [server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). Padding 10%/16 MiB — engineering allowance этого planner, не upstream гарантия.

Для weight file bytes `W` и offload fraction `f`: CPU использует `f=0`, all-GPU — `f=1`, hybrid — `gpuLayers/layers`. Hybrid расширяет долю на ±0.15 с ограничением `[0,1]` для non-layer tensors. GPU weight range — `[0.95*W*fLow, 1.20*W*fHigh]`. RAM weight/staging range — `[0.95*W*(1-fHigh), 1.25*W]`, сохраняя host staging даже при полном GPU offload. KV добавляется в выбранный pool, известные pinned/extra allocations и workspace — отдельно. Байты округляются вверх.

Без workspace envelopes применяются uncalibrated allowances RAM 256–1024 MiB, GPU 256–2048 MiB с `confidence: "low"`. Hybrid остаётся `low` даже с переданным workspace. Это широкие рекомендательные startup/runtime ranges; copies, mmap residency, sharing cache, batch/ubatch graphs, backend alignment и fragmentation могут их превысить. Они не являются измеренными или доказанными верхними границами.

<a id="results"></a>
## Статусы результата и варианты

`ResourcePlan` содержит `contractVersion: 1`, `availability`, `candidates`, `automaticApplication: false`. Каждый candidate возвращает ID, placement, layer count, context/cache capacity, `estimate`, per-pool `assessments` и статус. Estimate включает информационный `artifactBytes`, `kv` range либо null, RAM/pinned/GPU ranges, confidence, source и reasons.

| Статус | Смысл |
| --- | --- |
| `insufficient` | Известный minimum хотя бы одного pool превышает known available memory либо per-run GPU cap. |
| `unknown` | Нет доказанной insufficiency, но required pool имеет missing/stale availability либо unbounded allocation maximum. |
| `advisory` | Known minima помещаются, но хотя бы одна конечная верхняя оценка пересекает available memory. |
| `withinEstimate` | Все конечные upper estimates находятся внутри переданных accounted budgets. Это не verified fit. |

Приоритет: `insufficient` → `unknown` → `advisory` → `withinEstimate`. Строго нулевая bounded demand не требует telemetry неиспользуемого pool. Configured candidate всегда присутствует. Подходящий llama request дополнительно предлагает all-GPU, half-layer hybrid, CPU и одно уменьшение context; используется explicit known GPU, остальные options сохраняются. Другие движки/unknown strategies имеют только configured advisory target. Варианты не применяются автоматически и не ранжируются как universally best.

<a id="leases"></a>
## Атомарные claims, generations и lifecycle интеграция

Native registry держит lock на протяжении merge, accounting, validation и claim insertion. Одновременные старты не могут оба потратить один registry budget. Exact active claim retry идемпотентен; другие amounts под тем же ID дают conflict. Внешние копии registry claims deduplicate только при полном совпадении; различие — conflict. Наблюдаемый процесс можно принять в реестр с той же identity/sample, резервируя только incremental unobserved amount.

Expected revision проверяется до idempotent retry. После revision conflict вызывающий код должен обновить данные и пересчитать допуск. Owner не может иметь два active registry claims; released generation повторно использовать нельзя. `release` сверяет owner/generation, поэтому задержанная очистка generation N не удаляет N+1. Отсутствующий claim — no-op без увеличения revision.

`try_claim` принимает явные числовые amounts и global accounting input. Он **не** выводит amounts из candidate, не применяет engine-specific `gpuBudgetBytes`/headroom автоматически и не проверяет fit неизвестного движка. Вызывающий код сначала рассматривает planner status, применяет необходимые spare/caps к admission budget, выбирает обоснованный reservation envelope и явно обрабатывает unknown. Release резерва не доказывает освобождение OS memory: после process/service shutdown нужно обновить telemetry. Launch failure/cancellation освобождает точную generation владельца; пока allocation жив, claim сохраняется.

Реестр локален приложению и не persistent. Здесь нет cross-process mutex, TTL, operation journal, recovery scanner, автоматического lease expiration либо защиты от foreign allocations после snapshot. Caller передаёт честную same-sample attribution и свежий age. При positive reservation отсутствие GPU/pinned availability даёт `unknown`. Связь с run lifecycle admission/release остаётся отдельной работой; native advisory planning не расходует этот реестр.

<a id="native-service"></a>
## Зарегистрированный native service без записи

`plan_run_resources({ request: RunRequest })` зарегистрирован в [lib.rs](../../../src-tauri/src/lib.rs). Возвращает развёрнутый `ResourcePlan` контракта v1, `warnings: string[]` и `activeRuns` с полями `runId`, `generation`, `state`, `estimate`, `accountingMode`. Service копирует активные requests из `RunManager::resource_requests()`, включая внутренние launch snapshots вместо изменяемых frontend settings, затем читает metadata/hardware в `spawn_blocking`. Публичный ответ не содержит launch arguments и credentials.

Reader GGUF исследует только ограниченные metadata headers: предел scan 64 MiB, captured strings/keys 64 KiB, 100 000 metadata entries и 2 миллиона array elements. Unsupported/partial metadata, per-layer arrays, отсутствующая KV shape, неполные shards, dependencies и нестандартный attention не допускают bounded dense strategy. Размеры файлов суммируются для распознанного полного набора shard names по одному разу; tensor payloads не читаются. Native strategy сейчас распознаёт только canonical dense `llama` GGUF. Явные key/value head dimensions используются напрямую; embedding/head fallback разрешён только при их отсутствии. Ненулевые или некорректные expert/SWA metadata блокируют standard strategy.

Effective CLI использует последнее вхождение, включая `--flag=value`. Bounded native cache estimate требует явных положительного `--ctx-size`, `--parallel 1`, K/V cache types, fixed placement и `--fit off`/`0`. Default cache type, parallel multiplier и результат auto-fit не угадываются. Поддержаны `--gpu-layers`, `--n-gpu-layers`, `-ngl`. Только GPU 0 с явным поддержанным device selection получает mapping; неподдержанные devices, splits, router residency и projector/draft/LoRA/ngram dependencies остаются unknown. Context floor сохраняется, некорректные floors отклоняются. Не-llama requests используют свой configured context и возвращают unknown envelopes; legacy Infernix helper переводит headroom только в spare.

Cache type fractions включают overhead quantization blocks из upstream [ggml-common.h](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h), например q5_1 использует 24 байта на 32 значения. Поддержанные имена типов: f32, f16, bf16, q8_0, q4_0, iq4_nl, q4_1, q5_0, q5_1; mapping не доказывает поддержку установленным backend или allocation alignment.

Hardware сейчас предоставляет RAM и первый NVIDIA GPU как отдельные pools. Некорректные/отсутствующие readings остаются unknown; pinned capacity и same-sample per-PID observations отсутствуют. Snapshot age включает 750 ms окна hardware cache и длительность сбора; readings старше 2 000 ms становятся недоступны planner. Эти readings и run snapshots не являются атомарной OS allocation transaction.

Для bounded estimates активных запусков service добавляет временные полные upper-envelope claims с `accountingMode: "conservativeEstimateClaim"`. Они могут пересекаться с global observed memory, потому что PID attribution отсутствует. Давление, созданное только этим непроверенным overlap, имеет статус advisory, а не доказанный insufficient. Unbounded active estimate использует `globalObservedOnly`; будущий рост памяти остаётся unknown. Известная insufficiency по текущей free memory сохраняется. Ни один активный процесс не считается молча нулевым; временные claims не попадают в lease registry.

<a id="panel"></a>
## Явная resource panel

`ResourcePlanPanel` принимает `{ request: StartRunRequest | null, disabled?: boolean }`. Configuration view строит вход через `createRunStartRequest({ ...input, preview: true })`; preview пропускает разрешение сохранённых секретов, native launch validation и запись router presets. Router placeholders намеренно дают unknown allocation.

Native planning вызывается только кнопкой «Оценить ресурсы». Panel показывает configured/hypothetical variants, context, RAM/VRAM ranges, confidence, statuses, reasons и предупреждения telemetry/active runs. RU/EN labels локальны; native diagnostic reasons сейчас остаются на английском. Изменение request очищает старый результат; request epochs отбрасывают поздние ответы и результаты после unmount. Browser mode отключает planning без реального hardware snapshot. Нет apply actions, записи конфигурации или автоматического пересчёта.

<a id="verification"></a>
## Проверки и оставшиеся доказательства

[resourcePlanner.test.ts](../../../tests/resourcePlanner.test.ts) проверяет dense ranges/KV capacity, unsupported engines/architectures, unknown/incomplete dependencies, различия insufficient/advisory/unknown, context floors, раздельные GPU/caps, spare rules, stale/missing telemetry, attribution, duplicates, pinned accounting и legacy Infernix settings helper. Rust planner tests проверяют concurrent admission/release, revision/identity/generation conflicts, idempotence, observations/adoption, отклонение чисел и unknown pinned capacity. Native service tests используют временные фиктивные GGUF headers, actual CLI/settings mapping и unknown growth активных запусков без запуска модели.

Зарегистрированные модули проверяются через `cargo test --lib resource_`; TS — через `npm test -- tests/resourcePlanner.test.ts`. Успешный прогон двух CPU серверов подтвердил только поведение supervisor. Browser-to-native resource invocation, allocator calibration, performance ranking, resource events, lease lifecycle admission и реальные multi-engine/GPU load tests остаются отдельной валидацией. Измеренный fit другого engine/model на эту оценку не переносится.
