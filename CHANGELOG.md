# Changelog

## 0.10.12 — 2026-11-07

### Русский

- Добавлены экспериментальный сервер `aplotd` и мобильный PWA-клиент: можно выбрать проект, просматривать историю и продолжать задачи с телефона.
- Состояние задач и сообщения хранятся на сервере и восстанавливаются после переподключения. Мобильный доступ использует отдельный ключ; полный доступ к файлам и командам требует подтверждения владельца.
- Загрузка моделей стала компактнее: завершённые записи можно удалять по одной или очищать всю историю, не затрагивая установленные модели.
- Итоги ходов агента и решения по запросам разрешений отображаются в истории задачи.

### English

- Added the experimental `aplotd` server and mobile PWA client for choosing a project, browsing task history, and continuing tasks from a phone.
- Task state and messages are stored on the server and restored after reconnecting. Mobile access uses a separate key; full file and command access requires owner confirmation.
- Model downloads use a more compact layout. Finished entries can be removed individually or cleared without affecting installed models.
- Agent turn summaries and approval decisions now appear in task history.

## 0.10.11 — 2026-11-05

### Русский

- В настройки агентов добавлена галерея из 16 аватаров со статичными PNG и анимированными WebP. Выбор доступен рядом с загрузкой своего изображения.
- Аватары отображаются в карточках, списках, выборе исполнителя, чате и на карте агентов. Анимация включается при работе и наведении, отключается в профиле и учитывает системное уменьшение движения.
- В профиле появились описание специализации и выбор цвета. Настройки внешности, выполнения, проектов и инструкций сгруппированы отдельно. Специализация доступна оркестратору в каталоге агентов.
- Улучшена загрузка своих изображений с сохранением пропорций и показом ошибок для неподдерживаемых или повреждённых файлов.

### English

- Added a gallery of 16 agent avatars with static PNG and animated WebP versions beside custom image upload.
- Avatars appear in profiles, lists, agent selection, chat, and the agent map. Activity and hover enable animation, with a profile toggle and support for reduced motion.
- Agent profiles now include specialization and color settings, with separate identity, execution, project, and instruction sections. The agent directory exposes specialization to the orchestrator.
- Custom image upload now preserves proportions and reports unsupported or damaged files.

## 0.10.10 — 2026-11-03

### Русский

- Объединены ввод сообщений, очередь и уточнение активного хода Codex. При повторе после тайм-аута используется тот же идентификатор команды.
- Действия инструментов сгруппированы по ходу. Из заголовка задачи можно перейти к ожидающему вопросу или запросу разрешения. Решение и статус доставки сохраняются в истории.
- Карточка итогов показывает подтверждённые результаты, правки и коды выхода команд проверки.

### English

- The agent composer now handles queued messages and directions for an active Codex turn. Retrying after a timeout reuses the same command ID.
- Tool actions are grouped by turn. The task header links to pending questions and approvals. Decisions and delivery status are saved in the conversation history.
- Turn summaries show confirmed outputs, file changes, and check exit codes.

## 0.10.9 — 2026-11-03

### Русский

- Добавлена настройка снижения отказов Qwen3.8-Flash-Next через встроенный control vector Strata. Она меняет параметры запуска, не переписывая веса GGUF.
- Исправлено удаление моделей Strata: приложение учитывает конфигурации и пакеты моделей, а также сохраняет файлы, общие с другими конфигурациями.
- При запуске Strata теперь передаются все проверенные файлы весов и путь к пакету модели.

### English

- Added a Strata control-vector setting to reduce refusals for Qwen3.8-Flash-Next without rewriting GGUF weights.
- Fixed Strata model deletion to account for model configs and packs while preserving files shared with other configurations.
- Strata launch metadata now includes every validated weight file and the model pack path.

## 0.10.8 — 2026-11-03

### Русский

- В чатах появились ветки, редактирование и повторная генерация ответов, закрепление, архив, фильтры и временные диалоги. Историю можно импортировать из JSON и экспортировать в JSON или Markdown.
- Можно задать инструкции для приложения, проекта и чата и отдельно подтвердить сохранение фактов в память проекта.
- Ответы поддерживают ссылки на источники, статусы инструментов, таблицы и графики. Для OpenAI доступны раздельные профили ChatGPT и API-ключа, а веб-поиск можно включать по запросу.
- В задачах Codex доступны уточнения во время выполнения, проверка кода и создание ветки диалога. В рабочей области появились Git-статус, просмотр изменений, версии артефактов и настройки подключений MCP проекта.
- Библиотека проекта хранит версии файлов и поддерживает поиск по содержимому TXT, DOCX и XLSX. Из интерфейса и агентских задач можно создавать и экспортировать DOCX, XLSX и PDF.
- Исправлены пути подготовки моделей Strata в Windows и настройки контекста для Hermes с DeepSeek.

