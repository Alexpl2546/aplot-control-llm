# Strata: дополнения Aplot / Aplot additions

Upstream: [Niko1221/Strata](https://github.com/Niko1221/Strata).

Base commit: [`4b9e05a2a806a3fe24f7b2560d98626c37dade35`](https://github.com/Niko1221/Strata/commit/4b9e05a2a806a3fe24f7b2560d98626c37dade35), [Strata v0.2.6](https://github.com/Niko1221/Strata/releases/tag/v0.2.6). Qwen engine package: `0.1.50`.

## Русский

`aplot-api.patch` переносит Aplot-доработки на сервер Strata v0.2.6:

- `POST /v1/chat/completions/input_tokens` считает входные токены без запуска инференса.
- Авторизованный `GET /openapi.json` описывает локальный API.
- `ttft_ms` включён в живую статистику и завершённые запросы.
- Каталог моделей по умолчанию остаётся в `models/strata`; сохранённый `data_dir` имеет приоритет.

Каталог установщика Aplot закрепляет официальный исходный архив Strata v0.2.6 и Windows-пакеты engine `0.1.50` в `app/src-tauri/installer/components.json`. Для этой машины используется CUDA 13 пакет: размер 581368579 байт, SHA-256 `a9643e2f5dd5c62e734d2980484c320d41da0160fc4932bf638b7f34e38e74f5`. Установщик выбирает CUDA 13 при драйвере NVIDIA от `580.65`, CUDA 12 для более старого драйвера, а HIP-пакет — по поколению GPU.

Патч меняет только настройки каталога данных и API сервера; веб-интерфейс Strata не меняется. Не применять повторно к уже пропатченной установке.

## English

`aplot-api.patch` carries Aplot's local changes onto the Strata v0.2.6 server:

- `POST /v1/chat/completions/input_tokens` counts prompt tokens without running inference.
- Authenticated `GET /openapi.json` documents the local API.
- `ttft_ms` is included in live metrics and completed requests.
- The default model directory remains `models/strata`; a saved `data_dir` takes priority.

Aplot's installer pins the official Strata v0.2.6 source archive and Windows engine `0.1.50` packages in `app/src-tauri/installer/components.json`. This PC uses the CUDA 13 package: 581368579 bytes, SHA-256 `a9643e2f5dd5c62e734d2980484c320d41da0160fc4932bf638b7f34e38e74f5`. The installer selects CUDA 13 for NVIDIA drivers `580.65+`, CUDA 12 for older drivers, and the matching HIP package by GPU generation.

The patch changes only the data-folder default and server API. Strata's web interface is unchanged. Do not apply it again to an already patched installation.
