import type { AppSettings, ServerEngine } from "../../types/app";
import type { LaunchConfig } from "../../types/config";

export type JsonRecord = Record<string, unknown>;

export interface EngineOptionsSnapshot {
  engine: string;
  values: JsonRecord;
  [key: string]: unknown;
}

/**
 * Current profiles still carry a legacy LaunchConfig. Engine settings that live
 * outside LaunchConfig are stored in this open object so new engine options do not
 * have to be added to the legacy LaunchConfig interface.
 */
export type ProfileLaunchConfig = Omit<LaunchConfig, "engineOptions"> & {
  engineOptions?: EngineOptionsSnapshot;
  [key: string]: unknown;
};

export function engineOptionsFromSettings(settings: AppSettings, engine: ServerEngine): EngineOptionsSnapshot {
  switch (engine) {
    case "llama_cpp":
      return {
        engine,
        values: {
          binaryPath: settings.binaryPath,
          serverMode: settings.serverMode,
          routerHost: settings.routerHost,
          routerPort: settings.routerPort,
          routerMaxLoadedModels: settings.routerMaxLoadedModels,
          routerAutoload: settings.routerAutoload,
          routerApiKey: settings.routerApiKey,
        },
      };
    case "strata":
      return {
        engine,
        values: {
          strataRootPath: settings.strataRootPath,
          strataConfigPath: settings.strataConfigPath,
          strataHost: settings.strataHost,
          strataPort: settings.strataPort,
          strataApiKey: settings.strataApiKey,
        },
      };
  }
}

/** Capture the selected engine's settings without dropping legacy or future keys. */
export function captureEngineOptions(
  settings: AppSettings,
  engine: ServerEngine,
  legacyConfig: ProfileLaunchConfig,
): ProfileLaunchConfig {
  const previous = legacyConfig.engineOptions;
  const current = engineOptionsFromSettings(settings, engine);
  return {
    ...legacyConfig,
    engine,
    engineOptions: {
      ...(previous ?? {}),
      engine,
      values: {
        ...(previous?.values ?? {}),
        ...current.values,
      },
    },
  };
}

/** Restore recognized values to global settings; unknown values stay in config. */
export function restoreEngineOptions(
  settings: AppSettings,
  profileConfig: ProfileLaunchConfig,
): AppSettings {
  const values = profileConfig.engineOptions?.values;
  const engine = profileConfig.engineOptions?.engine ?? profileConfig.engine;
  if (!values || !engine) return settings;

  switch (engine) {
    case "llama_cpp":
      return {
        ...settings,
        binaryPath: stringValue(values.binaryPath, settings.binaryPath),
        serverMode: stringValue(values.serverMode, settings.serverMode) as AppSettings["serverMode"],
        routerHost: stringValue(values.routerHost, settings.routerHost),
        routerPort: numberValue(values.routerPort, settings.routerPort),
        routerMaxLoadedModels: numberValue(values.routerMaxLoadedModels, settings.routerMaxLoadedModels),
        routerAutoload: booleanValue(values.routerAutoload, settings.routerAutoload),
        routerApiKey: stringValue(values.routerApiKey, settings.routerApiKey),
      };
    case "strata":
      return {
        ...settings,
        strataRootPath: stringValue(values.strataRootPath, settings.strataRootPath),
        strataConfigPath: stringValue(values.strataConfigPath, settings.strataConfigPath),
        strataHost: stringValue(values.strataHost, settings.strataHost),
        strataPort: numberValue(values.strataPort, settings.strataPort),
        strataApiKey: stringValue(values.strataApiKey, settings.strataApiKey),
      };
    default:
      return settings;
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
