import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { useOpenAi } from '../src/features/openai/store';
import { accountQuotas } from '../src/features/openai/accountQuotas';

beforeEach(() => useOpenAi.setState({ profiles: [], profileStatuses: {}, quotasByConnection: {}, claudeLimitsByConnection: {} }));
it('has a single empty state when there are no connected accounts', () => {
  useOpenAi.setState({ profiles: [{ id: 'offline', name: 'Offline', provider: 'claude', enabled: true }] });
  expect(accountQuotas(useOpenAi.getState())).toEqual([]);
});
it('lists each connected account with only its own limit snapshots', () => {
  useOpenAi.setState({
    profiles: [
      { id: 'one', name: 'Personal', provider: 'openai', enabled: true },
      { id: 'two', name: 'Work', provider: 'openai', enabled: true },
      { id: 'three', name: 'Claude', provider: 'claude', enabled: true },
    ],
    defaults: { openai: 'two' },
    profileStatuses: {
      one: { connected: true, pending: false, connectionId: 'account-one' },
      two: { connected: true, pending: false, connectionId: 'account-two' },
      three: { connected: true, connectionId: 'account-three', installed: true },
    },
    quotasByConnection: {
      'account-one': { at: 1, value: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } },
      'account-two': { at: 1, value: { rateLimits: { primary: { usedPercent: 80, windowDurationMins: 10080 } } } },
    },
    claudeLimitsByConnection: { 'account-three': { at: 1, value: { unifiedWindows: { five_hour: { utilization: .35 } } } } },
  });
  const rows = accountQuotas(useOpenAi.getState());
  expect(rows[2].limits[0].minutes).toBe(300);
  expect(rows.map(row => [row.name, row.limits[0].remaining])).toEqual([['Personal', 90], ['Work', 20], ['Claude', 65]]);
  useOpenAi.setState(state => ({ profiles: state.profiles.map(p => p.id === 'one' ? { ...p, enabled: false } : p) }));
  expect(accountQuotas(useOpenAi.getState()).map(row => row.name)).toEqual(['Work', 'Claude']);
});
it('does not invent usage for an account whose provider has not supplied it', () => {
  useOpenAi.setState({ profiles: [{ id: 'one', name: 'Personal', provider: 'openai', enabled: true }],
    profileStatuses: { one: { connected: true, pending: false, connectionId: 'account-one' } },
    quota: { rateLimits: { primary: { usedPercent: 0 } } }, quotaConnectionId: 'another-account' });
  expect(accountQuotas(useOpenAi.getState())[0].limits).toEqual([]);
});
it('rejects invalid percentages and clamps overages while retaining separate windows', () => {
  useOpenAi.setState({ profiles: [{ id: 'one', name: 'Personal', provider: 'openai', enabled: true }],
    profileStatuses: { one: { connected: true, pending: false, connectionId: 'account-one' } },
    quotasByConnection: { 'account-one': { at: 1, value: { rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 110 }, secondary: { usedPercent: -2 } },
      invalid: { primary: { usedPercent: NaN } },
    } } } } });
  expect(accountQuotas(useOpenAi.getState())[0].limits.map(limit => limit.remaining)).toEqual([0, 100]);
});
