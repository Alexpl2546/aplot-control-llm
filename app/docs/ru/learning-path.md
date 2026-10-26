<a id="reading-order"></a>
# Маршрут изучения кода

## Рекомендуемый порядок

1. Прочитайте [App.tsx](../../src/App.tsx): как собираются оболочка, навигация и инициализация.
2. Проследите состояние в [control.ts](../../src/store/control.ts): settings, profiles, lifecycle и runtime polling.
3. Откройте [types/app.ts](../../src/types/app.ts), [types/config.ts](../../src/types/config.ts) и [types/runtime.ts](../../src/types/runtime.ts), чтобы связать данные UI и runtime.
4. Найдите native handler в [lib.rs](../../src-tauri/src/lib.rs), затем проследите `api_docs.rs` и соответствующий engine adapter.
5. Для подключений начните с [ApiDocsView.tsx](../../src/views/ApiDocsView.tsx), затем прочитайте [ConnectionPanel.tsx](../../src/features/connections/ConnectionPanel.tsx) и [services/connections.ts](../../src/services/connections.ts).
6. Изучите [harnesses.ts](../../src/features/connections/harnesses.ts), затем тесты преобразований и конфликтов.

## Вопросы при чтении

- Где находится source of truth и берётся ли значение из active run или изменяемого черновика?
- Доказано ли состояние endpoint ответом либо оно только настроено?
- Отменяется ли сеть при смене run, закрытии панели и тайм-ауте?
- Может ли диагностическое сообщение содержать ключ или тело пользовательского ответа?
- Является ли схема harness официально документированной и тестировалась ли установленная версия?

## Проверки

`npm test -- tests/connections.test.ts tests/harnessTemplates.test.ts` запускает относящиеся Vitest cases из `app/`. `node scripts/verify-docs.mjs` из `app/` проверяет RU/EN структуру и локальные ссылки. `npm run verify:source` дополнительно запускает проверку frontend source. Каждый результат относится только к фактическому запуску команды на текущем checkout.
