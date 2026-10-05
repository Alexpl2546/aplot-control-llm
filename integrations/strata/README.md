# Strata: дополнения Aplot / Aplot additions

Upstream: [Niko1221/Strata](https://github.com/Niko1221/Strata).

Base commit: [`6f32ec070f23ced9f50e704d854d775da52591ab`](https://github.com/Niko1221/Strata/commit/6f32ec070f23ced9f50e704d854d775da52591ab), the local checkout used with Strata 0.1.39.

## Русский

Патч `aplot-api.patch` сохраняет изменения `serve/server.py` и теста сервера из рабочей установки:

- `POST /v1/chat/completions/input_tokens` считает токены с активным шаблоном чата и токенизатором. Это позволяет проводить точные тесты контекста в Aplot.
- `/openapi.json` отдаёт справку API и учитывает авторизацию.
- `ttft_ms` добавлен в живую статистику и завершённые запросы.

Пути к личным моделям, настройки установщика и результаты локальных измерений в патч не входят. Исходная лицензия MIT сохранена в [LICENSE](LICENSE). Изменения в этих двух файлах внесены для интеграции Aplot.

В отдельном клоне Strata:

```powershell
git checkout 6f32ec070f23ced9f50e704d854d775da52591ab
git apply --check <path-to-aplot>/integrations/strata/aplot-api.patch
git apply <path-to-aplot>/integrations/strata/aplot-api.patch
python -m unittest serve.test_server
```

Замените `<path-to-aplot>` на путь к этому репозиторию. Зависимости и установку модели выполните по инструкции Strata. На другой версии сначала проверьте применимость патча: upstream мог изменить или уже добавить эти методы. Не применяйте его повторно к уже изменённой установке.

## English

`aplot-api.patch` preserves the local changes to `serve/server.py` and its test:

- Exact `POST /v1/chat/completions/input_tokens` counting with the active chat template and tokenizer.
- Authenticated `/openapi.json` for the API reference.
- `ttft_ms` in live statistics and completed requests.

The patch excludes personal model paths, installer changes and local benchmark output. The upstream MIT license is preserved in [LICENSE](LICENSE). These two files were modified for the Aplot integration.

Apply the commands above in a separate checkout, replacing `<path-to-aplot>` with this repository's path. Follow Strata's own dependency and model setup instructions. Check applicability before using a different revision; upstream may have changed or added the same endpoints. Do not reapply the patch to an already modified installation.
