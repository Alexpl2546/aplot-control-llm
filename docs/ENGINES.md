# Настройка движков / Engine setup

## Русский

Движки устанавливаются отдельно от Aplot. Можно хранить их в любой доступной папке и указать путь в настройках. Для переносной структуры удобно создать рядом с приложением `engines`, `models` и `data`; эти папки не входят в исходники.

| Движок | Что указать в Aplot | Проверка перед запуском |
| --- | --- | --- |
| llama.cpp | Путь к `llama-server.exe` и папки GGUF | DLL выбранной сборки находятся рядом с EXE; модель совместима с ней |
| Strata | Корневую папку с `setup.py` и конфигурацию `strata-*.json` из той же папки | Существует `.venv/Scripts/python.exe`, движок и токенизатор; пути в JSON доступны |
| Ollama | Путь к `ollama.exe`, локальный endpoint и модель | Модель поддерживает генерацию, а не только embeddings; облачные модели не используются |
| QwFNfer | Путь к `qwfn-server.exe`, первую часть GGUF и настройки памяти | Архитектура `qwen4exp`; MTP-файл соответствует модели; MTP и prefix cache одновременно не включены |

Для Strata используйте [инструкцию автора](https://github.com/Niko1221/Strata). Aplot запускает её подготовленный Python-сервер, а не заменяет установщик Strata. Локальный патч для подсчёта токенов, TTFT и справки API описан в [integrations/strata](../integrations/strata/README.md).

Для QwFNfer использована ветка [cakescats-ru](https://github.com/cakescats/QwFNfer-Secure-Multilang/tree/cakescats-ru), коммит `4abe9b76ac7e3eb8febfde7a59c9efeea93da0fa`. Интеграция работает напрямую с `qwfn-server.exe`; веб-консоль форка, её учётные записи и управление пользователями не подключены. Локальный патч точного подсчёта токенов находится в [integrations/qwfnfer](../integrations/qwfnfer/README.md).

Выбранный движок и редактируемые параметры могут отличаться от уже работающей конфигурации. Чтобы применить изменения, перезапустите сервер через приложение. Используйте адрес фактического запуска, показанный на главной странице.

## English

Install engines separately. They can live in any accessible directory; select their paths in Settings. A portable layout can place `engines`, `models` and `data` beside the app. These directories are not part of the source repository.

| Engine | Select in Aplot | Check before starting |
| --- | --- | --- |
| llama.cpp | `llama-server.exe` and GGUF directories | The build's DLLs are beside the EXE and it supports the model |
| Strata | Root folder containing `setup.py` and a `strata-*.json` in that folder | `.venv/Scripts/python.exe`, the engine and tokenizer exist; JSON paths resolve |
| Ollama | `ollama.exe`, a local endpoint and a model | The model supports generation rather than embeddings only; cloud models are excluded |
| QwFNfer | `qwfn-server.exe`, the first GGUF shard and memory settings | Architecture is `qwen4exp`; MTP matches the model; MTP and prefix cache are not both enabled |

Follow [Strata's setup guide](https://github.com/Niko1221/Strata) first. Aplot starts its prepared Python server rather than replacing its installer. See [the Strata patch](../integrations/strata/README.md) for local token counting, TTFT and API-reference additions.

The QwFNfer integration used the [cakescats-ru branch](https://github.com/cakescats/QwFNfer-Secure-Multilang/tree/cakescats-ru), revision `4abe9b76ac7e3eb8febfde7a59c9efeea93da0fa`. Aplot uses `qwfn-server.exe` directly, without the fork's web console, accounts or user management. The exact token-counting addition is preserved in [integrations/qwfnfer](../integrations/qwfnfer/README.md).

Selected settings may differ from the currently running configuration. Restart through Aplot to apply changes, and use the actual endpoint shown on the dashboard.
