import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/tauri', () => ({ isTauri: () => false }));
import { startAgent, promptAgent, stopAgent } from '../src/services/agent';
import type { AgentFrame } from '../src/features/agent/store';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('stops a preview turn without losing the conversation or accepting delayed results', async () => {
  vi.useFakeTimers(); vi.stubGlobal('document', { documentElement: { lang: 'en' } });
  const frames: AgentFrame[] = [];
  await startAgent({ id: 'preview-test', runId: 'r', generation: 1, cwd: 'C:\\fixture', language: 'en' }, frame => frames.push(frame));
  const pending = promptAgent('preview-test', 'one');
  await stopAgent('preview-test'); await vi.runAllTimersAsync(); await pending;
  expect(frames.filter(f => f.type === 'message.complete').map(f => f.payload?.status)).toEqual(['interrupted']);
  const next = promptAgent('preview-test', 'two'); await vi.runAllTimersAsync(); await next;
  expect(frames.filter(f => f.type === 'message.complete').map(f => f.payload?.status)).toEqual(['interrupted', 'complete']);
  await stopAgent('preview-test', true);
});
