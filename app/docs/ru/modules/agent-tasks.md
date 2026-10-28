# Задачи агентов на хосте

`src-tauri/src/tasks/` владеет сессиями задач агентов в процессе приложения, а не в окне. Перенесён Codex; Claude и Hermes пока работают через окно.

## Данные

Миграция 3 добавляет `agent_tasks`, `agent_messages`, `agent_turns`, `agent_commands`, `agent_approvals`, `agent_task_imports` и журнал `task_events(seq, task_id, kind, revision, at, payload)`. Старая таблица `events` не связана. При первом запуске снимок рабочего пространства импортируется по runtime с сохранением ID; `agent_tasks_rollback` записывает историю хоста обратно в снимок.

## Команды

`agent_tasks_snapshot` возвращает задачи и cursor; `agent_tasks_subscribe` повторяет события после cursor через channel и дальше передаёт новые. `agent_task_send` принимает клиентский `commandId`; повтор возвращает первый результат. В сессии выполняется один ход, остальные ждут в `agent_turns`. Подтверждения переходят `pending` → `approved`/`denied`/`expired`/`stale` и привязаны к поколению worker.
