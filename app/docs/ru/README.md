<a id="docs-index"></a>
# Документация Aplot Control LLM

Это руководство описывает фактический код и отдельно помечает будущие контракты. Оно относится к текущему настольному приложению и не подразумевает смену интерфейса.

## Разделы

- [Обзор](overview.md) — назначение приложения и границы текущей реализации.
- [Архитектура](architecture.md) — поток UI → сервис → Tauri → backend.
- [Карта кода](code-map.md) — входные файлы и сквозные переходы.
- [Маршрут изучения](learning-path.md) — порядок чтения репозитория.
- [Конфигурация](configuration.md) — источники настроек и правила подключения.
- [IPC](ipc.md) — зарегистрированные native-команды и контракты данных.
- [Профили](modules/profiles.md) — versioned storage, секреты, revisions и recovery.
- [UI запусков](modules/launches-ui.md) — выбор профиля и действия с run.
- [Запуски](modules/runs.md) — владение процессами, generations и отдельный lifecycle.
- [Адаптеры движков](modules/engine-adapters.md) — специальная валидация и подготовка.
- [Модели](modules/models.md) — artifacts, consumers и осторожный removal preview.
- [Загрузки моделей](modules/model-downloads.md) — Hugging Face GGUF, очередь, проверка и публикация набора.
- [Ресурсы](modules/resources.md) — native рекомендательное планирование и неопределённость.
- [Задачи](modules/jobs.md) — измерения, отмена, persistence и evidence.
- [Подключения](modules/connections.md) — ConnectionTarget, проверки API и legacy fallback.
- [Harness](modules/harnesses.md) — versioned registry и безопасные previews.
- [Задачи агентов](modules/agent-tasks.md) — сессии на хосте, журнал событий, команды и подтверждения.
- [Бенчмарки](benchmarks.md) — текущие измерения и пределы их интерпретации.
- [Диагностика](troubleshooting.md) — признаки ошибок, источники и следующие действия.

## Статус этой редакции

Для текущей версии действуют только два локальных engine ID: `llama_cpp` и `strata`. Сохранённые профили и внешние файлы legacy не являются активной поддержкой; импорт, экспорт и запуск описаны в [адаптерах](modules/engine-adapters.md).

Загрузка GGUF из Hugging Face имеет отдельную очередь, durable state и установку в библиотеку. Её контракт и ограничения описаны в [модуле загрузок](modules/model-downloads.md). Завершение загрузки не означает готовую конфигурацию Strata или успешный запуск.
