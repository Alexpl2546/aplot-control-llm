# Прогресс реструктуризации

[План](MODULAR_RESTRUCTURING.ru.md) · [English](IMPLEMENTATION_STATUS.en.md)

Редакция: 2026-10-12. Текущая итерация завершена, все три параллельных участка переданы в общее рабочее дерево. Это не объявление завершения всех P00–P12: оставшиеся критерии перечислены ниже.

Исправление одновременных запусков: актуальная сборка — [multi-run-fix-2026-10-12](../../../releases/multi-run-fix-2026-10-12/README.md). UI включает автоматический подбор свободного порта для owned-процессов, синхронизирует фактический endpoint и snapshot, не переписывая сохранённый профиль. API Docs по умолчанию выбирает запуск, открытый в обзоре. Пройдены 225 frontend tests и 123 native tests плюс Windows integration test; реальный CPU smoke теперь задаёт обоим серверам одинаковый предпочтительный порт. Изолированная native UI проверка подтверждает два активных router-запуска на разных портах и генерацию второго через API и потоковую UI-проверку. Evidence: `app/artifacts/multi-port-fix-2026-10-12/`.

Дополнение после исправления запуска: актуальная сборка — [launch-fix-strata-2026-10-12](../../../releases/launch-fix-strata-2026-10-12/README.md). Исправлены совпадающие имена API-маршрутов и попытка изменить активный router preset. Теперь 223 frontend tests; 297 тестов сервера обновлённой Strata v0.1.43. На отдельной копии БД проверены native GUI start/restart роутера с двумя одноимёнными профилями, ответы обоих маршрутов и фактический ID в API Docs. Также выполнены GUI start и генерация Qwen IQ2_XS через Strata с контекстом 131072. Штатное закрытие в обоих случаях завершило owned-процессы. Это дополняет описанные ниже результаты исходной итерации; tray, single-instance, все GPU-сочетания и полные контексты по-прежнему не объявлены принятыми. Evidence: `app/artifacts/launch-fix-2026-10-12/`.

| Этап | Выполнено в текущей итерации | Остаток приёмки |
| --- | --- | --- |
| P00 | 293 исходных файла, patch/manifest, согласованная SQLite backup; базовые gates пройдены | Сопоставление полного набора native UI сценариев/масштабов |
| P01 | Domain profiles/artifacts/secrets; отдельные launches/jobs/connections/resources features; совместимый store-фасад | Дальнейшее разделение большого control store, полный единый каталог контрактов |
| P02 | Additive migration, 5-engine profiles, revisions, import/export, DPAPI refs/resolver, immutable LKG и duplicate rebind | Итоговая совместная проверка после frontend/backend интеграции |
| P03 | Engine dispatcher + существующие typed builders 5 движков, согласование bind endpoint | Полная фиксация версий бинарников/содержимого внешних конфигов; реальные запуски каждого движка |
| P04 | Run registry, поколения, порты, независимый stop/restart, shared Ollama ownership, quit cleanup | Реальные сочетания GPU-движков, native UI quit/tray/single-instance acceptance |
| P05 | Выбор запуска, отдельные drafts/logs/history/runtime, сохранённая оболочка UI | Оба языка/темы, длинные имена, клавиатура и native Windows 100/150/200% |
| P06 | Каталог metadata, shared files/hardlink sizes, native shards, Ollama manifests, consumers/dependencies, missing references; реальный root: 103 артефакта/110 файлов без missing/issues | Разрушительное удаление не включено |
| P07 | Advisory RAM/GPU/KV ranges, read-only native request bridge, явная estimate button, active-run uncertainty | Калибровка engine/model strategies; estimates не являются OS reservation/admission |
| P08 | Scoped cancellable jobs, checkpoint/outcome storage, exclusive measurement lease, isolated optimizer trial; wrapper snapshots автоподбора; реальный CPU job core → persisted result | Проверка полного native UI → job → persisted result пути |
| P09 | Concrete ConnectionTarget, model discovery, копирование и отменяемые API checks | Полный native GUI acceptance подключений |
| P10 | Registry/snippets/previews Hermes, DeepSeek Harness, Pi, OpenClaw | Автоматическое подключение отложено по указанию пользователя; harness configs не изменялись |
| P11 | Не включён | Опциональный gateway требует отдельного решения; прямые endpoints сохранены |
| P12 | RU/EN модульные документы, parity/link checker в CI/release script, финальные gates и сборка EXE | Расширенная desktop приёмка перед объявлением полного релиза |

Итоговые проверки 12 октября: frontend 34 files/220 tests; native 122 passed/6 ignored и отдельный Windows integration test; fmt, source/contracts, RU/EN docs и release build пройдены. Docs checker: 18 пар/342 локальные ссылки. Шесть environment-dependent тестов исключены из обычного запуска; migration-copy, real catalog, CPU multi-run и CPU job запускались отдельно и прошли. Остались предупреждения о размере frontend chunk, смешанном Tauri import и неиспользуемых прототипах resource ledger.

Сборка текущей итерации: `releases/modular-preview-2026-10-12/Aplot-Control-LLM.exe`, версия manifest 0.8.2. Это preview модульной реструктуризации, предыдущая сборка сохранена. Native desktop запускается с встроенными assets; на debug-копии БД проверены загрузка RU интерфейса, аппаратная телеметрия, выбор профиля/запуска, страницы параметров/библиотеки/настроек и масштаб 110%. Добавлено необходимое Tauri permission для webview zoom. Полный desktop smoke не завершён: Computer Use не смог корректно нажать пункт выпадающего списка WebView (`point ... is over msedgewebview2.exe ... not target window`). После повторной неудачи тест прекращён; GUI launch/quit/tray не объявляются проверенными. Изолированное приложение остановлено, рабочая БД в тестах не использована.

Реальный CPU smoke использует два llama.cpp сервера с Qwen2.5 0.5B: генерация обоих, повторный старт, конфликт порта, остановка/перезапуск/авария соседа и shutdown. Это не подтверждает GPU fit или поддержку 131072 каждым движком. Отдельный API fixture проверяет shared external Ollama: targeted unload, общий endpoint, запрет lifecycle во время measurement и сохранение внешней службы.

Миграция копии: 40 legacy профилей плюс 4 global-engine профиля дают 44 v2; старые таблицы/settings/recovery сравниваются с исходными байтами. Working user DB не запускалась через тестовое приложение. Веса не перемещаются и не удаляются в этой итерации.

Evidence находится в `app/artifacts/restructuring/`: `baseline/`, `user-data-preservation.json`, `migration-copy-report.json`, `model-catalog-report.json`, `native-runs.json`, `native-job.json`, `native-ui-report.json`, handoff каждого параллельного чата. Сравнение 12 октября подтвердило точное сохранение строк/значений всех пяти исходных таблиц рабочей БД. Файлы evidence игнорируются Git; это не замена исходникам и воспроизводимым tests.
