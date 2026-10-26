# Хранилище моделей Aplot Control LLM

Снимок каталогов и настроек на 10 октября 2026 года. Корень моделей проекта: `C:\Dev\Aplot-Control-LLM\models`. В таблицах ниже пути указаны относительно этого каталога.

После проверки 13 октября выполнена [чистка рабочего списка](MODEL-CLEANUP-2026-10-13.md). В текущем `models` нет трёх Infernix 27B из исторической таблицы ниже; IQ2_XS, IQ3_XXS и Infernix Dense8 перенесены в архив. Уникальный объём рабочего `models` теперь около 330,29 ГиБ; архив по-прежнему занимает место на диске. [Проверка обновлений движков](ENGINE-AUDIT-2026-10-13.md).

## Сводка

| Каталог | Содержимое | Логический размер | Физическое хранение |
|---|---|---:|---|
| `models\llama.cpp` | GGUF для 10 семейств профилей, проекторы и MTP-файлы | 130,616,188,288 байт (121.65 GiB) | Файлы независимы; варианты контекста ссылаются на те же веса |
| `models\ollama` | Манифесты, метаданные и 11 Ollama-моделей | 120,353,772,623 байт (112.09 GiB) | 10 больших blob-файлов теперь hard link на GGUF из `models\llama.cpp`; отдельный blob `qwen2.5:0.5b` занимает 397,807,936 байт |
| `models\qwfnfer` | MTP draft Qwen3.8 Flash Next Q4_K_M | 2,786,205,066 байт (2.59 GiB) | Один GGUF и `SOURCE.json` |
| `models\strata` | Три разбиения Flash Next, prepared packs и MTP-данные | 240,859,651,365 байт (224.32 GiB) | Уникальные файлы внутри Strata занимают 180,183,304,101 байт; общий shard и `dense.bin` учтены один раз |
| `models\infernix` | NVIDIA Dense8 и Uncensored Flash Next, три 27B | Веса и n-gram около 303,7 GiB по именам | Около 254,9 GiB уникальных весов и n-gram: две Flash Next используют один общий том; подробности ниже |

Для первых четырёх каталогов вместе: 494,615,817,342 байт по именам файлов и 313,983,686,462 байта уникальных файловых объектов на диске (292.42 GiB). Содержимое `models\infernix` в эту сумму не входит.

10 Ollama blob-файлов сверены SHA-256: хеш каждого GGUF совпал с digest в имени blob. Они заменены hard link-ами с прежними путями и манифестами. Дополнительно два повторных Strata `dense.bin` связаны с одной проверенной копией. Освобождено 123,031,854,016 байт (114.56 GiB); сами веса и профили остались доступны.

## GGUF для llama.cpp

Профили с разными контекстами используют одни и те же файлы, а не отдельные копии весов. Сейчас 39 профилей в БД; модельные пути у 38 llama.cpp-профилей ведут к перечисленным ниже файлам.

