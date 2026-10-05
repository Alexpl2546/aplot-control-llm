# Security / Безопасность

## Русский

Для сообщения об уязвимости используйте [приватный отчёт GitHub](https://github.com/Alexpl2546/aplot-control-llm/security/advisories/new). Не публикуйте рабочие API-ключи, базы профилей и инструкции эксплуатации уязвимости в открытом issue.

Укажите версию приложения и движка, условия воспроизведения, ожидаемое и фактическое поведение. Удалите из журналов ключи и личные пути.

Исправления ориентированы на текущую версию в `main`; отдельная поддержка старых версий пока не заявлена. По умолчанию используйте `127.0.0.1`. Если открываете сервер в локальную сеть, настройте авторизацию и сетевой доступ в самом движке. Экспортированные профили и SQLite могут содержать ключи; храните их как настройки с секретами.

## English

Use [GitHub private vulnerability reporting](https://github.com/Alexpl2546/aplot-control-llm/security/advisories/new). Do not post live API keys, profile databases or exploit instructions in public issues.

Include the app and engine versions, reproduction conditions, and expected and actual behavior. Remove keys and personal paths from logs.

Fixes target the current version on `main`; older versions do not have a separate maintenance commitment. Use `127.0.0.1` by default. If you expose a server to the LAN, configure engine authentication and network access. Profile exports and SQLite may contain keys; treat them as settings containing secrets.

## Dependency review — 2026-10-05

GitHub reports [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) for `glib 0.18.5` in `Cargo.lock`. It is a transitive dependency of Tauri's Linux/GTK stack. The current Windows target does not include `glib`; this was checked with:

```powershell
cargo tree --locked --manifest-path app/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -i glib
cargo tree --locked --manifest-path app/src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu -i glib
```

The Windows query has no matching dependency; the Linux query shows the GTK dependency chain. The advisory remains open. Reassess the dependency before adding Linux desktop support; replacing this transitive binding requires a compatible upstream GTK-stack change.

В `Cargo.lock` есть предупреждение для `glib 0.18.5`, используемого Linux/GTK-зависимостями Tauri. В дерево зависимостей сборки Windows этот пакет не входит. Предупреждение оставлено открытым; его нужно повторно проверить перед поддержкой настольной версии Linux. Аудит npm на дату проверки не обнаружил уязвимостей.
