<a id="entrypoints"></a>
# Карта кода

## Основные входные точки

| Участок | Реальные файлы | Ответственность |
| --- | --- | --- |
| Оболочка | [App.tsx](../../src/App.tsx), [KSidebar.tsx](../../src/components/shell/KSidebar.tsx), [KTopbar.tsx](../../src/components/shell/KTopbar.tsx), [KStatusBar.tsx](../../src/components/shell/KStatusBar.tsx) | Навигация, инициализация и общая раскладка; [границы оболочки](modules/shell.md) |
| Действия запусков UI | [launchActions.ts](../../src/features/launches/launchActions.ts), [useLaunchAction.ts](../../src/features/launches/useLaunchAction.ts) | Общий сценарий подтверждения черновика для карточки и палитры; lifecycle остаётся в run manager |
| Представление памяти | [memoryUsage.ts](../../src/features/resources/memoryUsage.ts), [MemoryMap.tsx](../../src/components/shell/MemoryMap.tsx) | Чистый расчёт оценочных долей и отдельное отображение системных измерений |
| Состояние | [control.ts](../../src/store/control.ts) | Настройки, текущий runtime, profiles и действия UI |
| Native bridge | [tauri.ts](../../src/services/tauri.ts) | Команды Tauri, mocks, runtime и OpenAPI вызов |
| API UI | [ApiDocsView.tsx](../../src/views/ApiDocsView.tsx), [ConnectionPanel.tsx](../../src/features/connections/ConnectionPanel.tsx) | OpenAPI, target, копирование и preview |
| Connection domain | [connections.ts](../../src/services/connections.ts), [harnesses.ts](../../src/features/connections/harnesses.ts) | Manager fallback, проверки API, реестр схем и чистые merge previews |
| Native API docs | [api_docs.rs](../../src-tauri/src/api_docs.rs), регистрация в [lib.rs](../../src-tauri/src/lib.rs) | Валидация локального URL, auth и OpenAPI response |
| Хранение профилей | [profile_store.rs](../../src-tauri/src/profile_store.rs), [profile.rs](../../src-tauri/src/domain/profile.rs) | Versioned profiles, revisions, secret references и recovery |
| Lifecycle запусков | [runs.rs](../../src-tauri/src/runs.rs), [engine_adapters.rs](../../src-tauri/src/engine_adapters.rs) | Immutable request, per-run operation locks, generations и подготовка движка |
| Каталог artifacts | [artifact_service.rs](../../src-tauri/src/artifact_service.rs), [model_artifacts.rs](../../src-tauri/src/model_artifacts.rs) | Фактические roots/consumers, scan и removal preview |
| Загрузки моделей | [Rust module](../../src-tauri/src/downloads/mod.rs), [frontend service](../../src/features/modelDownloads/service.ts), [model-downloads.md](modules/model-downloads.md) | Hugging Face resolve, durable очередь, проверка и публикация GGUF |
| План ресурсов | [resource_service.rs](../../src-tauri/src/resource_service.rs), [resource_planner.rs](../../src-tauri/src/resource_planner.rs), [ResourcePlanPanel.tsx](../../src/features/resources/ResourcePlanPanel.tsx) | Native snapshots, чистый accounting и явный advisory UI |
| Задачи измерений | [jobs.rs](../../src-tauri/src/jobs.rs), [benchmark.rs](../../src-tauri/src/benchmark.rs) | Run leases, отмена, checkpoints и результаты |
| Выход приложения | [app_lifecycle.rs](../../src-tauri/src/app_lifecycle.rs), [lib.rs](../../src-tauri/src/lib.rs) | Общая очистка Quit/close/ExitRequested, outcomes задач, owned shutdown и tray behavior |
| Движки | [engine_adapters.rs](../../src-tauri/src/engine_adapters.rs), [strata.rs](../../src-tauri/src/strata.rs), llama.cpp command builder | Два запускаемых движка: llama.cpp и Strata |
| Установщик и maintenance | `src-tauri/installer/components.json`, `Install-Components.ps1`, NSIS/WPF и `components.rs` / `component_maintenance.rs` | Установка только llama.cpp/Strata и отдельное управление агентами; user data сохраняется |
| Типы и перевод | `src/types/{app,config,runtime}.ts`, `src/locales/{en,ru}/{common,kontur}.json` | Frontend DTO и RU/EN строки |

## Потоки данных

1. `App.tsx` вызывает инициализацию store.
2. `control.ts` загружает settings/profiles и запрашивает runtime через `tauri.ts`.
3. Dashboard открывает API-раздел через существующую навигацию.
4. `ConnectionPanel` читает менеджерский run list; для legacy использует текущий snapshot store.
5. `connections.ts` нормализует `run_connection` response, скрывает неподдержанный manager command явным fallback, и выполняет проверки health/list/SSE.
6. `ApiDocsView` вызывает зарегистрированную native-команду справки и отображает OpenAPI-операции.
7. `createRunStartRequest` фиксирует engine settings; `start_run` проверяет/подготавливает их и создаёт managed run. `restart_run` повторяет native snapshot; файлы Strata/router, на которые он ссылается, вместе с ним не фиксируются.
8. Явная кнопка ресурсов передаёт preview request в `plan_run_resources`; metadata, snapshots активных запусков и текущее hardware поступают в чистый planner. Panel не применяет варианты.
9. Библиотека вызывает resolve и prepare для HF-источника, затем запускает очередь; Rust сохраняет revision/task, пишет файлы в исключённый из сканирования staging и публикует только проверенный набор.
10. `start_benchmark_job` получает lease выбранного run, выполняет suite и сохраняет outcome задачи и completed evidence.

Для выполнения job читайте `prepare_registration` → `run_registered_job` в [jobs.rs](../../src-tauri/src/jobs.rs). IPC wrapper и isolated tests используют этот core; optional AppHandle управляет app events. Реальная CPU job проверила queued/completed persistence и один sample; cancellation fixture проверяет сохранение partial evidence и release lease. Native GUI IPC acceptance остаётся отдельным.

## Редакция подключения

Реестр harness и чистые трансформации находятся отдельно от React. Указанный код не открывает файлы harness и не вызывает apply. Подробные контракты: [connections](modules/connections.md) и [harnesses](modules/harnesses.md).

Новые тесты — `app/tests/connections.test.ts` и `app/tests/harnessTemplates.test.ts`; проверка документации — `app/scripts/verify-docs.mjs`. Их команды и доказательства выполнения фиксируются в handoff, а не подразумеваются ссылкой.

## Маршруты чтения модулей

Подробные контракты: [profiles](modules/profiles.md), [launch UI](modules/launches-ui.md), [runs](modules/runs.md), [engine adapters](modules/engine-adapters.md), [models](modules/models.md), [downloads](modules/model-downloads.md), [resources](modules/resources.md) и [jobs](modules/jobs.md). Текущие локальные engine ID — только `llama_cpp` и `strata`; legacy ID сохраняются для экспорта и не запускаются автоматически.