| Точный путь | Размер, байт | Назначение / варианты профилей |
|---|---:|---|
| `llama.cpp\bonsai2-27b-pq2\Ternary-Bonsai-2-27B-PQ2_0.gguf` | 7,206,168,928 | Ternary Bonsai 2 27B PQ2; контексты 65,536 / 98,304 / 131,072 / 262,144 |
| `llama.cpp\gemma12\gemma-4-12b-it-UD-IQ3_XXS.gguf` | 4,639,716,160 | Gemma 4 12B IT IQ3_XXS; контексты 65,536 / 98,304 / 131,072 / 262,144 |
| `llama.cpp\gemma12\gemma-4-12b-it-UD-Q4_K_XL.gguf` | 7,366,423,360 | Gemma 4 12B IT Q4_K_XL; контексты 65,536 / 98,304 / 131,072 / 262,144 |
| `llama.cpp\gemma12\mtp-gemma-4-12b-it.gguf` | 465,109,248 | MTP draft, общий для профилей Gemma 12B IQ3 и Q4 |
| `llama.cpp\gemma26-q3\google_gemma-4-26B-A4B-it-Q3_K_XL.gguf` | 13,377,962,624 | Gemma 4 26B A4B Q3_K_XL; контексты 65,536 / 98,304 / 131,072 |
| `llama.cpp\gemma4-e4b\Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf` | 8,133,226,464 | Gemma 4 E4B Q8_K_P; контексты 65,536 / 98,304 / 131,072 |
| `llama.cpp\gemma4-e4b\mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf` | 990,288,832 | Vision projector для Gemma 4 E4B |
| `llama.cpp\gpt-oss-20b-mxfp4\gpt-oss-20b-MXFP4.gguf` | 12,109,566,624 | GPT-OSS 20B MXFP4; профили 65,536 / 98,304 / 131,072 |
| `llama.cpp\ornith-1.5-9b-q8\Ornith-1.5-9B-uncensored.Q8_0.gguf` | 9,527,501,984 | Ornith 1.5 9B Q8_0; контексты 65,536 / 98,304 / 131,072 |
| `llama.cpp\qwen27-iq3-mtp\Qwen3.8-27B-UD-IQ3_XXS.gguf` | 10,934,860,704 | Qwen3.8 27B IQ3_XXS; обычные и MTP-профили до 131,072 |
| `llama.cpp\qwen27-iq3-mtp\mtp-Qwen3.8-27B-Q4_0.gguf` | 1,369,590,656 | MTP draft для профилей Qwen27 IQ3 MTP |
| `llama.cpp\qwen35-iq4-xs\Qwen3.8-35B-A3B-IQ4_XS.gguf` | 19,627,788,160 | Qwen3.8 35B A3B IQ4_XS; контексты 65,536 / 98,304 / 131,072 |
| `llama.cpp\qwen35-q4-k-m\Qwen3.8-35B-A3B-Q4_K_M.gguf` | 21,713,462,944 | Qwen3.8 35B A3B Q4_K_M; контексты 65,536 / 98,304 / 131,072 |
| `llama.cpp\rvn-qwen27-mtp\RVN-Q3_K_S-multilingual-mtp.gguf` | 12,525,274,592 | RVN Qwen27 Q3_K_S MTP; контексты 65,536 / 98,304 |
| `llama.cpp\rvn-qwen27-mtp\mmproj-Qwen3.8-27B-Q8_0.gguf` | 629,247,008 | Vision projector для RVN Qwen27 |

## Ollama

Управляемый Aplot процесс Ollama запускается с `OLLAMA_MODELS=C:\Dev\Aplot-Control-LLM\models\ollama`. Для 10 импортированных моделей указанный blob-путь и исходный GGUF теперь являются двумя именами одного файла. Манифесты сохранены.

| Ollama alias | Blob в `models\ollama\blobs` | Исходный GGUF в `models\llama.cpp` |
|---|---|---|
| `aplot-rvn-q3-k-s-multilingual-mtp-2789dd:latest` | `sha256-221249e7b0649a336eb200adaf10357aacf7f3cde95d86165a8ff442070f1c2f` | `rvn-qwen27-mtp\RVN-Q3_K_S-multilingual-mtp.gguf` |
| `aplot-qwen3-8-35b-a3b-q4-k-m-d35477:latest` | `sha256-196103269085bc54c9b8f49ed21e9f53e1b56b465e8b796c6d8e31e06f63cfa5` | `qwen35-q4-k-m\Qwen3.8-35B-A3B-Q4_K_M.gguf` |
| `aplot-qwen3-8-35b-a3b-iq4-xs-360117:latest` | `sha256-b645af45431ef9b41f43cae51c9323b2d0ca84f23031d483d2105c643ae58d65` | `qwen35-iq4-xs\Qwen3.8-35B-A3B-IQ4_XS.gguf` |
| `aplot-qwen3-8-27b-ud-iq3-xxs-606809:latest` | `sha256-c0b7c3038681ed2e3040456c1dd45f9858b6c2290bed172c70388a94874f3eee` | `qwen27-iq3-mtp\Qwen3.8-27B-UD-IQ3_XXS.gguf` |
| `aplot-ornith-1-5-9b-uncensored-q8-0-61c333:latest` | `sha256-05e0878744b36b7c55385ecb8aaf47bddf0b43f720dbfac5c79e489c02abca8f` | `ornith-1.5-9b-q8\Ornith-1.5-9B-uncensored.Q8_0.gguf` |
| `aplot-gpt-oss-20b-mxfp4-9b7d57:latest` | `sha256-27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901` | `gpt-oss-20b-mxfp4\gpt-oss-20b-MXFP4.gguf` |
| `aplot-gemma-4-e4b-uncensored-hauhaucs-aggressive-q8-k-p-67ab1b:latest` | `sha256-a4c4177f9fd7e3f56522675afb742f079a53f9226195b7db5e9888c872f053da` | `gemma4-e4b\Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf` |
| `aplot-google-gemma-4-26b-a4b-it-q3-k-xl-d15dab:latest` | `sha256-3e7b3be5116a1cc6321953f6f11d97d242482fd4a69cecd01e88eebff7d0dee2` | `gemma26-q3\google_gemma-4-26B-A4B-it-Q3_K_XL.gguf` |
| `aplot-gemma-4-12b-it-ud-q4-k-xl-87ebbb:latest` | `sha256-90fd944d227e9d9b68e7e2c7d5b57b79d4c66ed521b0919fbbd932cf834f6f8e` | `gemma12\gemma-4-12b-it-UD-Q4_K_XL.gguf` |
| `aplot-gemma-4-12b-it-ud-iq3-xxs-95bf28:latest` | `sha256-0cf13ac91a6c1b1aaaeae633181c75af0f1fa3da1a89abf2086038e105c789f0` | `gemma12\gemma-4-12b-it-UD-IQ3_XXS.gguf` |

