<a id="execution-jobs"></a>
# Задания измерений

## Ответственность

[jobs.rs](../../../src-tauri/src/jobs.rs) связывает измерение с неизменяемым запуском llama.cpp или Strata, реализует отмену и хранит исход задания. Алгоритмы throughput/recall/continuity остаются в [benchmark.rs](../../../src-tauri/src/benchmark.rs). Переключение вкладки не отменяет native-задание. Загрузка моделей использует отдельную очередь и не получает run lease бенчмарка.

## Контракт и порядок выполнения

`start_benchmark_job({runId,request})` возвращает `JobInfo` сразу после регистрации и записи queued-строки. `JobInfo`: `jobId`, `runId`, `generation`, `engine`, `status`, `createdAt`, `updatedAt`, `benchmarkId`, `error`, `evidence`.

1. Менеджер получает lease запуска и общего измерения. Другие managed-запуски должны быть stopped/crashed.
2. Config snapshot берётся из backend-запроса запуска. Переданный UI snapshot не считается источником истины.
3. `/v1/models` проверяет model ID. Для router UI обязан выбрать конкретную модель.
4. В SQLite сохраняется queued-задание; затем начинается async execution.
5. Task-local `Scope` добавляет jobId/runId/generation к прогрессу и накапливает завершённые samples.
6. Каждую секунду запись получает checkpoint. Итог completed/failed/cancelled сохраняется перед освобождением lease.

## Состояния и события

| Состояние | Смысл |
| --- | --- |
| queued | Принято, snapshot записан |
| running | Выполняется измерение |
| cancelling | Получен запрос отмены |
| cancelled | HTTP future остановлен, завершённые samples сохранены |
| completed | Получен и сохранён BenchmarkResult; `benchmarkId` ссылается на него |
| failed | Ошибка измерения или хранения |
| interrupted | При новом старте приложения обнаружено незавершённое задание |

`job://progress`: `{jobId,runId,generation,progress}`. `job://state`: полный `JobInfo`. Старый `benchmark-progress` подавляется внутри task-local Scope, чтобы задания не подменяли чужой монитор. `list_jobs()` читает последние 100 записей и накладывает актуальное состояние активных заданий.

## Отмена и восстановление

`cancel_job({jobId})` отправляет watch-сигнал. Повторная отмена завершившегося задания безопасна. В `tokio::select!` отмена имеет приоритет; прекращается ожидание HTTP и чтение stream. Контекст guard освобождается после записи исхода.

Закрытие соединения проверено тестом `cancellation_drops_a_stalled_http_request_and_keeps_prior_sample`: первый запрос завершён, второй завис; отмена закрывает второй socket, сохраняет первое измерение и не создаёт успешный BenchmarkResult. Это не гарантирует мгновенную остановку вычислений любого стороннего движка: сервер может продолжать работу после disconnect.

При запуске приложения queued/running/cancelling в `execution_jobs` переводятся в interrupted с сохранением последнего checkpoint. Автоматического возобновления нет: прежнего процесса и HTTP stream уже может не существовать.

## Доказательства и ограничения

IPC использует общий native core: `prepare_registration` получает lease, проверяет model ID и записывает queued; `run_registered_job` выполняет задание, checkpoints и итоговую запись. Эти функции также проверяются без AppHandle. Реальный CPU тест `real_registered_job_persists_a_native_model_result` запускает Qwen2.5 0.5B, получает один throughput sample и подтверждает совпадение `benchmarkId` с записью SQLite. Полный тест отмены `registered_job_cancel_records_partial_evidence_and_releases_run_lease` проходит этот же core, сохраняет первое измерение и освобождает lease. Это проверка native core, а полная GUI приёмка остаётся отдельным сценарием.

В `BenchmarkResult.configSnapshot` поле `run` содержит redacted фактический RunRequest. `editorConfiguration` хранит отдельно переданные настройки редактора с меткой `editorConfigurationSource: "caller"`; они не заменяют фактическое evidence. Frontend `benchmarkLaunchConfig.ts` принимает старые плоские snapshots и новый wrapper только после проверки формы, движка и контекста. Один RunRequest нельзя использовать как LaunchConfig. Точные redaction markers удаляются; строка CLI с встроенным redaction не пригодна для восстановления профиля.

`evidence` хранит публичный RunInfo, redacted configuration/request, режим изоляции, завершённые samples. `public_snapshot` удаляет значения вложенных credential-полей и CLI `--api-key value`/`--token=value`. Секреты остаются только в памяти запроса и заголовке Authorization.

RAM/VRAM/GPU counters общесистемные. Остановка других managed-запусков уменьшает помехи, но не исключает внешние процессы. Label `hardwareCounters=system-wide` сохранён в evidence. Термин peak в старых результатах может означать максимум отдельных наблюдений, а не непрерывно измеренный абсолютный пик.

Lease не изменяет пользовательские профили и не выгружает соседние модели автоматически. Autotune использует отдельный trial-run и восстанавливает рабочий запуск; ошибки восстановления необходимо показывать пользователю, а не скрывать успешной рекомендацией.

## Где читать дальше

Начните с `start_benchmark_job`, затем `RunManager::measurement_lease`, task-local Scope, `execute_suite`, `persist`, и frontend job bridge. Таблица `execution_jobs` не заменяет таблицу `benchmarks`: первая хранит жизненный цикл и частичные доказательства, вторая — законченные результаты. См. [управление запусками](runs.md) и [измерения](../benchmarks.md).
