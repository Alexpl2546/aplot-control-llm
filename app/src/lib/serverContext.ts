import type { AppSettings, ServerEngine, StrataModelOption } from "../types/app";
import type { LaunchConfig } from "../types/config";
import type { RuntimeSnapshot } from "../types/runtime";
import { sameFilePath } from "./filePaths";

export const strataModelForConfig = (models: StrataModelOption[], path: string) => models.find(model => sameFilePath(model.configPath, path));

export function configuredContextSize(engine: ServerEngine | "", config: LaunchConfig, settings: AppSettings, strataModels: StrataModelOption[]): number {
  if (!engine) return 0;
  if (engine === "strata") return strataModelForConfig(strataModels, settings.strataConfigPath)?.contextLength ?? (config.engine === 'strata' && settings.strataConfigPath.trim() ? config.ctxSize : 0);
  return config.ctxSize;
}

export function serverContextSize({ runtime, config, settings, strataModels, runningEngine, runningConfig }: {
  runtime: Pick<RuntimeSnapshot, "state" | "contextTotal">;
  config: LaunchConfig;
  settings: AppSettings;
  strataModels: StrataModelOption[];
  runningEngine?: ServerEngine;
  runningConfig?: LaunchConfig;
}): number {
  const running = !["stopped", "crashed"].includes(runtime.state);
  // Starting/loading can retain metrics from the previous server until the next poll.
  if (["ready", "busy", "stopping"].includes(runtime.state) && runtime.contextTotal > 0) return runtime.contextTotal;
  if (running && runningConfig) return runningConfig.ctxSize;
  return configuredContextSize((running ? runningEngine : undefined) ?? settings.serverEngine, config, settings, strataModels);
}

export function strataRuntimeConfig(config: LaunchConfig, settings: AppSettings, strataModels: StrataModelOption[]): LaunchConfig {
  const model = strataModelForConfig(strataModels, settings.strataConfigPath);
  return {
    ...config, engine: "strata", profileId: `strata:${settings.strataConfigPath}`,
    profileName: model?.modelName ?? "Strata", modelAlias: model?.modelName ?? "Strata",
    modelPath: model?.modelPath ?? "", ctxSize: configuredContextSize("strata", config, settings, strataModels),
    host: settings.strataHost, port: settings.strataPort, apiKey: settings.strataApiKey,
    metrics: true, slots: false, webUi: false,
  };
}
