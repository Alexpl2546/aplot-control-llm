# Планы развития / Development plans

Эти документы описывают будущие изменения. Наличие плана не означает, что функции уже реализованы.

These documents describe future changes. A plan does not mean that its features are implemented.

## Новая версия: движки и загрузка моделей / Next version: engines and model downloads

- [Поддержка только llama.cpp и Strata: граница, миграция и удаление интеграций](ENGINE_SCOPE.ru.md).
- [Скачивание моделей из Hugging Face: архитектура и этапы](MODEL_DOWNLOADS.ru.md).

Дата / Date: **2026-10-22**. Статус / Status: **планирование / planning**. Эти планы доступны на русском; целевые локальные движки новой версии — llama.cpp и Strata.

## Модульная архитектура / Modular architecture

- [Полный план на русском](MODULAR_RESTRUCTURING.ru.md).
- [Full plan in English](MODULAR_RESTRUCTURING.en.md).

Дата / Date: **2026-10-12**. Статус / Status: **текущая итерация завершена, план выполнен частично / current iteration closed, plan partially implemented**.

- [Фактический прогресс](IMPLEMENTATION_STATUS.ru.md).
- [Implementation progress](IMPLEMENTATION_STATUS.en.md).

Основа: существующие React/TypeScript, Tauri/Rust, SQLite и текущий интерфейс Aplot. Одно приложение управляет несколькими движками и моделями; внешние harness подключаются отдельно.

Baseline: existing React/TypeScript, Tauri/Rust, SQLite and the current Aplot interface. One application manages multiple engines and models; external harnesses connect separately.

Оба текста используют одинаковые идентификаторы этапов P00–P12 и решений D01–D08. Изменения содержания должны вноситься в обе версии.

Both texts use matching stage IDs P00–P12 and decision IDs D01–D08. Content changes must update both versions.
