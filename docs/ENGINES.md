# Настройка движков / Engine setup

## Русский

Aplot поддерживает два локальных движка: **llama.cpp** и **Strata**. Внутри Strata доступны семейства **Qwen** и **DeepSeek**. Они используют общий жизненный цикл Strata, но имеют отдельные нативные пакеты. Web UI Strata в приложение не встраивается. Установщик включает Aplot и выбранный базовый набор компонентов; веса моделей загружаются отдельно.

| Движок | Где выбирается | Обновление |
| --- | --- | --- |
| llama.cpp | Профиль с `llama-server.exe` или GGUF-моделью | Установка приложения/выбранного компонента |
| Strata · Qwen | Настройка модели Strata из каталога | Отдельная кнопка Qwen в настройках Strata; upstream подписанный feed |
| Strata · DeepSeek | Настройка модели семейства DeepSeek из каталога Strata | Отдельная кнопка DeepSeek; upstream подписанный feed и только пакет, совместимый с GPU |

Установщик закрепляет Strata v0.2.6, ставит подходящий подписанный Qwen компонент и включает поддержку семейства DeepSeek. DeepSeek нативный пакет загружается отдельно при подготовке модели или через кнопку обновления, когда в подписанном каталоге есть сборка для компьютера. Для Windows в закреплённом feed доступность зависит от GPU и CUDA-варианта. При отсутствии совместимого пакета приложение сообщает об этом и не подменяет движок другой сборкой.

Обновление движков не меняет версию оболочки Aplot. Обновление самой оболочки выполняется отдельно через подписанный Tauri updater. Операция движка блокируется, пока Strata запущена или выполняется подготовка модели.

Для Strata требуется установленный runtime и `strata-*.json` для подготовленной модели. Весовые файлы не входят в установщик. Публичную GGUF-модель можно загрузить через библиотеку по ссылке Hugging Face или `owner/repository`; совместимость модели с выбранным семейством проверяется отдельно. См. [адаптеры движков](../app/docs/ru/modules/engine-adapters.md), [модельные загрузки](../app/docs/ru/modules/model-downloads.md), [интеграцию Strata](../integrations/strata/README.md) и [архитектуру нескольких Strata движков](STRATA-MULTI-ENGINE-ARCHITECTURE-2026-10-26.ru.md).

## English

Aplot supports two local engines: **llama.cpp** and **Strata**. Strata provides **Qwen** and **DeepSeek** families. They share Strata's lifecycle but use separate native engine packages. Strata's web UI is not embedded in Aplot. The installer includes Aplot and the selected base components; model weights are downloaded separately.

| Engine | Selection | Update |
| --- | --- | --- |
| llama.cpp | Profile with `llama-server.exe` or a GGUF model | App/selected component installation |
| Strata · Qwen | Strata model setup from its catalog | Separate Qwen button in Strata settings; signed upstream feed |
| Strata · DeepSeek | DeepSeek-family model setup from the Strata catalog | Separate DeepSeek button; signed upstream feed and a GPU-compatible package |

The installer pins Strata v0.2.6, installs the matching signed Qwen component, and includes DeepSeek family support. The DeepSeek native package is downloaded separately during model preparation or through its update button when the signed feed offers a build for the computer. Availability on Windows depends on the GPU and CUDA variant in the pinned feed. If there is no compatible package, Aplot reports that and does not substitute a different build.

Engine updates do not change the Aplot shell version. Shell updates use the separate signed Tauri updater. An engine operation is refused while Strata is serving or a model is being prepared.

Strata needs its runtime and a prepared `strata-*.json` model configuration. Model weights are not part of the installer. A public GGUF model can be downloaded through the library using a Hugging Face link or `owner/repository`; compatibility with the selected family is checked separately. See [engine adapters](../app/docs/en/modules/engine-adapters.md), [model downloads](../app/docs/en/modules/model-downloads.md), the [Strata integration](../integrations/strata/README.md), and the [multi-engine Strata architecture](STRATA-MULTI-ENGINE-ARCHITECTURE-2026-10-26.ru.md).

Ollama, QwFNfer, and Infernix belong to an earlier product version. Historical references may remain in archived documentation; the current installer does not offer them.
