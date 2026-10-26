import type { AppSettings, ServerEngine } from "../../types/app";
import type { LaunchConfig } from "../../types/config";

const ENGINE_KEYS: Record<ServerEngine, readonly (keyof AppSettings)[]> = {
  llama_cpp: ["binaryPath", "serverMode", "routerHost", "routerPort", "routerMaxLoadedModels", "routerAutoload", "routerApiKey"],
  strata: ["strataRootPath", "strataConfigPath", "strataHost", "strataPort", "strataApiKey"],
};

export function isSupportedProfileEngine(engine: string | undefined): engine is ServerEngine {
  return engine !== undefined && Object.prototype.hasOwnProperty.call(ENGINE_KEYS, engine);
}

function snapshotSettings(engine: ServerEngine, settings: AppSettings): Record<string, unknown> {
  return Object.fromEntries(ENGINE_KEYS[engine].map(key => [key, structuredClone(settings[key])]));
}

/** Capture the selected engine's full current settings while retaining unknown imported fields. */
export function captureEngineOptions(config: LaunchConfig, settings: AppSettings): LaunchConfig {
  const engine = settings.serverEngine;
  if (!engine) return config;
  return {
    ...config,
    engine,
    engineOptions: {
      ...config.engineOptions,
      [engine]: { ...config.engineOptions?.[engine], ...snapshotSettings(engine, settings) },
    },
  };
}

/** Restore known settings from a profile without dropping global UI preferences or future keys. */
export function restoreEngineOptions(config: LaunchConfig, settings: AppSettings): AppSettings {
  const engine = config.engine ?? settings.serverEngine;
  if (!engine || !isSupportedProfileEngine(engine)) return settings;
  const snapshot = config.engineOptions?.[engine];
  if (!snapshot) return { ...settings, serverEngine: engine };
  const patch: Partial<AppSettings> = { serverEngine: engine };
  for (const key of ENGINE_KEYS[engine]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      (patch as Record<string, unknown>)[key] = structuredClone(snapshot[key]);
    }
  }
  return { ...settings, ...patch };
}

export function profileRunId(profileId: string): string { return `profile:${profileId}`; }
