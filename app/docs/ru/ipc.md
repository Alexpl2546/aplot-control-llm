<a id="registered-commands"></a>
# IPC

## Команды загрузчика моделей

Все локальные запуски используют только `llama_cpp` или `strata`. Загрузчик Hugging Face GGUF имеет отдельный IPC и SQLite-жизненный цикл; он не использует очередь `JobManager`.

| Команда | Аргументы | Результат |
| --- | --- | --- |
| `resolve_model_download` | `{ source }` | `ResolvedDownload` с immutable revision, файлами и вариантами GGUF |
| `prepare_model_download` | `{ selection, destination }` | `DownloadPlan` с полным набором, путями, объёмом и доступным местом |
| `start_model_download` | `{ planId }` | Сохранённая `DownloadTask`; загрузка продолжается асинхронно |
| `list_model_downloads` | нет | `DownloadTask[]` |
| `get_model_download` | `{ id }` | Один `DownloadTask` |
| `pause_model_download`, `resume_model_download`, `cancel_model_download`, `remove_model_download_partial` | `{ id }` | Обновлённый `DownloadTask`; удаление ограничено staging этой задачи |
| `model_download_destination` | `{ engine? }` | Папка моделей движка внутри приложения |

`download://updated` передаёт полный `DownloadTask` с монотонным `sequence`. UI подписывается на событие и затем получает snapshot; сохранённое состояние остаётся источником истины. Staging исключён из сканирования, финальный набор после атомарной публикации регистрируется в библиотеке. Структуры и переходы описаны в [модуле загрузок](modules/model-downloads.md).

## Зарегистрированные команды подключения

Frontend bridge находится в [tauri.ts](../../src/services/tauri.ts); обработчик OpenAPI — в [api_docs.rs](../../src-tauri/src/api_docs.rs). Текущий API-раздел использует:

| Команда | Аргументы | Результат |
| --- | --- | --- |
| `fetch_openapi_spec` | `endpoint`, `apiKey`, `engine` | OpenAPI-справка для выбранного движка или понятная ошибка проверки/запроса |

Ключ передаётся Rust-команде по явному вызову и не включается в OpenAPI URL. Rust отклоняет credentials в URL, HTTPS и нелокальные адреса для справки API.

## Зарегистрированные команды менеджера запусков

Connection service ожидает:

| Команда | Аргумент | Ожидаемый результат |
| --- | --- | --- |
| `list_runs` | нет | `RunInfo[]` |
| `prepare_run` | `{ request }` | Проверенный `RunInfo` без запуска процесса |
| `start_run` | `{ request }` | Запущенный/текущий `RunInfo` |
| `stop_run`, `restart_run` | `{ runId }` | Lifecycle action выбранного запуска |
| `stop_all_runs` | нет | Остановка owned сервиса/процесса |
| `run_runtime` | `{ runId }` | Метрики выбранного run с проверкой generation |
| `run_connection` | `{ runId }` | `{ runId, engine, baseUrl, modelId, contextTokens, apiKey, protocol, managed }` |
| `open_run_web_ui` | `{ runId }` | Открывает/активирует отдельное окно Web UI с авторизацией для готового запуска llama.cpp или Strata; не возвращает credentials |

Frontend-тип `RunInfo` задан в [runtime.ts](../../src/types/runtime.ts); Rust-структура и handlers находятся в [runs.rs](../../src-tauri/src/runs.rs), а обе команды зарегистрированы в [lib.rs](../../src-tauri/src/lib.rs). `RunInfo` содержит `runId`, `name`, `engine`, `mode`, `endpoint`, `modelId`, `contextTokens`, `state`, `generation`, `managed` и необязательные `pid`, `startedAt`, `lastError`. Connection panel использует только нужную ему часть списка.

