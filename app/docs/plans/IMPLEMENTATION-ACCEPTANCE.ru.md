# Приёмка двух движков и менеджера загрузок

Дата: 2026-10-22. Рабочий checkout: `C:\Dev\Aplot-Control-LLM\project`.

Реализованы E0–E3 и D0–D3. Windows-приёмка E4/D4 выполнена в описанном ниже объёме, включая полную многогигабайтную загрузку. Полный реальный инференс Strata остаётся неподтверждённым; этот пункт не объявлен завершённым.

## Результат

- В интерфейсе, конфигурации, запуске, IPC и установщике остаются llama.cpp и Strata. Агенты Hermes/Codex/Claude, чат и внешние API сохраняются.
- Старые настройки и профили сохраняются для просмотра/экспорта. Неизвестный или удалённый движок не подменяется llama.cpp, автозапуск выключается, запуск/import legacy-профиля отклоняется до изменения данных. Миграция сохраняет исходные записи в архиве SQLite.
- Самостоятельная очередь публичных Hugging Face GGUF: immutable commit, полный split-набор одной квантовки, явный mmproj, папка и место, прогресс/скорость/ETA, пауза/докачка/повтор/отмена, история SQLite.
- Запись идёт в `.aplot-staging`, исключённый из библиотеки. Проверяются размер, доступный source SHA-256 и структура GGUF; без source digest ограничение явно показывается. Набор публикуется целиком через rename, регистрация восстанавливается после аварии.
- Штатный выход сохраняет паузу, аварийный — `interrupted` без автоматической докачки; трей сохраняет передачу. Удаление временных файлов является отдельным действием и не затрагивает опубликованную модель.
- Strata проверяет подготовленный конфиг и обязательные пути до запуска; относительные пути engine разрешаются от config `cwd`, tokenizer — от корня установки. Скачивание GGUF само по себе не означает совместимость или готовность Strata.

## Автоматические проверки

Итоговые результаты фиксируются также в [журнале](IMPLEMENTATION-COORDINATION.ru.md).

| Проверка | Результат |
| --- | --- |
| Frontend Vitest | 419 passed, включая выбор модели/движка для профиля и гонки snapshots/events |
| Source/typecheck/static | Passed: два движка, три агента, IPC и переводы согласованы |
| Docs/modules | Passed: 20 RU/EN пар, 400 ссылок, 10 download commands, 7 module entrypoints |
| Production Vite build | Passed; предупреждение о размере control chunk около 525 КБ |
| Rust suite | 195 passed, 7 ignored + Windows activation 1 passed; обычная debug-сборка без test WebView config прошла |
| Playwright RU/EN | 2/2 passed: cold start, keyboard, очередь, геометрия модальных окон и две ширины |
| Installer UI | 28 checks passed |
| Installer components | Passed: выбор/повторное использование, scope архива, SHA-256, частичный отказ, allowlist runtime |
| Native maintenance CLI | Passed на штатной debug-сборке: staging, готовые модели и отдельная SQLite-история сохраняют содержимое при очистке кэша |
| Native NSIS file-only repair | Passed: in-place repair, политика ярлыков, сохранение контрольных файлов |

Сетевые и требующие настоящего сервера тесты исключены из обычного offline suite посредством `ignore`, а не представлены как прошедшие unit tests.

## Реальные Windows-сценарии

Основные JSON, scripts и screenshots находятся вне исходников: `C:\Dev\Aplot-Control-LLM\local\artifacts\next-version-acceptance`.

