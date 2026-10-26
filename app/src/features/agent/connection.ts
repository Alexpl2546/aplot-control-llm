import type { LaunchProfile } from '../../types/app';
import type { AgentBinding } from './workspaceModel';

/** A saved task can refer to a removed profile; never substitute by display name. */
export function boundTaskProfile(binding: AgentBinding | undefined, profiles: LaunchProfile[]) {
  return binding ? profiles.find(profile => binding.runId === `profile:${profile.id}` && binding.engine === (profile.config.engine ?? 'llama_cpp')) : undefined;
}
