# Настройка движков / Engine setup

## Русский

Aplot поддерживает два локальных движка: **llama.cpp** (`llama_cpp`) и **Strata** (`strata`). Установить и обновить их можно в «Настройки → Компоненты». Веса моделей загружаются отдельно.

### llama.cpp

Укажите `llama-server.exe`, выберите GGUF в библиотеке и сохраните профиль запуска. Параметры доступны в разделе «Модели → Подобрать»; подробный редактор раскрывается отдельно. Возможности определяются по `--help` установленного бинарника.

Режим роутера использует штатные `--models-preset`, `--models-max` и автозагрузку моделей, если они поддерживаются установленной сборкой. Имя сохранённого профиля служит идентификатором модели в API роутера.

### Strata

Установите Strata через компоненты или укажите существующую установку. Семейства Qwen и DeepSeek используют собственные пакеты движка. Установка пакета и подготовка модели — отдельные действия: после установки добавьте модель из каталога и выберите подготовленную конфигурацию `strata-*.json`.

Для точного подсчёта входных токенов, OpenAPI и дополнительных метрик используются [дополнения API Strata](../integrations/strata/README.md). Успешная загрузка модели сама по себе не подтверждает готовность сервера.

См. [адаптеры движков](../app/docs/ru/modules/engine-adapters.md), [загрузки](../app/docs/ru/modules/model-downloads.md) и [управление запусками](../app/docs/ru/modules/runs.md).

## English

Aplot supports two local engines: **llama.cpp** (`llama_cpp`) and **Strata** (`strata`). Install or update them in Settings → Components. Model weights are downloaded separately.

For llama.cpp, select `llama-server.exe`, choose a GGUF model and save a launch profile. Settings are under Models → Pick, with the detailed editor available separately. The installed binary's `--help` output determines available flags. Native routing uses preset, residency and autoload capabilities; profile names become API model identifiers.

For Strata, install a component or select an existing installation. Qwen and DeepSeek use separate engine packages. Install the package, prepare a model from its catalog, and choose its `strata-*.json` configuration. Package installation and model preparation are separate operations.

The [Strata API additions](../integrations/strata/README.md) provide exact input-token counting, OpenAPI and extra metrics. A completed download does not establish server readiness. See [engine adapters](../app/docs/en/modules/engine-adapters.md), [downloads](../app/docs/en/modules/model-downloads.md) and [runs](../app/docs/en/modules/runs.md).
