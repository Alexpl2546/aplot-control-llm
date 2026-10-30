<a id="current-evidence"></a>
# Бенчмарки и доказательства

## Текущее поведение

Приложение хранит результаты в SQLite и запускает сценарии через текущий benchmark flow store/Rust. Методы и payloads находятся в [PerformanceView.tsx](../../src/views/PerformanceView.tsx), [benchmarkOptimizer.ts](../../src/lib/benchmarkOptimizer.ts) и `src-tauri/src/benchmark.rs`. Отдельные suites могут измерять throughput, recall и continuity; доступность зависит от engine и выбранной модели.

Для управляемых запусков используется отменяемая job-обёртка: она подписывается на события job, опрашивает `list_jobs`, а затем загружает сохранённый результат по `benchmarkId` через `list_benchmarks`. Автоподбор запускает каждый вариант на временном управляемом запуске и отменяет текущую job по запросу. Для legacy-сессий без управления процессом остаётся старый benchmark-путь.

Native wrapper `start_benchmark_job` использует `prepare_registration` и `run_registered_job` в [jobs.rs](../../src-tauri/src/jobs.rs). Тот же core принимает явные DB/job managers и optional AppHandle, позволяя изолированные native tests без GUI. Отсутствие AppHandle подавляет app events; queueing, measurement, cancellation и persistence выполняются общей реализацией.

## Источники configuration snapshot

Managed `BenchmarkResult.configSnapshot` имеет envelope `{ run, editorConfiguration, editorConfigurationSource: "caller" }`. `run` — authoritative redacted native `RunRequest`, полученный под run lease. `editorConfiguration` — redacted `LaunchConfig` caller либо null при отсутствии; это данные редактора, а не доказательство использования этих значений активным движком. Секреты удаляются из обоих полей. Job evidence отдельно хранит authoritative configuration и completed samples.

Перед применением результата или сравнением optimizer consumer обязан извлечь и проверить editor configuration. Bare `RunRequest` содержит специальный `launch` движка и не может применяться как `LaunchConfig`. Legacy results могут содержать bare editor configuration; compatibility helper различает эти формы. Владение и immutable request описаны в [jobs](modules/jobs.md) и [runs](modules/runs.md).

## Пределы вывода

Один результат относится к конкретному engine, model, параметрам, endpoint и времени выполнения. Сравнение корректно только при сопоставимых вводе, генерации, контексте, прогретости и фоновой нагрузке. Нельзя переносить результаты одного движка на другой или считать отсутствие optional telemetry нулём нагрузки.

Пиковые показатели оборудования системные. Они могут учитывать другие приложения и внешнюю нагрузку; benchmark не изолирует и не вычитает её. При отмене закрывается клиентский HTTP future, а уже завершённые samples остаются в evidence job, но не каждый engine гарантирует немедленную остановку генерации на своей стороне.

## Работа подключения

`verifyConnectionTarget` — краткая проверка доступности и одной потоковой генерации; она не является benchmark, не измеряет производительность и не сохраняет результат. Отдельный CPU smoke test проверяет только свой endpoint и модель; он не подтверждает Strata, GPU, tools, vision или long-context. Для полноценной оценки эти сценарии нужно запускать отдельно.

## Native job evidence

Тест отмены проверяет полный registered-core pipeline: discovery → сохранённая queued job → завершённый первый sample → stalled второй HTTP request → cancel → сохранённый cancelled outcome с partial evidence → освобождённый run lease → stop. Socket закрывается, первый sample сохраняется, successful BenchmarkResult при отмене не создаётся. Проверяется фактический общий native core с fixture endpoint и изолированной in-memory DB.

Реальная CPU llama.cpp job также завершилась с одним измеренным sample и сохранённым benchmark с ID, совпадающим с benchmarkId задачи. Используется envelope authoritative-run/caller-editor snapshot; counters помечены system-wide. Проверки подтверждают выполнение/persistence native core; browser event delivery, Tauri IPC invocation, UI cancellation/result loading и GPU/multi-engine acceptance ещё требуют desktop scenarios.

## Проверка релиза

Команды и сценарии проверки перечислены в [плане проверок](../TEST_PLAN.md). Результаты прежних запусков не подтверждают состояние новой версии без повторной проверки.
