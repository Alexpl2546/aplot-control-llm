# Реализация 2026-10-22

Основной чат: `01a16330-d056-7bb3-9c5e-fe28c207ae9e` (GPT-6.1 Sol High).
Общий checkout: `C:\Dev\Aplot-Control-LLM\project`. Исходная dirty база сохраняется. Без commits/reset/stash/clean, изменения версии и публикации.

## Владельцы

| Чат | Модель | Файлы |
| --- | --- | --- |
| `01a16331-cd77-72d1-b738-2983e85144ba` | GPT-6 Luna Max | `app/src/**`, TS/TSX tests, e2e |
| `01a16331-d0b3-7b93-b7a3-ec507c56a95a` | GPT-6 Luna Max | Rust, кроме исключений ниже; migration/settings/profile/scanners |
| `01a16331-d511-7271-8c0d-9fecda7bdf19` | GPT-6 Luna Max | installer, components.rs, component_maintenance.rs, docs/scripts/CI/package metadata, installer tests |
| Основной | GPT-6.1 Sol High | `src-tauri/src/downloads/**`, `lib.rs`, `app_lifecycle.rs`, Cargo.toml/lock, этот журнал; интеграция и приёмка |

Передача владения только явным сообщением. Исполнители сообщают результаты и недоработки основному чату; разрешение человека на взаимные сообщения получено исходным поручением.

## Контракт downloads v1

Все объекты JSON camelCase. Команды async Tauri:

- `resolve_model_download({source: string}) -> ResolvedDownload`
- `prepare_model_download({selection: {source: string, revision: string, files: string[]}, destination: string}) -> DownloadPlan`
- `start_model_download({planId: string}) -> DownloadTask`
- `list_model_downloads() -> DownloadTask[]`; `get_model_download({id}) -> DownloadTask`
- `pause_model_download({id})`, `resume_model_download({id})`, `cancel_model_download({id})`, `remove_model_download_partial({id})` -> DownloadTask
- `model_download_destination() -> string` — writable per-user default.

ResolvedDownload: `{source, repoId, revision, publisher, repositoryUrl, licenseUrl, files: DownloadFile[], variants: DownloadVariant[], suggestedFile?: string}`.
DownloadFile: `{path, sizeBytes, sha256?: string, role: 'model'|'shard'|'mmproj', quantization?: string}`. Digest только LFS SHA256 (не Xet/произвольный ETag).
DownloadVariant: `{id, label, files: string[], totalBytes, complete: boolean}`; выбор шарда разворачивается backend в полный набор, неполный набор отклоняется. mmproj выбирается отдельно явно.
DownloadPlan: `{planId, source, repoId, revision, files, destination, finalPath, totalBytes, availableBytes, warnings: string[]}`. destination существующая или создаваемая абсолютная папка; finalPath уникальная подпапка, без overwrite.
DownloadTask: `{id, sequence, state, plan: DownloadPlan, downloadedBytes, totalBytes, speedBytesPerSecond, currentFile?: string, error?: {code, message, retryable}, createdAt, updatedAt, installedPath?: string, verification?: string}`.
States: queued/resolving/downloading/verifying/installing/completed/pausing/paused/retry_wait/failed/cancelled/interrupted.
Event `download://updated` — полный DownloadTask (id = downloadId для фильтра; добавить downloadId при необходимости). Sequence монотонен. UI subscribe→snapshot, игнорировать старые sequence. Queue/store независимы от control busy/benchmark.

История/происхождение в SQLite model_downloads/model_download_files/model_installations; не в пересоздаваемом artifact index. Staging `<destination>/.aplot-staging/<id>` строго исключается сканерами. Публикация всего набора atomic rename. Незавершённая установка восстанавливается по manifest marker. Выход сохраняет паузу; crash даёт interrupted, без auto resume.