### English

- Chats support branching, editing and regeneration, pinning, archiving, filters, and temporary conversations. History can be imported from JSON and exported to JSON or Markdown.
- Set instructions at the application, project, and chat levels and approve which facts are saved to project memory.
- Replies display citations, tool activity, tables, and charts. OpenAI connections support separate ChatGPT and API key profiles and optional web search.
- Codex tasks support steering, code review, and conversation forks. The workspace includes Git status and diffs, artifact versions, and project MCP connection settings.
- The project library keeps file versions and supports full-text search for TXT, DOCX, and XLSX. Create and export DOCX, XLSX, and PDF from the interface or agent tasks.
- Fixed Strata model preparation paths on Windows and context settings for Hermes with DeepSeek.

## 0.10.7 — 2026-11-02

### Русский

- Новый базовый агент «Оркестратор»: распределяет задачи между специалистами, читает их результаты и предлагает новых агентов. Создание специалиста требует подтверждения пользователя.
- Встроенные инструменты Aplot для Codex, Claude и Hermes: список агентов и проектов, передача поручений, результаты и предложения создать агента. Чаты поручений связаны с исходным чатом.
- Настройки агентов называются «Агенты»; должность видна в карточке, а уровень размышлений можно задать по умолчанию.
- Сочетания клавиш вынесены в отдельную вкладку настроек; исправлены отступы, убраны мелкие пояснения, добавлены плавные переходы между вкладками. Убраны Mica и полоса времени на главной.
- Автоматический масштаб больше не увеличивает интерфейс дополнительно на больших мониторах; ручной увеличенный масштаб сохранён.
- Скачанный проектор Vision распознаётся в библиотеке. Прогресс подготовки моделей Strata оформлен как остальные загрузки.
- Обновление движков Strata показывает этап, процент и объём загрузки. Управляемая установка переходит в соседнюю папку новой версии с сохранением путей и моделей.
- Удалённый компонент llama.cpp больше не обнаруживается автоматически как внешняя установка.

### English

- New built-in Orchestrator agent delegates to specialists, reads their results and proposes new agents. Creating a specialist requires explicit user approval.
- Built-in Aplot tools for Codex, Claude and Hermes list agents and projects, delegate work, read results and propose agents. Delegated chats link back to the original chat.
- Agent settings are named Agents, job titles appear in agent details, and each agent can have a default reasoning level.
- Keyboard shortcuts have their own settings tab; spacing and small captions are cleaned up, and switching settings tabs is animated. Removed Mica and the home timeline.
- Automatic scaling no longer adds extra enlargement on large monitors; manual enlarged scaling remains available.
- Downloaded vision projectors are recognized in the library. Strata model preparation uses the standard download progress layout.
- Strata engine updates show stages, percentages and transferred bytes. Managed installations move to a sibling version folder while retaining paths and models.
- Uninstalled llama.cpp components are no longer automatically rediscovered as external installations.

## 0.10.6 — 2026-10-30

### Русский

- Выбор файлов и папок и «Сохранить как» теперь в окне Aplot вместо системного диалога: места и диски, путь, новая папка, фильтр по типу.
- «Подобрать» — один экран: шаги мастера, ползунки и раскрывающийся блок «Тонкая настройка». Приоритет меняет глубину раздумий и длину ответа. Если подходящей модели нет, предлагается скачать её.
- «Мои модели»: вид списком, загрузки открываются панелью, «Добавить модели» доступна и для Strata.
- Движок DeepSeek для Strata можно установить без модели и потом обновлять.
- Сочетания клавиш настраиваются в настройках и работают в любой раскладке.
- Агенты: аватар и должность, поиск по агентам и проектам. Подсказку «Проектов пока нет» можно закрыть.
- Лимиты Codex и Claude: кнопка «Добавить» и компактное окно аккаунтов. В чате вложения добавляются через «+».
- Боковое меню уже, название «Aplot Control LLM» одной строкой, светлая тема больше не лежит на тёмной подложке, убраны лишние мелкие подписи. «Компоненты» в настройках открываются сразу.

### English

- Choosing files and folders and Save as now use Aplot's own window instead of the system dialog: places and drives, path, new folder, file-type filter.
- Pick is one screen: wizard steps, sliders and a folded Advanced settings block. Priority changes thinking depth and answer length. With no suitable model it offers to download one.
- My models: list view, downloads open as a panel, and Add models works for Strata too.
- The DeepSeek engine for Strata can be installed without a model and updated afterwards.
- Keyboard shortcuts are configurable in Settings and work in any keyboard layout.
- Agents: avatar and job title, search in agents and projects. The "No projects yet" note can be closed.
- Codex and Claude limits: an Add button and a compact accounts window. In chat, attachments are added through "+".
- A narrower sidebar, "Aplot Control LLM" on one line, the light theme no longer sits on a dark backdrop, and stray small captions are gone. Settings → Components opens instantly.

