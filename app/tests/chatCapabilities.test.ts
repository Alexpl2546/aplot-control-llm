import { expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
import { chatCapability } from '../src/features/openai/capabilities';
import { cloudSelection, connectionOptions, useOpenAi } from '../src/features/openai/store';

it('does not advertise API-key tools as verified and keeps plan limitations explicit', () => {
  expect(chatCapability({ provider: 'chatgpt' }, 'imageGeneration')).toEqual({ state: 'unavailable', reason: 'authMode' });
  expect(chatCapability({ provider: 'chatgpt', authMode: 'apiKey' }, 'imageGeneration')).toEqual({ state: 'unavailable', reason: 'notIntegrated' });
  expect(chatCapability({ provider: 'chatgpt', authMode: 'apiKey' }, 'webSearch').state).toBe('conditional');
  expect(chatCapability({ provider: 'local' }, 'webSearch').state).toBe('unavailable');
});

it('offers API-key profiles in chat while keeping them out of subscription agent execution', () => {
  useOpenAi.setState({ profiles: [{ id: 'api', provider: 'openai', name: 'API', enabled: true, authMode: 'apiKey', connectionId: 'api-one' }], defaults: { openai: 'api' }, profileStatuses: { api: { connected: true, pending: false, connectionId: 'api-one', authMode: 'apiKey' } }, catalogs: { 'api-one': [{ id: 'model', model: 'model', displayName: 'Model' }] } });
  expect(cloudSelection(useOpenAi.getState(), 'openai', 'api-one').status.connected).toBe(false);
  expect(cloudSelection(useOpenAi.getState(), 'openai', 'api-one', undefined, 'chat').status.connected).toBe(true);
  expect(connectionOptions(useOpenAi.getState(), 'openai')).toEqual([]);
  expect(connectionOptions(useOpenAi.getState(), 'openai', 'chat')[0].value).toBe('api');
  expect(cloudSelection(useOpenAi.getState(), 'openai', 'deleted-key', undefined, 'chat').status.connected).toBe(false);
});
