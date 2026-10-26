import { ENGINE_NAMES, type EngineModel } from '../../lib/engineModels';
import type { LaunchProfile } from '../../types/app';
import type { AplotOption } from './AplotSelect';

export function profileSelectOption(profile:LaunchProfile):AplotOption {
  const config=profile.config;
  const engine = config.engine ?? 'llama_cpp';
  return {value:profile.id,label:profile.name,description:[ENGINE_NAMES[engine as keyof typeof ENGINE_NAMES] ?? engine,config.ctxSize?`${Math.round(config.ctxSize/1024)}K`:undefined].filter(Boolean).join(' · '),keywords:[config.modelAlias,config.modelPath,config.engineModel].filter(Boolean).join(' ')};
}
export function modelSelectDescription(model:Pick<EngineModel,'contextLength'|'quantization'|'architecture'>):string {
  return [model.contextLength?`${Math.round(model.contextLength/1024)}K`:undefined,model.quantization,model.architecture].filter(Boolean).join(' · ');
}