Ещё одна модель Ollama хранится только как blob в Aplot-библиотеке:

- Alias: `qwen2.5:0.5b`
- Blob: `C:\Dev\Aplot-Control-LLM\models\ollama\blobs\sha256-c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515` (397,807,936 байт)
- Manifest: `C:\Dev\Aplot-Control-LLM\models\ollama\manifests\registry.ollama.ai\library\qwen2.5\0.5b`

## Strata

Три варианта Qwen3.8 Flash Next состоят из двух GGUF-шардов. Второй шард — одна физическая NTFS-запись с тремя hard link-путями, а не три копии.

| Вариант | Уникальный shard 1 | Общий shard 2 | Размер двух шардов |
|---|---|---|---:|
| IQ2_XS | `strata\models\IQ2_XS\Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf` — 39,225,954,592 байт | `strata\models\IQ2_XS\Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf` — 28,800,138,432 байт | 68,026,093,024 байт |
| IQ3_S | `strata\models\IQ3_S\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf` — 54,817,524,224 байт | `strata\models\IQ3_S\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf` — тот же shard 2 | 83,617,662,656 байт |
| IQ3_XXS | `strata\models\IQ3_XXS\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf` — 47,039,860,096 байт | `strata\models\IQ3_XXS\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf` — тот же shard 2 | 75,839,998,528 байт |

В папке IQ3_S дополнительно лежит `C:\Dev\Aplot-Control-LLM\models\strata\models\IQ3_S\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf.part.serial-backup` (1,803,550,720 байт). Это неполная резервная часть загрузки, не полноценный GGUF-шард; она оставлена на месте.

### Подготовленные Strata packs и MTP

| Точный каталог | Размер по именам файлов | Содержимое |
|---|---:|---|
| `strata\packs\iq2_xs` | 1,548,225,531 байт | Native expert pack, tokenizer и общий `dense.bin` |
| `strata\packs\iq3_s` | 1,548,225,545 байт | Native expert pack, tokenizer и hard link на общий `dense.bin` |
| `strata\packs\iq3_xxs` | 1,548,225,539 байт | Native expert pack, tokenizer и hard link на общий `dense.bin` |
| `strata\mtp` | 6,927,665,066 байт, 41 файл | MTP draft/извлечённые тензоры для Strata; `mtp-q2_0.gguf` — 889,017,216 байт |

