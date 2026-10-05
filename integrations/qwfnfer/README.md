# QwFNfer: подсчёт токенов / Token counting

Source: [cakescats/QwFNfer-Secure-Multilang](https://github.com/cakescats/QwFNfer-Secure-Multilang), branch `cakescats-ru`, base revision [`4abe9b76ac7e3eb8febfde7a59c9efeea93da0fa`](https://github.com/cakescats/QwFNfer-Secure-Multilang/commit/4abe9b76ac7e3eb8febfde7a59c9efeea93da0fa).

## Русский

Патч `aplot-token-count.patch` добавляет `POST /v1/chat/completions/input_tokens` в `tools/qwfn_server.cpp`. Он использует тот же шаблон и токенизатор, что генерация, и возвращает 409, когда движок занят. Изменение внесено для точных тестов контекста Aplot; исходный движок и его CUDA-код остаются проектом QwFNfer.

Примените патч к указанной ревизии в отдельном клоне, затем пересоберите `qwfn-server.exe` по инструкции Windows в форке:

```powershell
git checkout 4abe9b76ac7e3eb8febfde7a59c9efeea93da0fa
git apply --check <path-to-aplot>/integrations/qwfnfer/aplot-token-count.patch
git apply <path-to-aplot>/integrations/qwfnfer/aplot-token-count.patch
```

Замените `<path-to-aplot>` на путь к этому репозиторию. Патч сохраняет лицензию Apache-2.0 исходного проекта; текст находится в [LICENSE](LICENSE). Перед применением к другой версии проверьте, не реализован ли уже этот метод.

## English

`aplot-token-count.patch` adds `POST /v1/chat/completions/input_tokens` to `tools/qwfn_server.cpp`. It uses the generation template and tokenizer, and returns 409 while the engine is busy. The change supports Aplot's exact context benchmarks; QwFNfer provides the engine and CUDA code.

Apply the commands above in a separate checkout at the specified revision, replacing `<path-to-aplot>` with this repository's path. Rebuild `qwfn-server.exe` using the fork's Windows build instructions. The patch retains upstream Apache-2.0 licensing; see [LICENSE](LICENSE). Check newer versions before applying it, since upstream may already include the endpoint.
