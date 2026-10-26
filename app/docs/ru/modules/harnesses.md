<a id="adapter-registry"></a>
# Адаптеры harness

## Область действия

`features/connections/harnesses.ts` содержит registry schema version 1 и четыре pure config preview: Hermes Agent, DeepSeek Harness, Pi coding agent и OpenClaw. Вызов preview не находит установку, не открывает конфиг и не применяет запись. Для всех adapters `applyEnabled=false`, `smokeTested=false`.

«DeepSeek Harness» здесь означает официальный open-source проект DeepSeek Harness (`deepseek-ai/deepseek-harness`), а не общий термин «harness для модели DeepSeek». «Pi» означает Pi coding agent из официального `pi.dev`, а не другие продукты с названием Pi.

| Adapter ID | Документированный путь/формат | Preview |
| --- | --- | --- |
| `hermes` | `~/.hermes/config.yaml`, custom OpenAI-compatible endpoint | YAML snippet `model.default`, `provider`, `base_url`, `context_length`; `key_env` только при настроенном ключе |
| `deepseek-harness` | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, `llm-pi-ai` provider map | YAML fragment c `api: openai-completions`, `baseURL`, model ID/context и optional `apiKeyEnv` |
| `pi` | `~/.pi/agent/models.json`, `providers` | JSON provider с `baseUrl`, `api`, моделью и optional env-interpolated `apiKey` |
| `openclaw` | OpenClaw config или agent `models.json`, `models.providers` | JSON-compatible fragment с `baseUrl`, `api`, model ID, `contextWindow` и `contextTokens` |

Текущая версия схемы фиксирует редакцию official docs, изученную 11 октября 2026 года; version ID не означает pin версии установленного приложения. Версии, install path, сети и CLI команды пользователя не обнаруживаются.

## Official sources

- [Hermes Agent — provider setup](https://hermes-agent.nousresearch.com/docs/integrations/providers/): custom endpoint, `config.yaml`, `context_length`, `key_env`.
- [DeepSeek Harness — configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers): custom model API и `cordis.patch.yml`; ключ хранится как credential reference.
- [Pi — choose a model](https://pi.dev/docs/latest/models) и [custom providers](https://pi.dev/docs/latest/custom-provider): `models.json`, `openai-completions`, environment interpolation.
- [OpenClaw — custom providers](https://docs.openclaw.ai/concepts/model-providers/custom-providers): provider map, `openai-completions` и model metadata.

## Слияние JSON preview

Pi и OpenClaw позволяют pure structural merge для JSON object:

1. Добавляется только provider ID `aplot-local` по документированному пути.
2. Неизвестные root fields, соседние providers и их настройки копируются в preview без изменений.
3. Повторный preview одинакового provider id/value идемпотентен.
4. Если тот же provider ID уже содержит другое значение или path не object, выдаётся `conflict`; перезапись запрещена.
5. Undo preview удаляет только точный provider, добавленный планом. Если provider был изменён после preview, undo отказывает и сохраняет изменение.

Эти helper работают со структурой, переданной вызывающим кодом, и не читают/пишут config file. Они принимают strict JSON object, не парсят JSON5 комментарии или YAML. В UI результат очищает ключевые поля от показа; это review-only preview, а не готовый файл для применения.

Hermes и DeepSeek Harness получают snippet без structural merge. Для их YAML требуется ручное слияние с учётом existing `model` или `llm-pi-ai.config`, включая неизвестные поля и comments. Схема имён полей сверена с official docs, но runtime parser установленного релиза не запускался.

## Авторизация и фактический статус

Секрет из target не вставляется в snippets. При наличии ключа шаблоны ссылаются на `APLOT_API_KEY`; настройка переменной в harness остаётся явным действием пользователя. При keyless target поле auth опущено.

Никакие внешние harness не устанавливались и не изменялись. Preview показывает только manual snippet/config merge plan. Harness-side проверка модели, streaming, tool calling и context pending. Не следует называть эти adapters автоматическими, applied или verified integrations.

## Тесты и добавление adapter

`harnessTemplates.test.ts` проверяет все четыре snippets, исключение ключа, сохранение unknown JSON полей, idempotency, provider collision и undo с конкурентным edit. Новый adapter добавляется только после проверки official schema: записать `schemaId`, ссылку и config location; по умолчанию сохранить `applyEnabled=false`, `smokeTested=false`; обеспечить no-secret template; добавить merge/undo tests для реально поддерживаемого формата.