Общие `dense.bin` находятся по путям `strata\packs\{iq2_xs,iq3_s,iq3_xxs}\dense.bin`, размер каждого имени — 1,538,035,200 байт. Все три пути теперь hard link-и на один файл. В `strata\mtp\rt` файлы `dense.bin` (116,099,072 байта) и `experts.bin` (707,788,800 байт) также имеют hard link-и в `app\artifacts\strata-2026-10-09\mtp-cyrillic\`.

Дополнительные Strata-компоненты хранятся в GGUF-шардах, `packs` и `mtp`. Отдельный файл `.ngram` используется Infernix; его расположение указано ниже.

## QwFNfer

- `C:\Dev\Aplot-Control-LLM\models\qwfnfer\mtp-Qwen3.8-Flash-Next-Q4_K_M.gguf` — 2,786,204,800 байт; MTP draft head Qwen3.8 Flash Next, источник указан в `models\qwfnfer\SOURCE.json`.
- `models\qwfnfer\SOURCE.json` — 266 байт.

Текущий `settings.qwfn.modelPath` существует и указывает на модель IQ2_XS в `models\strata`; `settings.qwfn.mtpPath` пуст. Каталог `models\qwfnfer` добавлен в `modelDirectories`, чтобы библиотека сканировала и этот GGUF.

## Infernix и внешние кэши

`C:\Dev\Aplot-Control-LLM\models\infernix` — проектный каталог Infernix. Индекс ниже дополнен основной задачей после завершения загрузки Uncensored. Суммы в таблице — только файлы `.infernix` / `.ninfer`, без малого объёма метаданных и лицензий.

| Подкаталог в `infernix` | Веса, байт | Точка запуска |
|---|---:|---|
| `Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix` | 76,867,265,280 | `Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix-00001-of-00003.infernix` |
| `Qwen3.8-Flash-Next-Uncensored-NVFP4-Infernix` | 76,302,074,624 | `Qwen3.8-Flash-Next-Uncensored-NVFP4-Infernix-00001-of-00003.infernix` |
| `Qwen3.8-27B-NVIDIA-NVFP4-NInferV3` | 22,783,240,452 | `qwen3_8_27b_nvfp4-nvidia.ninfer` |
| `Qwen3.8-27B-Quasar-NVFP4-NInferV3` | 21,600,126,976 | `qwen3_8_27b_nvfp4-quasar-proposal.ninfer` |
| `Qwen3.8-27B-Uncensored-NVFP4-NInferV3` | 23,719,715,844 | `qwen3_8_27b_nvfp4-uncensored.ninfer` |

Каждый Flash Next состоит из трёх частей; удаляйте вариант целиком, а не отдельный shard. В обеих Flash Next-папках `Qwen3.8-Flash-Next-NVIDIA-NVFP4-Infernix.ngram` — два hard link-имени одного 52,429,058,048-байтового файла. Удаление одного имени не лишает другую модель тома; его место освободится после удаления обоих имён. Infernix 27B пользователь разрешил удалить после неудачных запусков на RTX 5080, но автоматическая проверка отклонила команды с `blocked by policy`; эти три папки пока существуют и занимают 63,43 GiB весов. [Настройка и проверки Flash Next на 131K](INFERNIX-TUNING-131K-2026-10-10.md).

Проверены известные проекту места хранения:

- Aplot запускает собственный Ollama с `OLLAMA_MODELS` внутри `models\ollama`; переменные `OLLAMA_MODELS`, `HF_HOME`, `HUGGINGFACE_HUB_CACHE` и `TRANSFORMERS_CACHE` в окружении текущего процесса не заданы.
- В `%USERPROFILE%\.ollama\models` есть внешнее хранилище `qwen2.5:0.5b`; его 397,807,936-байтовый blob имеет тот же SHA-256, что и blob внутри проекта. Внешний файл оставлен на месте, так как каталог может обслуживаться другим процессом/проектом.
- `%USERPROFILE%\.cache\huggingface\hub` содержит каталог `models--wallawalla47--Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix`: дополнительная проверка основной задачей нашла только 40-байтовый `refs\main`, без весов. Рабочие веса находятся в проекте.
- Известные каталоги LM Studio и `C:\Models` отсутствуют.
- В просмотренных каталогах движков вне `models` больших файлов весов (>50 MiB) не найдено.

## Пути и безопасное удаление

- При проверке 99 ссылок на модельные файлы и каталоги в настройках, профилях и кэше Aplot все не относящиеся к Infernix пути существуют. Недействительных путей в `modelDirectories` не было; туда добавлен только существующий `models\qwfnfer`. Все 16 каталогов сканирования существуют.
- Перед удалением GGUF проверьте все профили: несколько профилей контекста могут использовать один путь. Остановите соответствующий движок перед удалением весов.
- Ollama-модели удаляйте по alias через Ollama (`ollama rm <alias>` или интерфейс управления моделями). Удаление blob hard link-а не удаляет исходный GGUF из `models\llama.cpp`.
- Удаление одного Strata-варианта снимает только его имя общего shard 2 и `dense.bin`; физические данные остаются, пока существует другой hard link. Общий shard 2 освободится только после удаления всех трёх путей. Тот же принцип действует для MTP-файлов, связанных с `app\artifacts`.
- Каталоги `packs`, `mtp`, проекторы, MTP draft-файлы и `.part.serial-backup` не являются временным мусором автоматически: сначала проверьте конфигурации и потребность в возобновлении загрузки.
- Для Infernix `.ngram` — общий том; его не нужно скачивать отдельно для каждого Flash Next. Файлы DLL и сервер находятся в `engines\infernix\bin`, веса — в `models\infernix`.

## Резервная копия и изменения БД

Перед изменением создана SQLite-копия через online backup API: `C:\Dev\Aplot-Control-LLM\data\backups\model-storage-before-20261009T212918Z.sqlite3`.

В актуальной транзакции обновлено только поле `settings.modelDirectories`: добавлен `C:\Dev\Aplot-Control-LLM\models\qwfnfer`. Профили (39 записей), избранное и история событий сохранены; база Infernix-настроек не редактировалась. Профили и model-path ссылки после изменения проверены без запуска сервера или инференса.
