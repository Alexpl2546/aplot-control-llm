# Infernix в Aplot

Upstream: [Wallawalla47/Infernix](https://github.com/Wallawalla47/Infernix), Apache-2.0.
Pinned revision: `25790c8dec1c61ece9781fd1aa909966c926561a` (`windows-2026.10.11`).

Aplot запускает `infernix-serve.exe` отдельным управляемым процессом. Доступны выбор модели,
старт/стоп/перезапуск, журнал, настройки контекста, KV, памяти, concurrency и speculative decoding,
библиотека `.infernix` / `.ninfer` v3, метрики и встроенные тесты контекста.

Модель должна быть полностью загружена. Проверяются magic/version, длины файлов и принадлежность
всех continuation-шардов. В библиотеке показывается только entry-файл, а размер учитывает все шарды.
GGUF не помечаются как совместимые: конвертацию выполняют инструменты upstream отдельно.
Для Flash-Next нужен соответствующий `.ngram` том. Если в папке есть ровно один том нужного размера,
Aplot подставляет его при выборе модели; окончательную проверку volume ID выполняет движок.

## Установка на Windows

Нужны NVIDIA RTX 50 (`sm_120a`), драйвер CUDA 13, MSVC, CMake и CUDA Toolkit 13 для сборки.
Готовая сборка не требует установленного Toolkit. GPU и память моделей проверяйте отдельно:
характеристики RTX 5090 из upstream не гарантируют запуск на RTX 5080 16 ГБ.

```powershell
git clone https://github.com/Wallawalla47/Infernix.git engines/infernix
git -C engines/infernix checkout 25790c8dec1c61ece9781fd1aa909966c926561a
git -C engines/infernix apply ../../integrations/infernix/aplot-token-count.patch
git -C engines/infernix apply ../../integrations/infernix/cuda13-msvc.patch
git -C engines/infernix apply ../../integrations/infernix/cuda13-msvc-w4a16.patch
# Установите vcpkg по инструкции Microsoft, затем:
vcpkg install "ffmpeg[core,avcodec,avformat,swscale]:x64-windows" "curl[core,sspi,ssl]:x64-windows"
./integrations/infernix/build.ps1 -VcpkgRoot C:/vcpkg
```

Старый Windows SDK 10.0.18362 не собирает D3D12 в FFmpeg 9. В локальной установке Aplot
`ports/ffmpeg/portfile.cmake` заменяет `--enable-d3d12va` на `--disable-d3d12va` перед установкой.
Также убран неиспользуемый `#include <stdalign.h>` из `libswscale/ops.h` (старый UCRT не содержит заголовка).
Это отключает аппаратное декодирование видео через D3D12; CPU-декодирование и CUDA-инференс доступны.
Патч сохранён в `ffmpeg-sdk18362.patch`, база vcpkg — `0699a19d0c6386247ce50d4dedbb8217d484d536` (MIT, `LICENSE-vcpkg`).
Применять его нужно к vcpkg перед установкой FFmpeg. На актуальном SDK эта адаптация может не понадобиться.

Скрипт сборки размещает сервер и необходимые DLL в `engines/infernix/bin/infernix-serve.exe`.
Используйте CUDA 13.4.2: CUDA 13.3 воспроизводимо падает в cicc на `q8_gdn_input_gemm_splitk.cu`.
Локальная сборка использует официальный набор NVIDIA redistrib 13.4.2 в `engines/infernix-deps/cuda-13.4`
и отдельный `-BuildRoot engines/infernix/build-windows-cuda134`, чтобы сохранить диагностику CUDA 13.3.
Aplot обнаруживает этот путь автоматически. Каталог `models/infernix` автоматически добавляется к папкам библиотеки, если он существует.
Рекомендуемые артефакты перечислены в [README upstream](https://github.com/Wallawalla47/Infernix#models):
Flash-Next Dense8 + n-gram том, Qwen3.8-27B NVIDIA, Quasar и Uncensored NVFP4 NInferV3.
Разные лицензии моделей сохраняются в их каталогах; лицензия Aplot на веса не распространяется.

`cuda13-msvc.patch` заменяет вызов kernel через локальную constexpr-переменную внутри lambda
на прямое имя той же специализации. Это устраняет C2326 в CUDA 13.3/MSVC 2022 без изменения
алгоритма, grid, параметров или точности вычислений.

Aplot использует prefix cache в RAM. Сохранение кэша на диск не предоставляется в интерфейсе:
upstream сохраняет его при двойном Ctrl+C, а управляемый скрытый процесс останавливается средствами ОС.

## Точные тесты и мониторинг

`aplot-token-count.patch` добавляет `POST /v1/chat/completions/input_tokens` через тот же
`parse_chat_completion_request` и `GenerationService::count_prompt_tokens`, что обслуживают
генерацию. Авторизация и обработка ошибок соответствуют Chat Completions. Подсчёт не генерирует
ответ и не меняет prefix cache. Это дополнение Aplot, исходный движок остаётся проектом Infernix.

Тесты передают `chat_template_kwargs.enable_thinking=false` и при подсчёте, и при генерации.
Не используйте `reasoning_effort: off`: Infernix принимает `none`, а `off` возвращает 400.
Aplot измеряет реальные размеры промптов, recall и continuity; автоматический поиск параметров
по-прежнему доступен только для llama.cpp.

Метрики читаются из `/metrics`, имя API-модели — из `/v1/models`. Скорости рассчитываются из
приращений счётчиков между опросами, при перезапуске история сбрасывается. TTFT в мониторинге —
среднее с запуска сервера (Prometheus histogram sum/count); TTFT теста — измерение конкретного
запроса. Физический KV-кэш включает сохранённые префиксы и не выдаётся за длину активного промпта.
Справка API поставляется с Aplot, поскольку upstream не публикует `/openapi.json`.

Для реального теста без окна приложения используйте выделенную тестовую базу:

```powershell
$env:APLOT_BENCH_ENDPOINT="http://127.0.0.1:8097"
$env:APLOT_BENCH_MODEL="<id из /v1/models>"
$env:APLOT_BENCH_CONTEXT="65536"
$env:APLOT_BENCH_RUNS="1" # один recall и три окна continuity; задайте больше для повторов
$env:APLOT_BENCH_OUTPUT="C:/path/to/result.json"
cargo test --manifest-path app/src-tauri/Cargo.toml real_engine_context_campaign -- --ignored --nocapture
```

История запусков и профили пользователя при этом не изменяются. Результаты и модели не включены в Git.

`run-campaign.py` управляет отдельным сервером, проверяет совпадение count/usage и авторизацию,
затем вызывает этот Rust-тест для указанных контекстов. Нужен путь к exe тестов, полученный
после `cargo test --lib --no-run`; результаты, GPU CSV и логи сохраняются в `--output`.

## Обновление и настройка 131K, 10 октября 2026

**Текущая сборка:** 13 октября движок обновлён до `windows-2026.10.11` / `25790c8dec1c61ece9781fd1aa909966c926561a` с сохранением трёх патчей Aplot. Сборка CUDA 13.4.2/MSVC, 7 выбранных тестов и реальный короткий запрос к Uncensored с контекстом 131072 прошли. Подсчёт input tokens совпал с usage генерации. Это проверка совместимости, а не повторное измерение скорости и качества заполненного контекста; результаты ниже относятся к сборке 10 октября. [Отчёт обновления](../../docs/ENGINE-AUDIT-2026-10-13.md).

Движок обновлён до tag `windows-2026.10.09.2` / commit `0b20388fc293fa1be962e6e42f5d639889a4fb61` для Flash Next Uncensored с W4A16-вычислениями. Сборка и 7 тестов GPU/сервинга прошли повторно. Дополнительный `cuda13-msvc-w4a16.patch` устраняет C2326 в новом ядре тем же прямым обращением к специализации, без изменения вычислений. Предыдущий сервер сохранён в `engines/infernix/bin-88b1d59`. Отчёт первой кампании фиксирует старую сборку; результаты разных сборок не смешиваются.

`tune-131k.py` измеряет три коротких запроса (английский, русский, Python) при профиле 131072; `--long` добавляет почти полный синтетический реестр. Каждый кандидат запускается отдельно, usage читается из SSE, вложенные ошибки прерывают пробу. Это отбор скорости, а не замена полным recall/continuity из `run-campaign.py`. Параметры `--binary`, `--model`, `--ngram` позволяют сравнить другую сборку/артефакт. `--strata-config` с `--cases baseline` запускает временную копию конфигурации Strata на отдельном порту, с теми же текстами.

[Текущая проверка 131K](../../docs/INFERNIX-TUNING-131K-2026-10-10.md). Общий n-gram для Dense8 и Uncensored подключён hard link, поэтому не занимает второй раз 48,83 ГиБ.

Игнорируемый тест `real_native_artifacts_inspection` проверяет полноту shards, метаданные и команду запуска через библиотеку Aplot. Укажите `APLOT_INFERNIX_MODELS`, `APLOT_INFERNIX_BINARY`, `APLOT_INFERNIX_INSPECTION_OUTPUT` и точное `APLOT_INFERNIX_EXPECTED_MODELS` для проверяемого каталога (по умолчанию 4). Это позволяет проверять отдельную новую модель без ослабления проверки полноты.

Параметры блока `settings.infernix` сохранены в [flash-next-131k.json](presets/flash-next-131k.json) (prefill 8192, MTP off) и [flash-next-131k-mtp.json](presets/flash-next-131k-mtp.json) (prefill 4096, MTP, draft 4, proposal head). Общие параметры: INT8 KV, один запрос, host cache 2048 MiB, RAM reserve 8192 MiB, VRAM reserve 1536 MiB, expert RAM auto (`expertRamMiB: 0`). Укажите путь к первой части выбранного Flash Next, её `.ngram` и серверу в настройках Infernix. Результаты полной проверки каждого режима приведены в отчёте 131K.
