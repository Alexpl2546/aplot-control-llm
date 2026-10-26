# Aplot Glass Select — внедрение 21 октября 2026

Единая система выбора внедрена в production React/Tauri-приложение. Сохранены значения, обработчики выбора и форматы конфигурации. Backend, параметры движков и поведение работающих серверов в этой задаче не менялись. Левая навигация и расположение основных блоков сохранены.

## Компоненты и архитектура

- `AplotSelect` — компактный контролируемый выбор; общий trigger, portal, popup, option, focus, dismissal и navigation.
- `AplotCombobox` — публичный вариант общей основы с поиском; существующие вызовы `ChoiceSelect variant="model"` используют ту же основу.
- `AplotTaskSelect` — Smart Task: Lucide-иконка, название, локализованное пояснение и checkmark.
- `NativeSelectAdapter` — совместимый экспорт `Select` из `Primitives.tsx`. Скрытый нативный контрол сохраняет настоящие React change events, `event.target.value/name`, FormData, reset и required validation. Пользователь видит только Glass Select.
- `ChoiceSelect` — совместимый реэкспорт общей основы; прежняя самостоятельная реализация удалена.
- `selectOptions.ts` — реальные метаданные моделей и профилей: движок, контекст, квантование, архитектура; поиск также учитывает переданные keywords и группы.

Добавлен `@floating-ui/react` 0.27.20. Floating UI управляет floating positioning, flip/shift/size/hide, клавиатурой, typeahead, focus и click outside. Новых альтернативных UI-фреймворков не вводилось. Dev-зависимости: Playwright, Testing Library, user-event, jsdom.

Панель портируется в body либо ближайший native dialog. Manual Popover поднимает её в top layer WebView2, сохраняя доступность внутри модального окна и исключая clipping прокручиваемыми предками. Неподдерживающий Popover браузер получает обычный portal. Координаты и размеры нормализованы для CSS zoom; нативный Tauri zoom работает через WebView. Выход сохраняет панель в DOM до окончания анимации.

## Визуальная система

| Параметр | Значение |
|---|---|
| Trigger | минимум 40 px, radius 11 px, компактный текст 13 px |
| Popup | radius 15 px, gap 6 px, безопасный отступ от viewport 8 px |
| Строка | минимум 38 px, radius 9 px, пояснение 11 px |
| Высота popup | до 320 px, уменьшается по доступному пространству |
| Glass | opacity панели около 0.93; blur 20 px; saturation 1.18 |
| Dark | графитовая поверхность, тонкая светлая граница, мягкая тень |
| Light | самостоятельная молочная поверхность, серая граница, зелёный акцент |
| Selected | приглушённая лаймовая/зелёная заливка и checkmark |
| Open / close | 190 / 130 ms; opacity + translateY 6 px + scale 0.985 |
| Easing | существующий `--k-ease`: cubic-bezier(.2,.8,.2,1) |
| Hover / arrow | 120 / 180 ms; стрелка вращается на 180° |
| Scrollbar | тонкий, 6 px, округлый ползунок; overscroll containment |

Цвета определены семантическими токенами `--k-select-*`, `--k-dropdown-*` в `tokens.css`. При отсутствии backdrop-filter используется непрозрачная поверхность. При reduced motion анимации отключаются. Старые `.choiceTrigger/.choiceMenu/.choiceOption` и локальные конфликтующие переопределения удалены. Контекстные меню действий сохранили свою семантику, но получили общие поверхности, скругления и hover.

## Экраны и карта использования

Проверены реальные пути `app/src/styles/kontur`, `views`, `components`, `features`. Аудит содержит 57 записей в 26 файлах: 56 мест выбора и прежний базовый Select. Восемь прямых HTML-select заменены, остальные переведены через совместимые общие экспорты. Динамические параметрические контролы создают дополнительные экземпляры на основе одной общей реализации.

Охвачены: главная и выбор сервера; параметры запуска всех движков; Smart Task; модели/профили и фильтр применения; бенчмарки; логи и activity-фильтры; API/подключения; обычный чат; агентная среда, проекты, модели, доступ и передача задач; профили облачных подключений; настроенные агенты; общие настройки и мастер первого запуска.

Полная машинная карта с исходными props/handlers/imports: [inventory.json](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/inventory.json).

