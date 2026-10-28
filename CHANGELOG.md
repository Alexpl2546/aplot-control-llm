# Changelog

## 0.9.8 — 2026-10-28

### Русский

- Strata получила режим «Общий адрес»: все модели Strata доступны на одном порту, при запросе другой модели текущая выгружается, а нужная загружается.
- Во вкладке «Движки и модели» видны версии движков Qwen и DeepSeek, их папки и доступные обновления; у llama.cpp и Strata теперь разные порты по умолчанию (8080 и 8090).
- Вкладка «Компоненты» открывается сразу и помечает старые версии, оставшиеся после обновления, с кнопкой их удаления.

### English

- Strata gets a Shared address mode: every Strata model is reachable on one port; asking for another model unloads the current one and loads the requested one.
- Engines and models shows the Qwen and DeepSeek engine versions, their folders and available updates; llama.cpp and Strata now default to separate ports (8080 and 8090).
- The Components tab opens at once and marks versions left behind by an update, with a button to remove them.

## 0.9.7 — 2026-10-28

### Русский

- Компоненты (llama.cpp, Strata, Hermes, Codex CLI, Claude Code) устанавливаются и обновляются прямо в «Настройки → Компоненты», с прогрессом загрузки.
- Переработаны вкладки «Компоненты», «Подписки и подключения» и «Движки и модели»: меньше текста, иконки, понятные статусы; аккаунты добавляются выбором ChatGPT или Claude, программы агентов ставятся одной кнопкой.
- Новый вид окна: без системной рамки, с эффектом Mica, орбитой агентов на главной, палитрой команд и мини-окном.

### English

- Components (llama.cpp, Strata, Hermes, Codex CLI, Claude Code) install and update from Settings → Components with download progress.
- Reworked the Components, Subscriptions and connections, and Engines and models tabs: less text, icons and clear statuses; add accounts by picking ChatGPT or Claude, and install agent programs with one click.
- New window look: frameless with Mica, an agent orbit home, a command palette and a mini window.

## 0.9.5 — 2026-10-26

### Русский

- Исправлено определение библиотеки моделей в установленной версии приложения с движками в папке `components`.

### English

- Fixed model library detection for installed applications that store engines under `components`.

## 0.9.4 — 2026-10-26

### Русский

- Исправлена установка Strata в папку приложения, путь к которой содержит пробелы: проверка подписанного движка запускается из временного Python-файла.

### English

- Fixed Strata installation when the application directory contains spaces by running signed-engine verification from a temporary Python file.

## 0.9.3 — 2026-10-26

### Русский

- Установщик может подготовить управляемые копии уже найденных компонентов в папке приложения, чтобы обновления и обслуживание использовали единые пути.
- Существующие установки компонентов сохраняются; установщик повторно размещает компонент по проверенному каталогу и записывает прежний путь как совместимый псевдоним.

### English

- The installer can provision managed copies of detected components under the application directory so updates and maintenance use consistent paths.
- Existing component installations are preserved; the installer installs from the verified catalog and records the previous path as a compatibility alias.

## 0.9.1 — 2026-10-26

### Русский

- Настроенные агенты оформлены как сотрудники: они остаются в меню и на карте даже без активной задачи.
- Добавлены закрепление одного агента за несколькими проектами и временное привлечение к выбранной задаче.
- Правый клик по агенту открывает меню настройки, назначений и удаления.
- Старые именованные задачи при первом запуске восстанавливаются в список сотрудников, когда настроенных агентов ещё нет.
- В приложении и установщике доступны локальные движки llama.cpp и Strata; неподдерживаемые старые профили сохраняются для экспорта и не запускаются автоматически.
- Qwen и DeepSeek обновляются независимо по подписанным каталогам Strata, без обновления оболочки приложения.
- Добавлен менеджер загрузок GGUF с Hugging Face: выбор полного набора split-файлов и необязательного `mmproj`, очередь загрузок, пауза, возобновление, отмена и проверенная публикация файлов.
- Загрузка GGUF не отмечает Strata готовой: для запуска нужна подготовленная конфигурация и связанные с ней файлы.

### English

- Configured agents are treated as workspace employees and remain in the sidebar and map without active tasks.
- Added multi-project assignments and temporary task recruitment.
- Right-clicking an agent opens configuration, assignment and deletion actions.
- On first launch, legacy named tasks are restored to the employee directory when no agents are configured.
- llama.cpp and Strata are the local engines offered by the app and installer; unsupported legacy profiles remain exportable and never start automatically.
- Qwen and DeepSeek update independently through Strata's signed feeds without updating the application shell.
- Added a Hugging Face GGUF download manager with complete split selection, optional `mmproj`, a download queue, pause, resume, cancellation and verified file publication.
- Downloading a GGUF does not mark Strata ready; launching still requires a prepared configuration and its companion files.


## 0.9.0 — 2026-10-21

### Русский

- Боковая панель сохраняет раскрытое состояние, когда она закреплена.
- На главной странице восстановлена карта сети агентов.
- В разделе Codex показывается имя профиля, а при пустом имени — почта; имя профиля можно оставить пустым.
- В боковом меню отображаются созданные задачи агентов со статусами «работает», «ожидает подтверждения», «простой» и «отключён».

### English

- The sidebar stays expanded while pinned open.
- Restored the agent network map on the home page.
- The Codex section shows a profile name, or the email when the name is blank; profile names can be left empty.
- Created agent tasks appear in the sidebar with working, approval waiting, idle and offline states.


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
