# Strata engine update — 2026-10-22

## Русский

Рабочая установка обновлена с Strata source `v0.1.45` до `v0.2.2` (`011c9e600a93bbc9fd451c563501b5831c32bbca`). Бинарный движок обновлён с `0.1.45` до `0.1.47` из официального Windows x86-64 CUDA 13 архива. Его размер — 580428476 байт, SHA-256 — `59833d875b2f3807791533f5dd077a0cb0ed08d4c1cab3136ad2ceb165871cd1`. Контрольные суммы файлов внутри пакета также сверены с `engine-component.json`.

На этой машине RTX 5080 и драйвер NVIDIA `595.71`; пакет CUDA 13 требует `580.65` или новее. `strata.exe --version` возвращает `strata 0.1.47`. Python API-сервер компилируется и импортируется в текущем окружении; его runtime-зависимости совпадают с новым `requirements.txt` (CMake и Ninja остались только как лишние пакеты в существующей среде).

На новую серверную версию перенесены Aplot API-доработки: `ttft_ms`, авторизованный `/openapi.json` и точный `POST /v1/chat/completions/input_tokens`. Каталог моделей по умолчанию остаётся `models/strata` в рабочем пространстве Aplot. Действующий `%APPDATA%\Strata\settings.json` и шесть профилей моделей побайтно совпадают с резервной копией. Веса моделей не перемещались и не скачивались. Изменения веб-интерфейса Strata не вносились.

Каталог компонентов и скрипт установщика Aplot обновлены: исходники Strata закреплены на commit `011c9e600a93bbc9fd451c563501b5831c32bbca`, пакеты — на `0.1.47`; SHA-256 и размеры записаны в `app/src-tauri/installer/components.json`. Установщик распаковывает проверенный `.tar.gz`, выбирает CUDA 13 при драйвере NVIDIA от `580.65`, CUDA 12 для более старого драйвера, а HIP-сборку — по поколению AMD GPU. CUDA/cuBLAS библиотеки идут внутри новых архивов.

Сохранён откатный снимок до обновления в `app/artifacts/strata-update-2026-10-22/backup-before/`: предыдущие бинарники, профили, настройки, исходный diff Aplot и список Python-пакетов. Проверялись контрольные суммы, версия EXE, синтаксис/импорт сервера и сохранность профилей. Генерация модели на новом движке отдельно не запускалась.

Собрана Aplot `0.9.1`: приложение `app/src-tauri/target/release/aplot-control-llm.exe` (SHA-256 `b7bdb1758236a155ab83dac72c2cbceb1da45fa9589fa53964bca7117c29d7fc`) и установщик `app/src-tauri/target/release/bundle/nsis/Aplot Control LLM_0.9.1_x64-setup.exe` (SHA-256 `e0e0ae7ba0c2839181eb6dc76d92867cfa6b46785ab5f444ded694642e4817e8`). Встроенный шаг `installer:ui` автоматически выполнил 26 проверок окна установщика; остальные тестовые наборы не запускались.

## English

The working install moved from Strata source `v0.1.45` to `v0.2.2` (`011c9e600a93bbc9fd451c563501b5831c32bbca`). The engine binary moved from `0.1.45` to `0.1.47`, using the official Windows x86-64 CUDA 13 archive. Its size is 580428476 bytes and its SHA-256 is `59833d875b2f3807791533f5dd077a0cb0ed08d4c1cab3136ad2ceb165871cd1`. The packaged files were also checked against `engine-component.json`.

This machine has an RTX 5080 and NVIDIA driver `595.71`; the CUDA 13 package requires `580.65` or newer. `strata.exe --version` reports `strata 0.1.47`. The Python API server compiles and imports in the existing environment, whose runtime dependencies match the new `requirements.txt` (CMake and Ninja remain as unused extras).

Aplot's API additions were rebased: `ttft_ms`, authenticated `/openapi.json`, and exact `POST /v1/chat/completions/input_tokens`. The default model directory remains `models/strata` in the Aplot workspace. `%APPDATA%\Strata\settings.json` and all six model profiles are byte-for-byte unchanged from their backups. Model weights were not moved or downloaded. Strata's web interface was not changed.

Aplot's component catalog and installer now pin Strata source commit `011c9e600a93bbc9fd451c563501b5831c32bbca` and engine `0.1.47`, with hashes and sizes in `app/src-tauri/installer/components.json`. The installer safely extracts the verified `.tar.gz`, chooses CUDA 13 for NVIDIA drivers `580.65+`, CUDA 12 for older drivers, and the matching HIP package by AMD GPU generation. CUDA/cuBLAS libraries are bundled in the new engine archives.

A rollback snapshot is in `app/artifacts/strata-update-2026-10-22/backup-before/`: old binaries, profiles, settings, the original Aplot source diff and the Python package inventory. Checks covered hashes, EXE version, server syntax/import, and profile preservation. Model generation was not run on the updated engine.

Aplot `0.9.1` was built: application `app/src-tauri/target/release/aplot-control-llm.exe` (SHA-256 `b7bdb1758236a155ab83dac72c2cbceb1da45fa9589fa53964bca7117c29d7fc`) and NSIS installer `app/src-tauri/target/release/bundle/nsis/Aplot Control LLM_0.9.1_x64-setup.exe` (SHA-256 `e0e0ae7ba0c2839181eb6dc76d92867cfa6b46785ab5f444ded694642e4817e8`). The `installer:ui` build hook automatically ran its 26 installer-window checks; the other test suites were not run.