## 0.10.5 — 2026-10-30

### Русский

- Новое боковое меню из пяти пунктов: Главная, Агенты, Чат, Знания, Модели (Ctrl+1…5). Лимиты Codex и Claude свёрнуты в два значка; список аккаунтов открывается по нажатию.
- «Модели» собирают бывшие «Параметры запуска», «Модели и профили», «Производительность», «Логи» и «API и подключения» в три вкладки: «Подобрать», «Мои модели», «Серверы». Старые ссылки и поиск Ctrl+K ведут на нужную вкладку.
- «Подобрать» — мастер из трёх шагов: задача и модель, проверка бенчмарком, «Готово» с оценкой «Стабильно» или «Нужен компромисс» и кнопками запуска, чата и агентов. Технический редактор — вкладка «Тонкая настройка».
- «Серверы» — карточка выбранного сервера: адрес API в одно нажатие, запуск, остановка и перезапуск, вкладки «Обзор», «Подключить», «Логи», «Метрики».
- Лёгкий режим (трей, настройки или мини-окно): основное окно прячется и не нагружает видеокарту, мини-окно становится пультом — все серверы с моделью, скоростью и VRAM, управление, копирование адреса API и запуск сохранённого профиля. Режим сохраняется между запусками.

### English

- A new five-item sidebar: Home, Agents, Chat, Knowledge, Models (Ctrl+1…5). Codex and Claude limits fold into two chips; the account list opens on click.
- Models gathers the former Launch parameters, Models & Profiles, Performance, Logs and API & connections into three tabs: Pick, My models, Servers. Old links and Ctrl+K search lead to the right tab.
- Pick is a three-step wizard: task and model, a benchmark check, and Ready with a Stable or Needs a compromise verdict and buttons for launch, chat and agents. The technical editor is the Advanced settings tab.
- Servers is a card for the selected server: one-click API address, start, stop and restart, and Overview, Connect, Logs and Metrics tabs.
- Light mode (tray, settings or the mini window): the main window hides and stops using the graphics card, and the mini window becomes a control panel with every server's model, speed and VRAM, controls, the API address to copy and a saved profile to launch. The mode is kept between launches.

## 0.10.4 — 2026-10-29

### Русский

- Уровни размышлений теперь у каждой модели свои. Codex сообщает их сам (у GPT-6.1-Sol есть «Максимум» и «Ультра»), локальные модели описывают их в шаблоне чата GGUF, для Claude они берутся из каталога, который обновляется из репозитория.
- «Авто» подписан уровнем модели по умолчанию, например «Авто (низкое)». Модели, которые умеют только включать и выключать размышления, показывают два пункта, а модели без размышлений — ни одного.
- Уровень, которого нет у выбранной модели, не отправляется: вместо него используется «Авто».
- Список уровней хранится в базе приложения и обновляется при загрузке, пересканировании и удалении моделей; шаблон читается только у новых или изменённых файлов.

### English

- Reasoning levels are now per model. Codex reports its own (GPT-6.1-Sol has Max and Ultra), local models describe theirs in the GGUF chat template, and Claude's come from a catalog refreshed from the repository.
- Auto names the model's default, for example "Auto (low)". Models that can only turn thinking on or off show two items, and models without thinking show none.
- A level the selected model lacks is never sent; Auto is used instead.
- The lists live in the app database and follow downloads, rescans and removals; a template is read only for new or changed files.

## 0.10.3 — 2026-10-29

### Русский

- Strata настраивается прямо в «Параметрах движка»: выбор подготовленной конфигурации, изображения (Vision) вкл/выкл и где их читать — на процессоре или видеокарте.
- Контекст до 1M в Strata и в «Под задачу»; после 256K Aplot предупреждает о растяжении YaRN и его последствиях, а Strata получает нужные аргументы сама.
- Проектор изображений (mmproj), общий для всех квантований Strata, теперь находится; если его нет, его можно скачать из карточки модели — он ляжет в папку модели и удалится вместе с ней.
- При загрузке модели проектор Vision предлагается галочкой и включён по умолчанию.
- Для llama.cpp появился параметр «Vision на видеокарте»: выключенный, он оставляет видеопамять модели (`--no-mmproj-offload`).
- Исправлены кнопки карточки модели: значки папки и удаления больше не сжимаются в точку, текст на основной кнопке снова читается.

### English

