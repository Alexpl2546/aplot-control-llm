import type { AgentNetworkSnapshot, NetworkAgent, NetworkStatus, NetworkTask } from "../features/agent-network/model";
import type { AgentProject, AgentTask } from "../features/agent/workspaceModel";

/** Browser demo only: a believable agent constellation so the Orbit map can be reviewed without Tauri. */
export function demoAgentNetwork(): AgentNetworkSnapshot {
  const now = Date.now();
  const projects: AgentProject[] = [
    { id: "p-aplot", name: "Aplot Control", path: "C:\\Dev\\Aplot-Control-LLM\\project", skills: "", createdAt: now },
    { id: "p-strata", name: "Strata engine", path: "C:\\Dev\\strata", skills: "", createdAt: now },
    { id: "p-docs", name: "Документация", path: "C:\\Dev\\docs", skills: "", createdAt: now },
    { id: "p-research", name: "Исследования моделей", path: "C:\\Dev\\research", skills: "", createdAt: now },
  ];
  const spec: [string, string, NetworkStatus, string[]][] = [
    ["p-aplot", "Переработка интерфейса", "running", ["a-hermes", "a-claude"]],
    ["p-aplot", "Карта агентов", "running", ["a-claude"]],
    ["p-aplot", "Тесты загрузок", "completed", ["a-codex"]],
    ["p-aplot", "Ревью Rust-команд", "waiting", ["a-codex", "a-review"]],
    ["p-strata", "Профиль 500K контекста", "running", ["a-tuner"]],
    ["p-strata", "Бенчмарк IQ3_S", "blocked", ["a-tuner", "a-bench"]],
    ["p-strata", "Сборка CUDA", "completed", ["a-bench"]],
    ["p-docs", "Руководство пользователя", "ready", ["a-writer"]],
    ["p-docs", "Перевод на 10 языков", "running", ["a-writer", "a-translator"]],
    ["p-research", "Сравнение квантований", "waiting", ["a-research"]],
    ["p-research", "Обзор новых моделей", "completed", ["a-research"]],
  ];
  const meta: Record<string, Pick<NetworkAgent, "name" | "runtime" | "kind">> = {
    "a-hermes": { name: "Hermes · дизайн", runtime: "hermes", kind: "primary" },
    "a-claude": { name: "Claude · фронтенд", runtime: "claude", kind: "primary" },
    "a-codex": { name: "Codex · тесты", runtime: "codex", kind: "primary" },
    "a-review": { name: "Ревьюер", runtime: "hermes", kind: "child" },
    "a-tuner": { name: "Тюнер Strata", runtime: "hermes", kind: "primary" },
    "a-bench": { name: "Бенчмарк", runtime: "codex", kind: "primary" },
    "a-writer": { name: "Редактор", runtime: "claude", kind: "primary" },
    "a-translator": { name: "Переводчик", runtime: "hermes", kind: "child" },
    "a-research": { name: "Аналитик", runtime: "codex", kind: "primary" },
  };
  const tasks: NetworkTask[] = spec.map(([projectId, title, status, participants], index) => {
    const task: AgentTask = { id: `t-${index}`, projectId, title, createdAt: now - index * 3.6e6, updatedAt: now - index * 1.2e6, archived: false, unread: false };
    return { task, project: projects.find(project => project.id === projectId)!, status, participants, events: [] };
  });
  const rank: Record<NetworkStatus, number> = { blocked: 6, waiting: 5, running: 4, ready: 3, stopped: 2, inactive: 1.5, completed: 1 };
  const agents = Object.entries(meta).map(([id, info]) => {
    const own = tasks.filter(row => row.participants.includes(id));
    const status = own.reduce<NetworkStatus>((best, row) => rank[row.status] > rank[best] ? row.status : best, "completed");
    return { id, ...info, status, taskIds: own.map(row => row.task.id), projectIds: [...new Set(own.map(row => row.project.id))] };
  });
  const links = tasks.filter(row => row.participants.length > 1).map(row => ({ id: row.participants.join("::"), agentIds: [row.participants[0]!, row.participants[1]!] as [string, string], taskIds: [row.task.id] }));
  return {
    projects: projects.map(project => ({ project, taskIds: tasks.filter(row => row.project.id === project.id).map(row => row.task.id), agentIds: agents.filter(agent => agent.projectIds.includes(project.id)).map(agent => agent.id) })),
    tasks, agents, links,
  };
}