| Исходный файл | Записей аудита |
|---|---:|
| `app/src/components/config/CliPreview.tsx` | 1 |
| `app/src/components/config/ConfigEditor.tsx` | 4 |
| `app/src/components/config/InfernixConfiguration.tsx` | 2 |
| `app/src/components/config/OllamaConfiguration.tsx` | 1 |
| `app/src/components/config/QwfnConfiguration.tsx` | 1 |
| `app/src/components/runtime/ServerHeader.tsx` | 2 |
| `app/src/components/setup/SetupWizard.tsx` | 2 |
| `app/src/components/ui/Primitives.tsx` | 1 |
| `app/src/features/activity/ActivityFeed.tsx` | 1 |
| `app/src/features/agent/AgentChat.tsx` | 8 |
| `app/src/features/agent/AgentInputTools.tsx` | 1 |
| `app/src/features/agent/AgentPresets.tsx` | 4 |
| `app/src/features/agent/AgentTransfer.tsx` | 3 |
| `app/src/features/agent/WorkspacePanels.tsx` | 2 |
| `app/src/features/connections/ConnectionPanel.tsx` | 2 |
| `app/src/features/launches/EngineProfileControls.tsx` | 1 |
| `app/src/features/launches/QuickServerDialog.tsx` | 2 |
| `app/src/features/launches/RunSelector.tsx` | 1 |
| `app/src/features/openai/CloudProfileSelect.tsx` | 1 |
| `app/src/features/openai/OpenAiPanel.tsx` | 1 |
| `app/src/features/smartTasks/SmartTaskDesk.tsx` | 2 |
| `app/src/views/ChatView.tsx` | 2 |
| `app/src/views/ConfigurationView.tsx` | 1 |
| `app/src/views/LibraryView.tsx` | 1 |
| `app/src/views/PerformanceView.tsx` | 3 |
| `app/src/views/SettingsView.tsx` | 7 |

## Проверки

- TypeScript: `npm run typecheck` — успешно.
- Vitest: **431 тест, 70 файлов** — успешно; 10 новых проверок Glass Select.
- Playwright: **27 сценариев** — успешно. Реальные экраны приложения, включая 16 комбинаций viewport × theme × language, model finder, Smart Task, нижний composer, CSS zoom/reduced motion, каталог 1000 профилей и аудит доступных списков шести разделов.
- Viewport: **1920×1080, 1440×900, 1280×800, 1100×720** (минимум приложения).
- Проверены mouse selection/reselection, arrows/Home/End/Enter/Escape, focus return, outside press, disabled/loading/invalid/empty, поиск/очистка/метаданные, форма/reset, сохранение профиля при навигации, wheel, восстановление scroll, resize, auto flip, границы popup и отсутствие горизонтального overflow.
- Большой каталог: 1000 реальных строк общего компонента в браузере; отдельная проверка фильтрации 10 000 вариантов.
- `verify:source`: 1723 ключа переводов, 918 статических ссылок t(), 113 frontend invoke-команд, 145 Rust handlers — успешно.
- `verify:docs`: 19 пар RU/EN, 394 локальные ссылки — успешно.
- Release: `npm run tauri:build` — успешно; frontend, native EXE, NSIS installer; **26 installer acceptance checks**. Сформированы лицензии 165 npm- и 341 Cargo-пакета.

Повторить UI-проверки: `cd app` → `npx playwright test --config playwright.glass.config.ts`. Конфигурация запускает либо переиспользует локальный Vite на 127.0.0.1:1420, использует установленный Chrome с отдельным временным профилем. Папка artifacts исключена из Vite watch, чтобы trace/report не перезагружали приложение.

Логи: [Vitest](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/tests.log), [TypeScript](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/typecheck.log), [Playwright](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/playwright.log), [сборка](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/release-build.log).

## Реальное Tauri / WebView2

Проверено отдельное скомпилированное окно Tauri с WebView2 155 и отдельной SQLite-базой `app/artifacts/glass-select/native-data`. Использованы 24 тестовых профиля, загруженных штатным backend. Проверены модальное окно настроек, Smart Task, длинный список профилей, wheel, поиск `64k` по метаданным (12 результатов), переключение dark/light, нативный масштаб 100% → 140% и Escape. Данные пользователя и облачные аккаунты не использовались, серверы не запускались.