1. **Миграция настоящей БД.** Использованы четыре отдельные копии БД и синтетические legacy-профили: `ollama`, `qwfnfer`, `infernix`, неизвестный ID. Проверены пустой выбранный движок, legacy marker, отключённый autostart/router autoload, сохранение полей при экспорте, отказ старых handlers и launch/import. Производственная БД не изменялась. Результаты: `native-{id}.json`.
2. **Полная single GGUF.** Репозиторий `ggml-org/models-moved`, commit `499bc8821c6b12b4e53c5bffcb21ec206f212d81`, `tinyllamas/stories260K.gguf`: 1 185 376 байт. Реальные UI→IPC→HF→disk→SQLite→library, папка с кириллицей и пробелами, Range после checkpoint, source SHA-256, GGUF, atomic publish и восстановление регистрации — passed.
3. **Полный split GGUF.** `tinyllamas/split/stories15M-q8_0-*`: 3 файла, 26 671 680 байт. Выбор одного шарда развёрнут в полный набор. Пауза→Quit→resume→принудительное завершение только тестового процесса→`interrupted`→ручное resume→скрытие окна→completed — passed. Частичные файлы не попадали в библиотеку. Результат: `native-recovery.json`.
4. **Очередь и очистка.** Один активный набор, следующие queued; повтор start отклонён без дублирования; queued cancel; pause активного запускает следующий; cancel сохраняет part; явная очистка сохраняет установленную модель и историю — passed. Результат: `native-queue.json`.
5. **Большой Xet-backed GGUF.** Полностью скачан `mistral-7b-v0.2-iq3_s-imat.gguf`: 3 182 393 056 байт, тот же immutable commit. Source SHA-256 `b30bb276df8debca77c077b9d65b0b7fa0717740de6312e38840974cddd8813b` совпал, GGUF прошёл проверку. Prefix checkpoint→реальный Range→полная передача и первая проверка заняли 135,42 с (22,41 МиБ/с, включая проверку); публикация и повторная проверка recovery/SQLite — ещё 40,80 с; весь test — 176,98 с. Измеренная выборка памяти процесса во время проверки — 20 918 272 байт (не финальный lifetime peak). Ранее отдельно прошли pause/cancel/checkpoint на первых 4 369 193 байтах большого файла. Временный тестовый набор после успешной проверки удалён самим тестом. Доказательства: `large-download.log`, `large-download-memory.json`.
6. **llama.cpp.** Существующий `alternate-build/llama-server.exe`, CPU и скачанный tiny GGUF: start/health/ready, native streaming chat (12 событий), метрики, benchmark (1 sample), restart, stop, router preset и routed chat — passed. Результат: `native-llama.json`.
7. **Интерфейс.** RU/EN, выбор split и mmproj, подготовка плана, очередь, pause/resume/cancel/remove-partial, Escape/focus и ширины 1100×720/1920×1080 покрыты Playwright — 2/2 passed. Исправлены ожидание ленивой страницы при cold start и обрезание модальных окон внутри панели: chooser и подтверждение удаления выводятся через portal; E2E проверяет backdrop на весь viewport и карточку внутри него. Скриншоты: `app/e2e/screenshots/model-downloads-*.png`, `model-download-profile-dialog-1100x720.png`.
8. **Создание профиля после реальной загрузки.** Отдельная копия download DB, настоящий completed tiny GGUF: кнопка→выбор найденной модели и установленного llama.cpp→Configuration — passed. Неподготовленная Strata не предлагается как готовый запуск, доступна настройка. `list_profiles` не увеличился, `list_runs` не изменился, сервер не запущен. Проверены геометрия chooser/backdrop и реальный скриншот после portal fix. Доказательства: `native-profile.json`, `native-create-profile.png`, `native-profile.cjs`.

Нативная приёмка использовала отдельный исполняемый файл и локальную конфигурацию WebView с CDP только внутри каталога приёмки. Штатная конфигурация источников не содержит этих параметров; обычная debug-сборка пересобирается без `TAURI_CONFIG`.

## Границы подтверждения

- Внешние Strata configs сохранены, но модели/tokenizer/MTP, на которые они ссылаются, отсутствуют. Физические `models/*` пусты. Полный Strata inference требует подготовленного набора; автоматически заново десятки гигабайт не скачивались.
- Измеренная скорость большого файла относится к одному Windows-окружению и включает первую проверку SHA-256/GGUF; это не гарантия скорости других репозиториев или соединений.
- Private/gated, произвольные HTTPS-источники, Safetensors snapshot, конвертация и автоматическая подготовка Strata находятся вне первого этапа.
- Версия остаётся 0.9.1. Коммиты, push, публикация и массовая очистка рабочей копии не выполнялись. Исходная dirty-база, внешние установки и пользовательские веса не удалялись.

## Повторяемые команды

Из `project/app`:

```powershell
npm run verify:source
npm run verify:docs
npm run verify:modules
npm test
npm run build
npx playwright test --config=e2e/model-downloads.config.ts e2e/model-downloads.e2e.ts
```

Из `project`:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --target-dir C:\Dev\Aplot-Control-LLM\local\builds\next-version
cargo build --manifest-path app/src-tauri/Cargo.toml --bin aplot-control-llm --target-dir C:\Dev\Aplot-Control-LLM\local\builds\next-version
```

Target указан явно: прежний перенесённый кэш содержит абсолютные пути старого checkout. Для сетевых тестов см. `downloads/transfer.rs`; запускать ignored-сценарии отдельно, осознанно используя сеть и тестовую папку. Полная приёмка 3,18 ГБ:

```powershell
$env:APLOT_LIVE_DOWNLOAD='large' # tiny/split — небольшие наборы
cargo test --manifest-path app/src-tauri/Cargo.toml --target-dir C:\Dev\Aplot-Control-LLM\local\builds\next-version downloads::transfer::tests::live_huggingface_complete_set_with_range_and_installation -- --ignored --exact --nocapture
Remove-Item Env:APLOT_LIVE_DOWNLOAD
```

## Команда

Координатор GPT-6.1 Sol High: `01a16330-d056-7bb3-9c5e-fe28c207ae9e`. Исполнители GPT-6 Luna Max:

- UI: `01a16331-cd77-72d1-b738-2983e85144ba`.
- Rust: `01a16331-d0b3-7b93-b7a3-ec507c56a95a`.
- Installer/docs: `01a16331-d511-7271-8c0d-9fecda7bdf19`.

Все работали в общем checkout с отдельными областями владения. Эскалация моделей не потребовалась.