Rust scanner integration: финальные папки брать из `model_installations.installed_path`, таблица содержит `id TEXT PRIMARY KEY, installed_path TEXT NOT NULL, manifest_json TEXT NOT NULL, installed_at TEXT NOT NULL`. Полный manifest = task JSON. DB init должен вызвать `crate::downloads::repository::init_schema(&conn)?` после profile migrations; основной подготовит функцию.

## Готовность

E0–E4: только два активных движка; legacy экспортируется и не запускается/не подменяется; нейтральный HTTP; installer согласован; чат/агенты/API сохранены.
D0–D4: immutable Hub revision, split/mmproj, writable destination+disk check, durable queue, pause/resume/recovery, HTTP Range/validators/retry, integrity/GGUF, isolated staging+atomic publish+registration, RU/EN/demo и Windows приёмка.
Обязательные проверки: frontend typecheck/build/vitest; Rust check/test; source/docs/modules; installer tests. Реальные скачивания и оба запуска проверяются отдельно от unit tests. Не считать готовность Strata следствием скачивания.

## Журнал

- Прочитаны START-HERE и оба плана; AGENTS.md в исходниках приложения не найден. Запущены три чата по указанным областям. Исходная dirty база не изменялась аудитом.
- Проверена актуальная документация HF API/download/Xet compatibility. Реальная HTTP-совместимость и тестовый стенд проверяются при реализации.
- Реализованы downloads types/provider/repository/path safety/transfer/install/manager/IPC; lib и штатный shutdown подключены. Схема download history независима от artifact index. К файлам добавлен optional `localSha256`: локальный digest не заменяет source SHA256.
- Старый relocated Cargo target содержал абсолютные пути до переноса. Для проверок используется `C:\Dev\Aplot-Control-LLM\local\builds\next-version`, прежний кэш не удалялся.
- Offline downloads tests: 17 passed на первом проходе; добавлены следующие проверки destination/reserved directories.
- Реальная Windows HF/Xet приёмка: immutable revision `499bc8821c6b12b4e53c5bffcb21ec206f212d81`, `ggml-org/models-moved`; single `stories260K.gguf` (1 185 376 байт), split `stories15M-q8_0` (3 файла, 26 671 680 байт). Для каждого файла prefix checkpoint→Range continuation→source SHA256→strict GGUF→atomic publish→crash reconciliation→SQLite registration. Оба сценария passed; сетевые tests ignored по умолчанию.
- Исправлен dev dependency scan: `optimizeDeps.entries=['index.html']` исключает случайное чтение HTML через junction artifacts (внешний Hermes FIXTURE_ENTRY).
- Delivery: installer UI 28 checks, installer-components, native NSIS file-only acceptance, maintenance CLI, components 5 tests/maintenance 9 tests прошли. Source/docs/modules будут повторены после UI integration.
- UI review потребовал исправить subscribe→snapshot race, event-only tasks merge, explicit retry после integrity failure, completed actions и installing controls. Исполнитель внёс исправления и добавляет e2e.
- Backend review потребовал migration v2 append-only raw archive, low-level backend IPC guard и passive legacy references без Ollama blob/Infernix catalog integration. Исполнитель реализовал, проходит итоговый Rust suite.
- Ограничение окружения: физические `models/*` сейчас пусты; старые внешние Strata configs сохранены, но ссылаются на отсутствующие веса/tokenizer/mtp. Полноценный Strata inference нельзя подтвердить без нового большого набора модели. Не изменяем пользовательские configs и не возвращаем удалённые веса автоматически.
- Независимый финальный проход: frontend 416/416 tests (71 files), typecheck/build/source/docs/modules passed; Rust 188 passed, 6 ignored. Новые targeted downloads tests после доработок: 20 passed, 1 live ignored.
- Нативная приёмка на четырёх изолированных копиях настоящей БД с синтетическими legacy-профилями: ollama/qwfnfer/infernix/unknown → пустой serverEngine, legacyEngineId, autostart/routerAutoload=false; 4 legacy profile exports сохраняют engine/future fields; import/resolve-launch отклоняются до записи, старые IPC handlers отсутствуют. Производственная БД не редактировалась.
- Нативная UI→IPC→HF→disk→SQLite→library приёмка single GGUF пройдена в папке с кириллицей/пробелами; split pause→Quit→resume→принудительное завершение только тестового приложения→interrupted→resume→hide/tray→completed пройдена. Подтверждены исключение staging и регистрация всех частей.
- Нативный llama.cpp из существующего alternate-build: start/stop/restart, OpenAI chat через native Channel (12 events), метрики, benchmark sample, native router с выбранной моделью — passed.
- Приёмочные scripts/JSON/screenshots: `C:\Dev\Aplot-Control-LLM\local\artifacts\next-version-acceptance`. Для elevated WebView тестовая конфигурация с localhost CDP находится только там; штатный config источников не менялся.
- Человек повторно поручил продолжить и передать исполнителям (2026-10-22): UI расширяет RU/EN/keyboard/control e2e, Rust проверяет явные companion paths Strata до spawn, delivery проверяет сохранность download staging/installed files/history при cache maintenance.
- Исправлены дополнительные recovery границы: проверка опубликованного набора отменяется контролем pause/shutdown; reconciliation после rename не требует повторного свободного места на весь набор; remove-partial не сбрасывает опубликованную установку; публикация отклоняет незаявленные файлы staging; метаданные HF читаются с ограничением памяти.
- Strata preflight дополнен явными companion paths (--pack/native/native-dense-gguf/embd/ple/expert-profile/mtp/draft-vocab), обязательными MTP runtime файлами и всеми тремя tokenizer файлами. Числовой --mtp не считается папкой; неподдерживаемый текущим C++ parser inline --flag=value и отсутствующее значение отклоняются до запуска. Tokenizer relative от install root, exe/engine args от config cwd. Независимый финальный Rust suite: 195 passed, 7 ignored, Windows activation 1 passed; обычный debug build без TAURI_CONFIG passed.
- Повтор main выявил cold-start EN e2e (main ещё пуст при lazy initialization); UI исполнитель исправляет исходную причину и добавляет явное completed→Create profile. До исправления повтор EN failed/RU passed; старый 2/2 не считается окончательным результатом.
- Delivery исправил устаревшее описание package metadata; static verifier проверяет descriptions двух движков и согласованность package/lock/Cargo/Tauri version. Main source/docs повтор passed; native maintenance CLI и installer-components повтор passed.
- Полная large GGUF приёмка завершена: 3 182 393 056 байт, mistral-7b-v0.2-iq3_s-imat.gguf, immutable commit 499bc8821c6b12b4e53c5bffcb21ec206f212d81; source SHA-256 b30bb276df8debca77c077b9d65b0b7fa0717740de6312e38840974cddd8813b совпал, strict GGUF/publish/recovery/SQLite passed. Transfer+initial verification 135,42s (22,41 MiB/s), recovery/registration 40,80s, test176,98s. Выборка памяти во время hashing20 918 272B, не lifetime peak. Тестовый набор удалён самим тестом, production models не менялись; log в local/artifacts/next-version-acceptance/large-download.log.
- Завершены Create profile model/engine chooser, Strata setup action, keyboard/focus/unmount guards; selectLibraryModel не сохраняет новый профиль и не запускает сервер. Main review скриншота выявил clipping вложенного модального окна: chooser и remove-partial confirmation перенесены в body portals; E2E дополнен проверками viewport/backdrop bounds. Независимый native профильный сценарий с реальными downloaded files passed (включая modal geometry и screenshot), profile count/runs unchanged; native-profile.json.
- Итоговый main frontend suite после portal fix: 419 passed; typecheck/source/build passed; source1811 translations/1023 used keys/109 invokes/141 handlers/2 engines/3 agents; docs20 RU/EN pairs400links и modules7 entrypoints passed. Rust финальный log195passed7ignored+activation1, обычный build passed. Полный отчёт: IMPLEMENTATION-ACCEPTANCE.ru.md. Тестовое native приложение штатно Quit, localhost preview останавливается после последнего результата.
