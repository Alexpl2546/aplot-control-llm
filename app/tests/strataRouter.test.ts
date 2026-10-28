import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type LaunchProfile } from '../src/types/app';
import { DEFAULT_CONFIG } from '../src/types/config';

vi.mock('../src/services/tauri', async original => ({
  ...(await original<object>()),
  createRunStartRequest: vi.fn(async ({ runId, config }) => ({ runId, name: config.profileName, engine: 'strata', mode: 'single', modelId: '', contextTokens: 0, autoPort: true, launch: { host: '0.0.0.0', port: 8090, apiKey: 'upstream' } })),
}));

import { strataRouterConfig, strataRouterModels } from '../src/features/live/strataRouter';

const profile = (id: string, name: string, engine = 'strata', configPath = `C:\\models\\${id}.json`) => ({
  id, name, createdAt: '', updatedAt: '',
  config: { ...DEFAULT_CONFIG, profileId: id, profileName: name, engine, engineOptions: { strata: { strataConfigPath: configPath } } },
}) as unknown as LaunchProfile;

describe('shared Strata address', () => {
  it('names each Strata model once and skips other engines or models without a config', () => {
    const models = strataRouterModels([profile('a', 'Qwen'), profile('b', 'qwen'), profile('c', 'Llama', 'llama_cpp'), profile('d', 'Empty', 'strata', '')]);
    expect(models.map(item => item.model)).toEqual(['Qwen', 'qwen (2)']);
  });

  it('runs the models on loopback ports after the shared one', async () => {
    const settings = { ...DEFAULT_SETTINGS, strataServerMode: 'router' as const, strataHost: '0.0.0.0', strataPort: 9000, strataApiKey: 'shared' };
    const config = await strataRouterConfig(settings, [profile('a', 'Qwen'), profile('b', 'DeepSeek')]);
    expect(config).toMatchObject({ enabled: true, host: '0.0.0.0', port: 9000, apiKey: 'shared' });
    expect(config.members.map(member => [member.model, member.request.runId, member.request.launch])).toEqual([
      ['Qwen', 'profile:a', { host: '127.0.0.1', port: 9001, apiKey: 'upstream' }],
      ['DeepSeek', 'profile:b', { host: '127.0.0.1', port: 9001, apiKey: 'upstream' }],
    ]);
  });

  it('turns the listener off in separate mode', async () => {
    const config = await strataRouterConfig(DEFAULT_SETTINGS, [profile('a', 'Qwen')]);
    expect(config).toMatchObject({ enabled: false, members: [] });
  });
});
