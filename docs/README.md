# Документация Aplot Control LLM

Начните с руководства по фактическому коду: [на русском](../app/docs/ru/README.md) или [in English](../app/docs/en/README.md). Архитектура, карта исходников, настройки, профили, запуски, модели, IPC и диагностика собраны в этих руководствах. [Сборка для Windows](../app/docs/WINDOWS_BUILD.md) и [изменения приложения](../CHANGELOG.md) описаны отдельно.

В этой папке находятся инструкции рабочей установки и отчёты отдельных этапов. Дата и версия внутри отчёта определяют границы его результатов; старый отчёт не подтверждает состояние более новой сборки.

## Установка и локальные модели

- [Каталог моделей, папки загрузки и устранение дублей профилей — 24 октября](MODEL-CATALOG-2026-10-24.ru.md).

- [Настройка движков](ENGINES.md), [модульный установщик](MODULAR-INSTALLER-2026-10-19.ru.md), [Strata IQ3_S: обновление и профили 128K/200K](STRATA-IQ3S-TUNING-2026-10-23.ru.md), [дополнительный профиль 500K · YaRN](STRATA-IQ3S-500K-2026-10-23.ru.md).
- [Обновление Strata 26 октября: v0.2.6 / engine 0.1.50](STRATA-UPDATE-2026-10-26.md), [каталог и загрузка моделей Strata и llama.cpp](STRATA-MODEL-DOWNLOADS-2026-10-23.ru.md), [предыдущее обновление 22 октября](STRATA-UPDATE-2026-10-22.md).
- [Хранилище моделей](MODEL_STORAGE.md), [проверка моделей и профилей](MODEL-REVIEW-2026-10-14.md), [проверка движков](ENGINE-AUDIT-2026-10-13.md).
- [Патчи и интеграция Strata](../integrations/strata/README.md), [Infernix](../integrations/infernix/README.md), [QwFNfer](../integrations/qwfnfer/README.md).
- [Лицензирование](LICENSING.md), [сторонние компоненты](../THIRD_PARTY_NOTICES.md).

## Реализованные возможности

- [Карта агентов](AGENT-NETWORK-INTEGRATION.ru.md), [проекты и задачи](AGENT-WORKSPACE-PROJECTS-2026-10-19.ru.md), [Agent Workspace V2](AGENT-WORKSPACE-V2-IMPLEMENTATION.ru.md).
- [Профили и настроенные агенты](PROFILES-AGENTS-2026-10-20.ru.md), [стабильные настройки и боковая панель](SETTINGS-AGENTS-FIX-2026-10-20.ru.md), [лимиты Codex](CODEX-LIMITS-2026-10-20.ru.md).
- [Общие подключения и Claude Code](UNIFIED-CONNECTIONS-2026-10-19.ru.md), [ChatGPT и Codex](OPENAI-CODEX-V1-IMPLEMENTATION.ru.md), [Hermes](HERMES-AGENT-V1.ru.md).
- [Единые списки выбора Glass Select](GLASS-SELECT-2026-10-21.ru.md), [Smart Task Profiles](SMART-TASK-PROFILES-IMPLEMENTATION.ru.md), [показания потребления GPU](GPU-POWER-2026-10-19.ru.md).

Остальные сохранённые материалы раскрывают решения, измерения и ограничения этих этапов. Для текущего поведения приоритет имеют исходный код и последние относящиеся к нему отчёты.
