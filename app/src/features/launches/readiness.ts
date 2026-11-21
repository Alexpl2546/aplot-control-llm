import type { AppSettings } from '../../types/app';
import type { LaunchConfig } from '../../types/config';
import { isSupportedProfileEngine } from './profiles';

/** Discovery is advisory; native launch preparation validates the actual files. */
export function launchBlocker(config: LaunchConfig, settings: AppSettings): string | undefined {
  if (!settings.serverEngine) return 'launches.blocked.engineSelection';
  if (config.engine && !isSupportedProfileEngine(config.engine)) return 'launches.blocked.unsupportedEngine';
  switch (settings.serverEngine) {
    case 'basalt':
      if (!settings.basaltRootPath?.trim()) return 'launches.blocked.basaltRoot';
      if (!/\.basalt$/i.test(config.modelPath.trim())) return 'launches.blocked.basaltModel';
      if (!Number.isInteger(config.ctxSize) || config.ctxSize < 1 || config.ctxSize > 0xffffffff
        || !Number.isInteger(config.parallel) || config.parallel < 1 || config.parallel > 8) {
        return 'launches.blocked.basaltContext';
      }
      return;
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