`run_connection` возвращает `protocol: "openai-chat-completions"`. Consumer принимает camelCase и snake_case aliases списка, но строго проверяет поля target. Старые backend без `list_runs` получают single-run режим совместимости. Если после успешного списка отсутствует `run_connection`, UI показывает отдельную ошибку и позволяет явно выбрать legacy target.

`open_run_web_ui` удерживает operation lock выбранного запуска во время проверки фактических аргументов, назначенного endpoint и ключа старта. Перед созданием окна проверяет HTML на `/`. Отключённый UI llama.cpp или установка без встроенного HTML дают явную ошибку; открытие не запускает и не перезапускает сервер. [web_ui.rs](../../src-tauri/src/web_ui.rs) выбирает механизм авторизации движка до исполнения скриптов страницы; ключ не включается в URL или IPC-ответ. Strata использует собственную JSON-запись `strata.apikey` и запись `strata.monitor.key` в sessionStorage. Окна удалённого Web UI не получают Tauri capabilities. Закрытие дополнительного окна не запускает выход из приложения; остановка/перезапуск закрывает окно соответствующего запуска.

## Проверка API

После получения target service выполняет GET `/health`, GET `/v1/models` и POST `/v1/chat/completions` с `stream: true`. Каждая операция получает Bearer auth при непустом ключе, отдельный 30-секундный тайм-аут и общий AbortSignal отмены. Результат не сохраняется.

## Команды ресурсов, artifacts, profiles и jobs

Handlers зарегистрированы в [lib.rs](../../src-tauri/src/lib.rs). Подробные аргументы и ограничения описаны на страницах доменов.

| Команда | Аргументы | Результат и границы |
| --- | --- | --- |
| `plan_run_resources` | `{ request: RunRequest }` | `ResourcePlan` контракта v1 плюс `warnings` и `activeRuns`; рекомендательное планирование без записи |
| `model_catalog` | нет | Фактический artifact catalogue и removal preview по настроенным roots и native consumers |
| `list_profiles_v2`, `get_profile_v2`, `save_profile_v2` | Аргументы profile/revision соответствующего домена | Versioned profiles, secret references и optimistic revisions |
| `start_benchmark_job` | `{ runId, request }` | Сохранённый queued `JobInfo`; выполнение продолжается асинхронно |
| `cancel_job` | `{ jobId }` | Запрос отмены; partial evidence сохраняется |
| `list_jobs` | нет | Последние сохранённые записи с актуальными active states |

`plan_run_resources` принимает ту же форму request с `runId`, `name`, `engine`, `mode`, `modelId`, `contextTokens` и `launch`, что run manager. Команда читает metadata/telemetry, не создаёт резерв и не возвращает launch arguments или credentials. Frontend явно вызывает её через [ResourcePlanPanel.tsx](../../src/features/resources/ResourcePlanPanel.tsx); browser preview не подставляет вымышленные hardware responses. Чистый реестр числовых резервов не имеет IPC-команды или автоматического launch admission.

Подробности: [resources](modules/resources.md), [models](modules/models.md), [profiles](modules/profiles.md), [jobs](modules/jobs.md) и [engine adapters](modules/engine-adapters.md). Run events используют `run://log`/`run://state` с runId и generation; job events — `job://progress`/`job://state` с job identity. Публичные списки не содержат полные launch requests с секретами.

Managed benchmark `configSnapshot` использует `{ run, editorConfiguration, editorConfigurationSource: "caller" }`: `run` — authoritative redacted native request, editorConfiguration — optional redacted LaunchConfig caller. Это отдельные контракты; bare RunRequest нельзя применять как editor configuration. Перед чтением old/new results см. [источники benchmark snapshot](benchmarks.md).

Job IPC wrapper вызывает `prepare_registration`/`run_registered_job`; isolated fixtures используют тот же core с явными DB/job managers без AppHandle. Parent проверила cancellation pipeline и реальную CPU job, завершившуюся с сохранённым результатом. Это native core checks. Они не проверяют GUI event delivery или browser-to-Tauri IPC call.
