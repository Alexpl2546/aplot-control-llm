<a id="connection-contract"></a>
# Модуль подключений

## Назначение и статус

Модуль переносит актуальные данные выбранного запуска в API-раздел и проверяет минимальный OpenAI-compatible путь. Файлы: [ConnectionPanel.tsx](../../../src/features/connections/ConnectionPanel.tsx), [services/connections.ts](../../../src/services/connections.ts) и текущая страница [ApiDocsView.tsx](../../../src/views/ApiDocsView.tsx).

Native backend регистрирует `list_runs` и `run_connection`; frontend использует эти команды для выбора фактического manager run. Контракт списка `RunInfo` задан в [runtime.ts](../../../src/types/runtime.ts) и [runs.rs](../../../src-tauri/src/runs.rs). В старом backend без `list_runs` UI показывает legacy single-run данные. Этот режим совместимости не выдаёт черновик за active run.

## Контракт ConnectionTarget

| Поле | Тип | Смысл |
| --- | --- | --- |
| `runId` | string | Устойчивый ID запуска; legacy compatibility ID — `legacy-current`. |
| `engine` | string | Один из поддерживаемых ID: `llama_cpp` или `strata`. |
| `baseUrl` | string | HTTP(S) API URL, нормализованный к suffix `/v1`. |
| `modelId` | string | Точный ID модели из API запуска/route. Не имя файла или guessed alias. |
| `contextTokens` | number | Настроенное число токенов; ноль означает неизвестное значение. |
| `apiKey` | string | Секрет для Bearer auth; нужен только в памяти. |
| `protocol` | `openai-chat-completions` | Единственный протокол, используемый API-check и templates в этой редакции. |
| `managed` | boolean | Владение сервисом; не равнозначно endpoint health. |

Контракт `run_connection({ runId })` проверяется по каждому обязательному полю, идентичности `runId`, HTTP(S) URL без встроенных credentials и протоколу. Ключ принимается только отдельной строкой. Тип и тесты: [connections.ts](../../../src/services/connections.ts), [connections.test.ts](../../../tests/connections.test.ts).

## Источник legacy target

Fallback строится из `runtime.endpoint`, выбранного engine, runtime model name и immutable `runningConfig`. Контекст берётся из снимка запущенного процесса. Неизвестный или legacy engine ID не становится ConnectionTarget; пользователь должен выбрать поддерживаемый профиль явно. Для llama router `profileName` — route ID. Список других сохранённых профилей и metadata карточки не открываются и не экспортируются.

Legacy target имеет ID `legacy-current`. Статус готовности берётся отдельно из текущего runtime. Только `ready` и `busy` разрешают network verification; `stopped`, `starting`, `loading`, `stopping`, `restarting` и `crashed` не помечаются ready.

## Уровни проверки

`verifyConnectionTarget()` выполняет три отдельных запроса. Каждый получает timeout и тот же AbortSignal:

1. `health`: GET `/health`.
2. `model-list`: GET `/v1/models`, затем точное сравнение `data[].id` либо `models[].id/name`.
3. `stream`: POST `/v1/chat/completions` с target model ID, `stream: true` и one-token test request. Проверяются HTTP ошибки, SSE JSON, error frames и `[DONE]`.

Результат хранится только в компоненте до его размонтирования. `404/405/501` и неизвестный формат списка дают `unsupported`; HTTP ошибки, неподходящий model ID, error event, отсутствие `[DONE]` или timeout дают `failed`; отмена возвращает `cancelled`. Общий результат может быть `passed`, `failed`, `partial` или `cancelled`.

Диагностика не вставляет raw response body в UI: серверный ответ может содержать приватные данные. Health/list и chat могут быть реализованы по-разному у движков; результат относится только к конкретному URL, модели и трём выполненным запросам. Успешная генерация не доказывает tool calling, vision или другую API поверхность.

## Копирование и секреты

Кнопка копирования полей включает base URL, точный model ID, настроенный context и способ авторизации, но не ключ. Ключ копируется только отдельной явной кнопкой. Harness snippets всегда содержат env var reference вместо значения ключа и исключают ключ, если в target он пустой.

Прямой frontend fetch может быть заблокирован CORS. Наличие `apiKey` не гарантирует, что браузерному origin разрешён запрос. Нужный harness smoke test выполняется отдельно из его собственного окружения; его статус не подменяется frontend проверкой.

## API справка и сетевые среды

`ApiDocsView` передаёт target endpoint/key/engine в registered Rust `fetch_openapi_spec`. Rust загружает справку API для выбранного поддерживаемого движка и проверяет адрес; frontend verification использует браузерную сеть. Поэтому два уровня могут дать разные результаты.

`127.0.0.1`/`localhost` имеет смысл только в namespace приложения. Для harness в WSL, Docker или на другой машине пользователь должен задавать доступный адрес. В этой реализации нет дополнительных host/WSL адресов, reverse proxy или gateway.

## RunInfo и ограничения интеграции

`list_runs` возвращает `RunInfo` native run manager: `runId`, `name`, `engine`, `mode`, `endpoint`, `modelId`, `contextTokens`, `state`, `generation`, `managed` и необязательные `pid`, `startedAt`, `lastError`. Для выбора panel использует run ID, engine, state, model ID, context и endpoint; `run_connection` определяет фактический API model ID и ключ выбранного запуска. После discovery команда повторно проверяет generation, чтобы не возвращать target для изменившегося запуска.

Регистрация команд находится в [lib.rs](../../../src-tauri/src/lib.rs). Результаты проверки подключения относятся к конкретному endpoint, модели и трём запросам. GUI acceptance и GPU-сценарии проверяются отдельно от unit tests. Connection task не запускает внешний harness.

## Зависимости и ограничения

Сервис импортирует Tauri `invoke` и `isTauri`, но не импортирует React/store. UI отдельно собирает fallback context и передаёт callback target. Профильный database CRUD не вызывается. Результаты не persistent.

Consumer списка нормализует используемые поля RunInfo, в том числе `endpoint` как отображаемый base URL и snake_case aliases. Поля `run_connection` target проверяются строго. Panel загружает список при монтировании и содержит явное обновление с сохранением выбранного run, если он ещё есть; автоматического polling нет.
