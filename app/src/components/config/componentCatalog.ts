import { Archive, Boxes, Cpu, Layers, Package, type LucideIcon } from "lucide-react";
import type { SettingsSection } from "../../types/app";
import type { AgentRuntime } from "../../features/agent/AgentIdentity";

export type ComponentGroup = "engines" | "agents" | "shared";

/** Presentation for modules reported by component_maintenance.rs. Agents reuse their AgentIcon mark; unknown ids fall back to a neutral package. */
export interface ComponentMeta { icon: LucideIcon; agent?: AgentRuntime; color: string; group: ComponentGroup; setup?: SettingsSection; requires?: string[] }

export const COMPONENT_META: Record<string, ComponentMeta> = {
  llama_cpp: { icon: Cpu, color: "var(--series-1)", group: "engines", setup: "engine" },
  strata: { icon: Layers, color: "var(--series-2)", group: "engines", setup: "engine", requires: ["python_runtime"] },
  hermes: { icon: Package, agent: "hermes", color: "var(--k-accent)", group: "agents", setup: "connections", requires: ["python_runtime"] },
  codex: { icon: Package, agent: "codex", color: "var(--k-text)", group: "agents", setup: "connections" },
  claude: { icon: Package, agent: "claude", color: "#dfaa89", group: "agents", setup: "connections" },
  cache: { icon: Archive, color: "var(--series-4)", group: "shared" },
  python_runtime: { icon: Boxes, color: "var(--series-5)", group: "shared" },
};
const FALLBACK: ComponentMeta = { icon: Package, color: "var(--k-text-3)", group: "shared" };
export const metaFor = (id: string) => COMPONENT_META[id] ?? FALLBACK;
export const GROUPS: ComponentGroup[] = ["engines", "agents", "shared"];
/** Modules that cannot work without the given shared component. */
export const dependentsOf = (id: string) => Object.entries(COMPONENT_META).filter(([, meta]) => meta.requires?.includes(id)).map(([key]) => key);
