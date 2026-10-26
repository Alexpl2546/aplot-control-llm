// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../src/types/app';

vi.mock('../src/services/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/tauri')>(),
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, setupCompleted: true, serverEngine: '', routerApiKey: 'startup-test' })),
  availableEngines: vi.fn(async () => []),
}));
vi.mock('../src/services/desktop', () => ({ syncWindowsAutostart: vi.fn(async () => {}) }));

import { useControlStore } from '../src/store/control';
const initial = useControlStore.getState();
afterEach(() => { useControlStore.setState(initial, true); vi.restoreAllMocks(); });

it('shares initialization and publishes readiness only after the initial runs have loaded', async () => {
  let complete!: () => void;
  const runs = new Promise<void>(resolve => { complete = resolve; });
  const loadRuns = vi.fn(() => runs);
  useControlStore.setState({ initialized: false, loadRuns, rescanModels: vi.fn(async () => {}), refreshRuntime: vi.fn(async () => {}) });
  const first = useControlStore.getState().initialize(), second = useControlStore.getState().initialize();
  expect(first).toBe(second);
  await waitFor(() => expect(loadRuns).toHaveBeenCalledTimes(1));
  expect(useControlStore.getState().initialized).toBe(false);
  complete();
  await Promise.all([first, second]);
  expect(useControlStore.getState().initialized).toBe(true);
});
