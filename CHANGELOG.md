# Changelog

## 0.8.2 — 2026-10-05

### Русский

- Базовая раскладка главной страницы адаптируется к ширине окна; сброс возвращает исходный порядок и размеры карточек.
- Включённые карточки инференса видны и после остановки сервера.
- Устаревший ответ опроса больше не возвращает статус готовности после остановки.
- Кнопки остановки ждут подтверждения завершения процесса; при ошибке можно повторить остановку.
- Завершение дерева процессов Windows имеет ограниченное время ожидания.

Проверки: 118 тестов интерфейса, 55 тестов Rust, 2 теста Python-импортера, TypeScript, переводы/IPC и сборка интерфейса. Исправление остановки покрыто отложенными ответами всех четырёх движков и реальным тестом дерева процессов Windows. Полный цикл остановки живой Strata-модели в релизном EXE отдельно не подтверждён.

### English

- The default dashboard layout adapts to window width; resetting restores the original card order and proportions.
- Enabled inference cards remain visible when the server is stopped.
- Stale polling responses no longer restore a ready state after shutdown.
- Stop controls wait for process exit confirmation and allow retry after a failure.
- Windows process-tree shutdown has a bounded timeout.

Validation: 118 frontend tests, 55 Rust tests, 2 Python importer tests, TypeScript, translation/IPC checks and the frontend build. Shutdown coverage includes delayed responses from all four engines and a real Windows process-tree test. A full live Strata shutdown cycle in the release executable was not separately confirmed.
