import type { AppSettings } from '../../types/app';
import type { LaunchConfig } from '../../types/config';
import { isSupportedProfileEngine } from './profiles';

/** Discovery is advisory; native launch preparation validates the actual files. */
export function launchBlocker(config: LaunchConfig, settings: AppSettings): string | undefined {
  if (!settings.serverEngine) return 'launches.blocked.engineSelection';
  if (config.engine && !isSupportedProfileEngine(config.engine)) return 'launches.blocked.unsupportedEngine';
  switch (settings.serverEngine) {
    case 'strata':
      if (!settings.strataRootPath.trim()) return 'launches.blocked.strataRoot';
      if (!settings.strataConfigPath.trim()) return 'launches.blocked.strataConfig';
      return;
    default:
      if (config.engine && config.engine !== 'llama_cpp') return 'launches.blocked.profile';
      if (!(config.binaryPath || settings.binaryPath).trim()) return 'launches.blocked.binary';
      if (!config.modelPath.trim()) return 'launches.blocked.model';
  }
}
