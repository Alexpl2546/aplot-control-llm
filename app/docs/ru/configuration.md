<a id="connection-settings"></a>
# Конфигурация подключения

## Источники значений

Менеджерский `ConnectionTarget` читается из активного `run_connection`. Совместимый target для текущего single-run режима собирается из runtime snapshot, engine settings и неизменяемого `runningConfig`, если он есть. Черновые поля или каталог сохранённых профилей не используются как список фактических подключений.

## Поля текущего target

| Параметр | Значение и источник |
| --- | --- |
| `runId` | Идентификатор конкретного запуска; fallback использует `legacy-current`. |
| `engine` | Движок выбранного запуска. |
| `baseUrl` | API base URL; frontend нормализует корень до `/v1`. |
| `modelId` | Фактический ID API модели, а для router — активное имя route/profile. |
| `contextTokens` | Настроенный контекст runtime snapshot; `0` отображается как неизвестный. |
| `apiKey` | Ключ текущего target; скрыт и не добавляется в шаблон. |
| `protocol` | Поддержанный target contract — `openai-chat-completions`. |
| `managed` | Backend сообщает, принадлежит ли выбранный запуск приложению. |

## Engine settings

| Поля конфигурации | Как используется fallback |
| --- | --- |
| `serverEngine`, `serverMode`, `routerHost`, `routerPort`, `routerApiKey` | Engine ID `llama_cpp` или `strata`; host/port и router относятся к llama.cpp. |
| `strataHost`, `strataPort`, `strataApiKey` | Адрес и Bearer auth Strata; context берётся из снимка запуска. |
| `LaunchConfig.host`, `port`, `apiKey`, `ctxSize`, `profileName`, `modelAlias` | Snapshot параметров запуска; для router имя профиля задаёт API route ID. |

Старые настройки, которые встречаются в пользовательской базе, могут оставаться в raw backup или экспортируемых legacy-полях. Они не создают активное подключение и не выбираются молча вместо одного из двух движков.

## Секреты и сеть

`apiKey` отдельным полем передаётся как Bearer secret. В обычном copy block указывается только наличие способа авторизации. Полное значение попадает в clipboard только по отдельной кнопке; API key не входит в шаблоны — там используется `APLOT_API_KEY` как env reference, когда ключ настроен.

Адаптер harness должен обращаться к тому же маршруту `/v1/chat/completions`. Контекст в шаблоне берётся из активного target, а не из максимума модели. Если приложение и harness находятся в разных сетевых средах, настройте адрес, достижимый из среды harness; текущий frontend-check подчиняется CORS.

## Snapshots profiles и runs

Versioned profiles сохраняют engine options, model references, extensions и secret references; подробнее [profiles](modules/profiles.md). [createRunStartRequest](../../src/services/tauri.ts) фиксирует выбранный profile/draft в специальный request движка. `start_run` проверяет/подготавливает его, а native `restart_run` повторяет собственный request. Правка draft не меняет работающий процесс. Файлы конфигурации Strata и содержимое router preset остаются зависимостями вне immutable settings snapshot.

`createRunStartRequest({ ...input, preview: true })` подготавливает вход resource UI без разрешения сохранённых секретов, native launch validation или записи router presets. Router preview использует placeholder, поэтому его resource demand остаётся unknown. [Resource panel](modules/resources.md#panel) передаёт preview только по явному нажатию кнопки.

## Локальное хранилище компонентов

По умолчанию установщик и обслуживание используют `%LOCALAPPDATA%\Aplot Control LLM\components`. Для локального запуска можно задать `APLOT_COMPONENT_ROOT` — абсолютный путь к отдельной папке, например `C:\Aplot\components`. Установщику передайте тот же путь через `-InstallRoot`. Каталог содержит обычные `installations.json` и `<component>/<version>/aplot-component.json`; обслуживание сохраняет проверки владельца, активных процессов и reparse points. Некорректный явный путь блокирует обслуживание вместо переключения на другое хранилище.

Переменная выбирает хранилище для текущего процесса и его дочерних процессов; она не переносит внешние установки и не меняет явно сохранённые пути движков. После новой установки выберите её путь в настройках. Менеджер моделей отклоняет назначения внутри выбранного хранилища, чтобы обслуживание компонентов не удалило веса или частичные загрузки. Держите модели отдельно.

## Оценки ресурсов

Оценка llama.cpp использует метаданные GGUF и фактические параметры запуска, когда они доступны. Иначе planner сообщает неизвестный диапазон, а Strata использует только явно подтверждённые значения своей интеграции. Ни оценка, ни размер скачанного файла не гарантируют, что модель поместится в RAM/VRAM или запустится. Правила и ограничения описаны в [ресурсном модуле](modules/resources.md#options).
