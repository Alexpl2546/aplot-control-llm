import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, LaunchProfile } from '../../types/app';
import type { LaunchConfig, LlamaCapabilities } from '../../types/config';
import type { NativeResourcePlan } from '../resources/ResourcePlanPanel';
import { restoreEngineOptions, captureEngineOptions, profileRunId } from '../launches/profiles';
import * as bridge from '../../services/tauri';
import { isSupportedProfileEngine } from '../launches/profiles';

export class TaskApplicationError extends Error {
  constructor(public code: 'resources' | 'source' | 'context') { super(code); }
}

/** A task creates a separate profile; it never writes an original profile or starts a server. */
export async function createTaskProfile(source: LaunchProfile, proposed: LaunchConfig, settings: AppSettings, capabilities: LlamaCapabilities, name: string) {
  if (!proposed.smartTask || proposed.smartTask.sourceProfileId !== source.id) throw new TaskApplicationError('source');
  const engine = source.config.engine ?? 'llama_cpp';
  if (source.unsupportedEngine || !isSupportedProfileEngine(engine)) throw new TaskApplicationError('source');
  const id = crypto.randomUUID();
  let nextSettings = restoreEngineOptions(source.config, settings);
  let config: LaunchConfig = { ...structuredClone(proposed), profileId: id, profileName: name };
  let strataFile: string | undefined;
  let cloned: LaunchProfile | undefined;
  try {
    if (engine === 'strata' && bridge.isTauri()) {
      strataFile = await invoke<string>('create_strata_task_config', { rootValue: nextSettings.strataRootPath, configValue: nextSettings.strataConfigPath, context: config.smartTask!.contextPerRequest, taskId: id });
      nextSettings = { ...nextSettings, strataConfigPath: strataFile };
    }
    config = captureEngineOptions(config, nextSettings);
    if (bridge.isTauri()) {
      // The existing resource planner validates the exact derived launch before it is saved.
      const request = await bridge.createRunStartRequest({ config, settings: nextSettings, profiles: [{ ...source, id, name, config }], capabilities, runId: profileRunId(id), preview: true });
      const resources = await invoke<NativeResourcePlan>('plan_run_resources', { request });
      if (resources.candidates.find(c => c.id === 'configured')?.status === 'insufficient') throw new TaskApplicationError('resources');
      if (source.v2) cloned = await bridge.duplicateProfileSnapshot(source, id, name);
    }
    const now = new Date().toISOString();
    const saved = await bridge.saveProfile({ ...(cloned ?? source), id, name, config, revision: cloned?.revision, v2: cloned?.v2,
      description: undefined, createdAt: now, updatedAt: now, lastUsedAt: undefined, lastKnownGood: false });
    return { profile: saved, settings: nextSettings };
  } catch (error) {
    if (cloned) await bridge.deleteProfile(cloned.id, cloned.revision).catch(() => undefined);
    if (strataFile) await invoke('remove_strata_task_config', { rootValue: nextSettings.strataRootPath, taskId: id }).catch(() => undefined);
    throw error;
  }
}
