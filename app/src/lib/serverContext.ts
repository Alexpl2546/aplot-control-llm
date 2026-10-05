import type { AppSettings, ServerEngine, StrataModelOption } from "../types/app";
import type { LaunchConfig } from "../types/config";
import type { RuntimeSnapshot } from "../types/runtime";

export function configuredContextSize(engine: ServerEngine, config: LaunchConfig, settings: AppSettings, strataModels: StrataModelOption[]): number {
  if (engine === "strata") return strataModels.find(model => model.configPath === settings.strataConfigPath)?.contextLength ?? 0;
  if (engine === "qwfnfer") return settings.qwfn.context;
  if (engine === "ollama") return settings.ollamaContext;
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
  const model = strataModels.find(option => option.configPath === settings.strataConfigPath);
  return {
    ...config, engine: "strata", profileId: `strata:${settings.strataConfigPath}`,
    profileName: model?.modelName ?? "Strata", modelAlias: model?.modelName ?? "Strata",
    modelPath: model?.modelPath ?? "", ctxSize: configuredContextSize("strata", config, settings, strataModels),
    host: settings.strataHost, port: settings.strataPort, apiKey: settings.strataApiKey,
    metrics: true, slots: false, webUi: false,
  };
}