Снимки показывают настоящий интерфейс Tauri, а не макет или отдельный showcase. Названия «Тестовый профиль» — содержимое отдельной QA-базы.

### Compact Select

Настройки в настоящем WebView2, нативный масштаб интерфейса 140%.

![Compact Select](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/screenshots/compact-webview2.jpg)

### Model Finder

![Model Finder](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/screenshots/model-webview2.jpg)

### Task Select

![Task Select](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/screenshots/task-webview2.jpg)

### Light Theme

![Light Theme](C:/Dev/Aplot-Control-LLM/project/app/artifacts/glass-select/screenshots/light-webview2.jpg)

## Исключения и границы проверки

- Единственный оставшийся HTML-select находится внутри NativeSelectAdapter: он невидим, исключён из accessibility tree и tab order и нужен для совместимости обработчиков/form semantics. Видимых Windows-native списков в React-приложении не осталось.
- Нативные системные диалоги выбора файла, меню Windows/tray и отдельный C#-установщик не являются React Select/Combobox и не заменялись этой системой.
- Контекстные action menus не преобразованы в listbox: действия сохранили исходное управление и позиционирование, унифицирован только их визуальный слой.
- Физический Windows Precision Touchpad и переключение системного DPI на всех уровнях не имитировались. Проверены wheel events, нативная прокрутка WebView2, responsive viewport и масштаб интерфейса. Проверка native выполнялась на текущем дисплее Windows с device scale factor 1.5.
- Fallback без backdrop-filter предусмотрен CSS; старый WebView2 без Popover отдельно не запускался. На текущем WebView2 проверен top layer внутри native dialog.
- В существующих зависимостях npm audit сообщает moderate advisory Vite 8.3.2 (dev server launch-editor). Версия Vite не менялась; это не новая runtime-зависимость Glass Select. Native build также сохраняет существующие предупреждения Rust о неиспользуемых элементах. Сборку и проверки они не блокируют.

## Изменённые файлы

Список относится именно к Glass Select, относительно сохранённого состояния перед началом задачи; в рабочем дереве уже были другие изменения.

- `app/e2e/glass-select.e2e.ts`
- `app/package-lock.json`
- `app/package.json`
- `app/playwright.glass.config.ts`
- `app/src/components/config/CliPreview.tsx`
- `app/src/components/config/ConfigEditor.tsx`
- `app/src/components/config/OllamaConfiguration.tsx`
- `app/src/components/runtime/ServerHeader.tsx`
- `app/src/components/setup/SetupWizard.tsx`
- `app/src/components/ui/AplotSelect.css`
- `app/src/components/ui/AplotSelect.tsx`
- `app/src/components/ui/ChoiceSelect.tsx`
- `app/src/components/ui/NativeSelectAdapter.tsx`
- `app/src/components/ui/Primitives.tsx`
- `app/src/components/ui/selectOptions.ts`
- `app/src/features/agent/AgentChat.tsx`
- `app/src/features/agent/AgentPresets.tsx`
- `app/src/features/connections/ConnectionPanel.tsx`
- `app/src/features/launches/EngineProfileControls.tsx`
- `app/src/features/launches/QuickServerDialog.tsx`
- `app/src/features/openai/CloudProfileSelect.tsx`
- `app/src/features/smartTasks/SmartTaskDesk.tsx`
- `app/src/locales/en/kontur.json`
- `app/src/locales/en/smartTasks.json`
- `app/src/locales/ru/kontur.json`
- `app/src/locales/ru/smartTasks.json`
- `app/src/styles/kontur/agent-composer.css`
- `app/src/styles/kontur/agent-workspace.css`
- `app/src/styles/kontur/components.css`
- `app/src/styles/kontur/tokens.css`
- `app/src/views/ChatView.tsx`
- `app/src/views/ConfigurationView.tsx`
- `app/src/views/LibraryView.tsx`
- `app/src/views/PerformanceView.tsx`
- `app/src/views/SettingsView.tsx`
- `app/tests/glassSelect.test.tsx`
- `app/vite.config.ts`

Дополнительно: этот отчёт, audit/QA-артефакты, обновлённый лицензионный комплект и каталог выпуска [glass-select-2026-10-21](C:/Dev/Aplot-Control-LLM/history/releases/glass-select-2026-10-21).
