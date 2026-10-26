# Strata update — 2026-10-26

## Русский

В upstream вышел Strata `v0.2.6` (25 октября). Для Qwen в этом релизе используется engine `0.1.50`; `0.1.51` относится к Control и DeepSeek engine, поэтому для Aplot выбран Qwen engine `0.1.50`.

До обновления активный компонент в `components/installations.json` был `0.1.47`, а каталог установщика Aplot закреплял `0.1.48` и исходники `v0.2.3.1`. Каталог теперь закрепляет исходники Strata `v0.2.6`, commit `4b9e05a2a806a3fe24f7b2560d98626c37dade35`, и engine `0.1.50` для Windows CUDA 12/13 и поддерживаемых AMD поколений. Хеши архивов сверены с метаданными официального релиза; SHA-256 исходного архива дополнительно вычислен после скачивания.

Aplot API-патч перенесён на структуру исходников `v0.2.6` и применён к чистому архиву до установки. Установщик завершил установку в `components/strata/0.1.50`, проверил SHA-256 архивов, запуск `strata.exe --help` и импорт `serve.server`. `strata.exe --version` возвращает `strata 0.1.50`; `components/installations.json` указывает на новую папку. В тот момент Strata-сервер не был запущен.

Пакеты: исходники — 33 381 429 байт, SHA-256 `6e86bf485ff73700417ba63ff86133f4df7efd3a35f42994ed51eb2c89b4a854`; Windows CUDA 13 engine — 581 368 579 байт, SHA-256 `a9643e2f5dd5c62e734d2980484c320d41da0160fc4932bf638b7f34e38e74f5`. В Aplot-каталоге также обновлены официальные Windows CUDA 12 и HIP-пакеты.

Папки компонентов `0.1.47` и `0.1.48` сохранены для отката. Модели и профили не перемещались; скачивание весов и генерация не выполнялись. Отдельная рабочая копия upstream в `engines/strata` с локальными изменениями осталась нетронутой. Полный бенчмарк и генерация на модели не запускались.

## English

Upstream released Strata `v0.2.6` on October 25. Its Qwen engine is `0.1.50`; `0.1.51` is for Control and the DeepSeek engine, so Aplot now uses the Qwen `0.1.50` package.

Before the update, `components/installations.json` selected `0.1.47`, while Aplot's installer catalog pinned `0.1.48` and source `v0.2.3.1`. The catalog now pins Strata source `v0.2.6`, commit `4b9e05a2a806a3fe24f7b2560d98626c37dade35`, and engine `0.1.50` for Windows CUDA 12/13 and supported AMD generations. Package hashes match the official release metadata; the source archive SHA-256 was also computed after download.

The Aplot API patch was rebased to the `v0.2.6` source layout and applied to a clean source archive before installation. The installer completed in `components/strata/0.1.50`, verified the archives, checked `strata.exe --help`, and imported `serve.server`. `strata.exe --version` reports `strata 0.1.50`; `components/installations.json` now selects the new directory. No Strata server was running at the time of the check.

Artifacts: source archive, 33,381,429 bytes, SHA-256 `6e86bf485ff73700417ba63ff86133f4df7efd3a35f42994ed51eb2c89b4a854`; Windows CUDA 13 engine, 581,368,579 bytes, SHA-256 `a9643e2f5dd5c62e734d2980484c320d41da0160fc4932bf638b7f34e38e74f5`. The catalog also pins the official Windows CUDA 12 and HIP packages.

Component folders `0.1.47` and `0.1.48` remain available for rollback. Models and profiles were not moved; no model weights were downloaded and no generation was run. The separate upstream working copy in `engines/strata`, which contains local changes, was left untouched. No full benchmark or model generation was run.
