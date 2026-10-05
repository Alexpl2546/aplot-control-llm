# Contributing / Участие

## Русский

Для небольшого исправления достаточно pull request. Большую функцию лучше сначала обсудить в issue: у четырёх движков разные параметры и API, поэтому общее поведение нужно согласовать.

1. Создайте ветку от `main`, например `fix/server-status`.
2. Установите зависимости через `npm ci` в `app`.
3. Внесите изменение и добавьте проверку, если меняется поведение. Новые строки интерфейса добавляйте в оба файла переводов.
4. Выполните проверки из README. Изменения запуска сервера дополнительно проверьте в настольном приложении с подходящим движком.
5. В pull request опишите проблему, результат и проверки. Не включайте модели, базы, ключи и локальные отчёты. Просмотрите `git diff --staged` перед коммитом.

Сообщения коммитов должны описывать изменение: `fix: discard stale server status` или `docs: clarify Strata setup`. Сохраняйте lock-файлы при изменении зависимостей. Вклад публикуется на условиях Apache-2.0; чужие материалы должны сохранять свои лицензии.

## English

Small fixes can go straight to a pull request. Discuss larger features in an issue first: the four engines have different settings and APIs, so shared behavior needs agreement.

1. Create a branch from `main`, such as `fix/server-status`.
2. Run `npm ci` in `app`.
3. Make the change and add a meaningful check if behavior changes. Add new UI text to both translation files.
4. Run the README checks. Verify server lifecycle changes in the desktop app with a suitable engine.
5. Describe the problem, resulting behavior and validation in the PR. Exclude models, databases, keys and local reports. Review `git diff --staged` before committing.

Use short commit messages, such as `fix: discard stale server status` or `docs: clarify Strata setup`. Keep lockfiles up to date when dependencies change. Contributions are submitted under Apache-2.0; third-party materials must retain their own licenses.
