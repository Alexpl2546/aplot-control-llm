# Лицензии и уведомления сборки

Исходники Aplot Control LLM распространяются по [Apache License 2.0](../LICENSE). [NOTICE](../NOTICE) и [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) содержат уведомления проекта и сведения о сторонних материалах. У движков, зависимостей, весов моделей и графических ресурсов собственные условия.

## Источники уведомлений

| Материалы | Где хранятся сведения |
| --- | --- |
| npm и Cargo | Манифесты, lock-файлы и тексты лицензий установленных пакетов |
| Компоненты установщика | `app/src-tauri/installer/components.json` и `licenses.json` |
| Дополнения Strata | [README](../integrations/strata/README.md) и [исходная лицензия](../integrations/strata/LICENSE) |
| Иконки издателей | [Атрибуция ресурсов](../app/public/creators/ATTRIBUTION.md) |
| Дополненные тексты лицензий пакетов | `app/license-overrides`, вместе с `PROVENANCE.json` |

## Подготовка релиза

Из каталога `app`:

```powershell
npm ci
npm run licenses:generate
npm run tauri:build
```

`tauri:build` сам вызывает подготовку лицензий. Скрипт [generate-licenses.mjs](../app/scripts/generate-licenses.mjs) собирает тексты в `app/artifacts/legal`, сверяет установленные пакеты с lock-файлами и проверяет исходные архивы MPL-зависимостей. Каталог включается в установщики как `legal/`; при ручной упаковке переносимой версии его нужно положить рядом с EXE.

При изменении компонентов проверьте соответствие `components.json`, текстов в `licenses.json` и фактически распространяемых файлов. Сохраняйте исходные LICENSE, NOTICE и сведения об авторских правах в сторонних поставках. Веса моделей не входят в установщик Aplot.

[Сборка для Windows](../app/docs/WINDOWS_BUILD.md) описывает выпуск приложения. Результат компиляции и проверка комплектности уведомлений — разные проверки.
