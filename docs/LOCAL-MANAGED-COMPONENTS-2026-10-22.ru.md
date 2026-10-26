# Управляемые движки в локальном проекте

22 октября 2026 по поручению пользователя установлены отдельные управляемые копии двух движков в физическую папку `C:\Dev\Aplot-Control-LLM\project\components`.

| Компонент | Версия | Путь |
| --- | --- | --- |
| llama.cpp | b11723, Vulkan | `components\llama_cpp\b11723\llama-server.exe` |
| Strata | engine 0.1.47, source v0.2.2 | `components\strata\0.1.47` |
| Python Strata | CPython 3.12.13 | `components\python`, отдельная `.venv` внутри Strata |

Использован штатный `app/src-tauri/installer/install-components.ps1` с `-Components 'llama_cpp,strata' -Fresh -InstallRoot C:\Dev\Aplot-Control-LLM\project\components`. Все архивы прошли SHA-256 по текущему каталогу установщика; часть взята из ранее скачанного локального кэша после повторной проверки. Установщик проверил `llama-server.exe --help`, импорт `serve.server` в новой Python-среде, патч Aplot API и `strata.exe --help`. Созданы настоящие `installations.json` и version markers; это не присвоение владения прежним внешним папкам.

Для запуска этой локальной сборки используется `C:\Dev\Aplot-Control-LLM\local\sessions\strata-iq3-s-20261022\launch.ps1`. Он задаёт `APLOT_COMPONENT_ROOT` и открывает сборку с выбранным локальным хранилищем. Для обычного запуска без этой переменной хранилище по умолчанию остаётся `%LOCALAPPDATA%\Aplot Control LLM\components`. Установщику нестандартный путь передаётся явно через `-InstallRoot`.

## Изменения приложения

- Добавлен абсолютный `APLOT_COMPONENT_ROOT`; ошибочное явное значение не переключает обслуживание на другое хранилище. Проверки ownership/reparse/active processes сохранены.
- Менеджер моделей отклоняет назначение внутри выбранного component store до создания папок. Веса и `.aplot-staging` находятся отдельно, в `C:\Dev\Aplot-Control-LLM\models\strata\models`.
- `project\components` исключён из Git. Прежние внешние папки движков сохранены, настройки `binaryPath` и `strataRootPath` выбраны на новые установки. Старый `strataConfigPath` очищен, потому что готового конфига модели в новой установке пока нет; сохранённые профили не переписывались.
- Подтверждение обслуживания переведено на отдельный native HTML dialog через portal: оно не обрезается панелью и находится поверх модального окна настроек.
- Native CLI test явно задаёт временный component root, чтобы окружение разработчика не направило тестовое удаление на реальные компоненты.

## Приёмка

- Rust: 197 passed, 7 ignored; Windows activation: 1 passed.
- Frontend: 419 passed; source/typecheck/docs/build passed.
- Native CLI fixture: inventory, guards, selective removal, cache, manifest, сохранность внешних данных и истории загрузок — passed.
- В настоящем Aplot оба компонента имеют version/path/size, `blocked=null`, `externalPath=null`; переключатели активны.
- Выбор двух компонентов → открытие подтверждения → проверка `:modal`, границ viewport и верхнего слоя → отмена — passed. Реальные компоненты не удалялись.
- При переключении сборки задача `3a7ffebf-a2e8-4fbf-b3db-8dea574b455b` сохранена на паузе с 48 338 447 606 байтами; после перезапуска продолжилась и достигла 54 817 524 224 байт, этап проверки первого шарда. SQLite `quick_check=ok`, ошибок задачи нет. Это не утверждение о завершении всей загрузки 83 617 662 656 байт.

Логи, JSON и скриншоты: `C:\Dev\Aplot-Control-LLM\local\sessions\strata-iq3-s-20261022\managed-*`. Версия приложения остаётся 0.9.1; публикация и коммиты не выполнялись. Приложение оставлено работать с загрузкой модели. Подготовка pack/tokenizer/MTP и реальный инференс Strata в эту задачу не входят.