- Strata is set up right in Engine settings: pick a prepared configuration, turn images (Vision) on or off, and choose whether pictures are read on the CPU or the video card.
- Context up to 1M in Strata and in the task view; past 256K Aplot warns about YaRN stretching and its costs, and Strata gets the matching arguments automatically.
- The image projector (mmproj) Strata shares between quantizations is now found; when it is missing it can be downloaded from the model card into the model's folder and is removed with the model.
- Downloading a model offers its Vision projector as a checkbox, on by default.
- llama.cpp gets a "Vision on GPU" setting; turned off it keeps video memory for the model (`--no-mmproj-offload`).
- Model card buttons are fixed: the folder and delete icons no longer shrink to a dot and the main button's text is readable again.

## 0.10.2 — 2026-10-29

### Русский

- Модели можно удалять из библиотеки: Aplot покажет, какие файлы освободятся и какие профили перестанут запускаться, и не удалит модель, занятую запущенным сервером.
- В карточке модели видно, какие дополнительные файлы ей нужны (проектор изображений, черновая модель) и установлены ли они.
- Ручная настройка Strata: контекст, формат памяти разговора и черновой слой, со списком файлов конфигурации; изменения сохраняются в собственную копию, подготовленная Strata конфигурация не меняется.
- Карточки профилей Strata показывают настоящий контекст из конфигурации; оценка «влезет ли модель» учитывает вердикт Strata и свободную память.
- Проекты агентов по умолчанию создаются в папке `projects` рядом с приложением; Ctrl+Shift+M закрывает и мини-окно; у «Знаний» появился стартовый экран; переключение задач и приоритетов стало плавным.

### English

- Models can be deleted from the library: Aplot shows which files are freed and which profiles stop starting, and never deletes a model a running server uses.
- Model cards show the extra files a model needs (image projector, draft model) and whether they are installed.
- Strata can be tuned by hand: context, conversation memory format and draft layer, with the config's file list; changes go to Aplot's own copy and the config Strata prepared stays unchanged.
- Strata profile cards show the real context from their config; the fit estimate uses Strata's verdict and free memory.
- Agent projects default to a `projects` folder beside the app, Ctrl+Shift+M also closes the mini window, Knowledge has a start screen, and switching tasks and priorities animates smoothly.

## 0.10.1 — 2026-10-29

### Русский

- Окно установщика подстраивается под экран: на больших мониторах крупнее вместе с текстом, на ноутбуках компактнее, на низких экранах содержимое прокручивается.
- Из установщика убраны служебные подписи внизу и кнопка журнала.
- Масштаб интерфейса, сохранённый старыми версиями по умолчанию (110%), один раз переводится на «Авто».

### English

- The installer window fits the screen: larger with its text on big monitors, more compact on laptops, and scrolling on short screens.
- The installer drops its footer captions and the log button.
- The 110% interface scale that older versions stored by default switches to Auto once.

## 0.10.0 — 2026-10-29

### Русский

- Новый раздел «Знания»: подключите папку с заметками (в том числе хранилище Obsidian) и ищите по ней на русском и английском, включая поиск по части слова. Заметки открываются в Aplot или в Obsidian, индекс обновляется при правке файлов. Сами заметки Aplot не изменяет.
- Задачами агентов Codex, Claude и Hermes теперь управляет приложение, а не окно: сообщения, очередь и запросы разрешений хранятся в базе и переживают перезагрузку окна. Существующие задачи переносятся автоматически при первом запуске.

### English

- New Knowledge section: connect a notes folder (including an Obsidian vault) and search it in Russian and English, including by part of a word. Notes open in Aplot or Obsidian, and the index follows file edits. Aplot never changes the notes themselves.
- Codex, Claude and Hermes agent tasks are now owned by the app rather than the window: messages, the queue and permission requests live in the database and survive a window reload. Existing tasks move over automatically on first start.

## 0.9.9 — 2026-10-29

### Русский

- Установщик оформлен в стиле приложения: стеклянные панели, понятные шаги, карточки компонентов с версиями; на первом экране действие и состав установки больше не выглядят двумя выбранными ответами на один вопрос.
- В чате появился голосовой ввод: речь распознаётся локально через Whisper из Hermes и работает с ChatGPT, Claude и локальными моделями.
- В чате и у агентов можно выбрать уровень размышления модели.
- Цвета агентов при создании задачи совпадают с орбитой; неоновое свечение стало мягче; поле поиска в выпадающих списках осталось только для длинных списков.

### English

- The installer matches the app's look: glass panes, clear steps and component cards with versions; on the first screen the action and what to install no longer look like two answers to one question.
- The chat gains voice input: speech is recognised locally with Hermes' Whisper and works with ChatGPT, Claude and local models.
- The chat and agents can choose how hard the model reasons.
- Agent colours in the task starter match the orbit, neon glows are softer, and dropdowns show a search field only for long lists.

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
