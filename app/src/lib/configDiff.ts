import { PARAMETER_REGISTRY } from "./parameters";
import type { LaunchConfig } from "../types/config";

export interface ConfigChange {
  key: keyof LaunchConfig;
  labelKey: string;
  cli?: string;
  before: string;
  after: string;
  restartRequired: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

export function configDiff(before: LaunchConfig, after: LaunchConfig): ConfigChange[] {
  return PARAMETER_REGISTRY.flatMap(def => {
    const oldValue = before[def.key];
    const newValue = after[def.key];
    if (equal(oldValue, newValue)) return [];
    const sensitive = def.key === "apiKey";
    return [{
      key: def.key,
      labelKey: def.labelKey,
      cli: def.cli,
      before: sensitive && oldValue ? "••••••" : stable(oldValue),
      after: sensitive && newValue ? "••••••" : stable(newValue),
      restartRequired: def.restartRequired,
    }];
  });
}
