import { describe, expect, it } from 'vitest';
import { boundTaskProfile } from '../src/features/agent/connection';
import type { AgentBinding } from '../src/features/agent/workspaceModel';
import { useLaunchUi } from '../src/features/launches/ui';
import { DEFAULT_CONFIG } from '../src/types/config';
import type { LaunchProfile } from '../src/types/app';

const profile: LaunchProfile = { id: 'flash', name: 'Saved Flash', config: { ...DEFAULT_CONFIG, engine: 'strata' }, createdAt: 'now', updatedAt: 'now', lastKnownGood: false };
const binding: AgentBinding = { runId: 'profile:flash', generation: 8, name: 'Old name', profileName: 'Old name', modelId: 'flash.json', engine: 'strata', contextTokens: 131072 };
describe('restored task connection', () => {
  it('resolves the original profile by identity after a rename, without needing a running server', () => {
    expect(boundTaskProfile(binding, [profile])).toBe(profile);
  });
  it('does not substitute a different engine or a same-name profile for a missing binding', () => {
    expect(boundTaskProfile(binding, [{ ...profile, config: { ...DEFAULT_CONFIG, engine: 'llama_cpp' } }])).toBeUndefined();
    expect(boundTaskProfile(binding, [{ ...profile, id: 'different', name: 'Old name' }])).toBeUndefined();
    expect(boundTaskProfile(undefined, [profile])).toBeUndefined();
  });
  it('clears task preselection when the ordinary server picker is opened later', () => {
    useLaunchUi.getState().setQuickAdd(true, profile.id);
    expect(useLaunchUi.getState().preferredProfileId).toBe(profile.id);
    useLaunchUi.getState().setQuickAdd(false);
    useLaunchUi.getState().setQuickAdd(true);
    expect(useLaunchUi.getState().preferredProfileId).toBeUndefined();
  });
});
