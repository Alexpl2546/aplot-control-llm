import type { TFunction } from "i18next";
import frontend from "./agents/frontend.md?raw";
import backend from "./agents/backend.md?raw";
import tester from "./agents/tester.md?raw";
import designer from "./agents/designer.md?raw";
import reviewer from "./agents/reviewer.md?raw";
import devops from "./agents/devops.md?raw";
import writer from "./agents/writer.md?raw";
import architect from "./agents/architect.md?raw";
import analyst from "./agents/analyst.md?raw";
import security from "./agents/security.md?raw";
import type { AccessMode } from "../ioModel";
import type { AgentPreset } from "../workspaceModel";
import { useWorkspaceStore } from "../workspace";
import { useControlStore } from "../../../store/control";
import i18n from "../../../lib/i18n";

export interface BuiltinAgent {
  id: string;
  runtime: AgentPreset["runtime"];
  access: AccessMode;
  color: string;
  /** AGENT.md body without the front matter: the agent's standing instructions. */
  instructions: string;
}

/** Splits a small `---` front matter block (key: value lines) from the markdown body. */
export function parseAgentMarkdown(source: string): BuiltinAgent {
  const match = source.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  const runtime = (["hermes", "codex", "claude"] as const).find(value => value === meta.runtime) ?? "hermes";
  const access = (["restricted", "manual", "full"] as const).find(value => value === meta.access) ?? "manual";
  return { id: meta.id ?? "agent", runtime, access, color: meta.color ?? "#c8f27c", instructions: (match?.[2] ?? source).trim() };
}

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [frontend, backend, tester, designer, reviewer, devops, writer, architect, analyst, security].map(parseAgentMarkdown);
export const templateById = (id?: string) => BUILTIN_AGENTS.find(agent => agent.id === id);

/** A ready-made template turned into a regular, editable and deletable agent. */
export function presetFromTemplate(agent: BuiltinAgent, t: TFunction): AgentPreset {
  return {
    id: crypto.randomUUID(),
    name: t(`builtin.${agent.id}.name`).slice(0, 20),
    runtime: agent.runtime,
    accessMode: agent.access,
    instructions: agent.instructions.slice(0, 16000),
    templateId: agent.id,
    color: agent.color,
  };
}

/**
 * First run: every template is added once as a normal agent. The flag lives in the workspace file,
 * so agents the person deletes never come back; templates stay available when adding a new agent.
 * Waits for settings so names are created in the person's language.
 */
export function startTemplateSeeding() {
  const attempt = () => {
    const ws = useWorkspaceStore.getState();
    if (!ws.ready || ws.templatesSeeded || !useControlStore.getState().initialized) return false;
    const taken = new Set(ws.presets.flatMap(preset => [preset.templateId ?? "", preset.name.trim().toLocaleLowerCase()]));
    const fresh = BUILTIN_AGENTS.map(agent => presetFromTemplate(agent, i18n.t.bind(i18n) as TFunction))
      .filter(preset => !taken.has(preset.templateId!) && !taken.has(preset.name.trim().toLocaleLowerCase()));
    useWorkspaceStore.setState(state => ({ presets: [...state.presets, ...fresh], templatesSeeded: true }));
    return true;
  };
  if (attempt()) return () => undefined;
  const offWorkspace = useWorkspaceStore.subscribe(() => { if (attempt()) stop(); });
  const offControl = useControlStore.subscribe(() => { if (attempt()) stop(); });
  const stop = () => { offWorkspace(); offControl(); };
  return stop;
}
