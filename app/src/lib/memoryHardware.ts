import type { MemoryModule } from "../types/runtime";

export function memoryHardwareSummary(modules: MemoryModule[] = []) {
  const unique = (values: (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))];
  const types = unique(modules.map(module => module.memoryType));
  const models = unique(modules.map(module => [module.manufacturer, module.partNumber].filter(Boolean).join(" ")));
  const capacities = new Map<number, number>();
  for (const module of modules) if (module.capacityMiB > 0) capacities.set(module.capacityMiB, (capacities.get(module.capacityMiB) ?? 0) + 1);
  const speeds = [...new Set(modules.map(module => module.speedMtps).filter((speed): speed is number => Boolean(speed && speed > 0)))];
  return {
    name: [...types, ...models].join(" · "),
    capacity: [...capacities].map(([size, count]) => `${count} × ${Number((size / 1024).toFixed(2))} GB`).join(" + "),
    speed: speeds.map(speed => `${speed} MT/s`).join(" / "),
  };
}
