import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => mocks.native, listRuns: vi.fn(), getRunConnection: vi.fn() }));
import { hermesAvailable, openInHermes } from '../src/services/connections';

beforeEach(() => { mocks.native = true; mocks.invoke.mockReset(); });
it('opens Hermes using only the server identity, leaving model and credentials to the native manager', async () => {
  mocks.invoke.mockResolvedValue({ sessionId: 'session', modelId: 'actual-api-model' });
  expect(await openInHermes('server-one')).toEqual({ sessionId: 'session', modelId: 'actual-api-model' });
  expect(mocks.invoke).toHaveBeenCalledWith('open_in_hermes', { runId: 'server-one' });
});
it('cannot launch desktop apps from the browser preview', async () => {
  mocks.native = false;
  expect(await hermesAvailable()).toBe(false);
  await expect(openInHermes('server-one')).rejects.toThrow('desktop-only');
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('keeps native failures visible instead of reporting a successful connection', async () => {
  mocks.invoke.mockRejectedValue('server-changed');
  await expect(openInHermes('server-one')).rejects.toBe('server-changed');
});
