# Changelog

## Первый Windows-релиз / First Windows release — 2026-10-05

- Установщики и переносимый ZIP включают каталог `legal`: тексты лицензий, уведомления зависимостей и неизменённые исходники MPL-компонентов. Комплект генерируется из закреплённых версий; исходные архивы проверяются по SHA-256 из `Cargo.lock`.
- Аватары PrismML и Ornith AI заменены оригинальными нейтральными символами P и O.
- Windows installers and the portable ZIP include dependency licenses, notices and unmodified MPL sources in `legal`, generated from locked versions with source archive checksum verification.
- Replaced PrismML and Ornith AI publisher avatars with original neutral P and O symbols.

## Подготовка репозитория / Repository preparation — 2026-10-05

Тесты импорта моделей теперь используют отдельную временную папку приложения и не зависят от локально установленных движков. Добавлена проверка запрета копирования или переноса папки, содержащей само приложение. Набор Rust вырос до 56 тестов; правила настоящего импорта сохранены.

Model-import tests now use a temporary application directory instead of relying on locally installed engines. Added coverage rejecting copy or move of a folder containing the application itself. The Rust suite now contains 56 tests; production import guards are preserved.

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
