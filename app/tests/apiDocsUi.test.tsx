// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../src/lib/i18n';
import i18n from '../src/lib/i18n';
import { ApiDocsView } from '../src/views/ApiDocsView';
import { fetchOpenApiSpec } from '../src/services/tauri';
import type { ConnectionTarget } from '../src/services/connections';
import type { ConnectionPanelProps } from '../src/features/connections/ConnectionPanel';

vi.mock('../src/services/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/tauri')>(),
  fetchOpenApiSpec: vi.fn(),
}));
vi.mock('../src/features/connections/ConnectionPanel', () => ({
  ConnectionPanel: ({ onTargetChange }: ConnectionPanelProps) => {
    const target = (runId: string): ConnectionTarget => ({ runId, engine: 'llama_cpp', baseUrl: `http://${runId}:8080/v1`, modelId: runId, contextTokens: 8192, apiKey: '', protocol: 'openai-chat-completions', managed: true });
    return <div>
      <button onClick={() => onTargetChange(target('first'), 'ready', 'manager')}>First server</button>
      <button onClick={() => onTargetChange(target('second'), 'ready', 'manager')}>Second server</button>
      <button onClick={() => onTargetChange(null, 'stopped', 'manager')}>Stopped server</button>
    </div>;
  },
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
beforeEach(() => vi.mocked(fetchOpenApiSpec).mockReset());
afterEach(cleanup);

describe('API documentation server switching', () => {
  it('ignores the previous server response when requests finish out of order', async () => {
    const first = deferred<Record<string, unknown>>();
    vi.mocked(fetchOpenApiSpec).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ info: { title: 'Second API' } });
    render(<ApiDocsView/>);
    fireEvent.click(screen.getByText('First server'));
    await waitFor(() => expect(fetchOpenApiSpec).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Second server'));
    await screen.findByText('Second API');
    await act(async () => first.resolve({ info: { title: 'First API' } }));
    expect(screen.queryByText('First API')).toBeNull();
    expect(screen.getByText('Second API')).toBeTruthy();
  });

  it('discards a pending response when switching to a stopped server', async () => {
    const first = deferred<Record<string, unknown>>();
    vi.mocked(fetchOpenApiSpec).mockReturnValue(first.promise);
    render(<ApiDocsView/>);
    fireEvent.click(screen.getByText('First server'));
    await waitFor(() => expect(fetchOpenApiSpec).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Stopped server'));
    await act(async () => first.resolve({ info: { title: 'Obsolete API' } }));
    expect(screen.queryByText('Obsolete API')).toBeNull();
    expect(screen.queryByText(i18n.t('apiDocs.loading'))).toBeNull();
    expect(screen.getByText(i18n.t('apiDocs.serverStopped'))).toBeTruthy();
  });

  it('does not replace the selected server documentation with an earlier failure', async () => {
    const first = deferred<Record<string, unknown>>();
    vi.mocked(fetchOpenApiSpec).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ info: { title: 'Current API' } });
    render(<ApiDocsView/>);
    fireEvent.click(screen.getByText('First server'));
    await waitFor(() => expect(fetchOpenApiSpec).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Second server'));
    await screen.findByText('Current API');
    await act(async () => first.reject(new Error('Old connection failed')));
    expect(screen.queryByText(/Old connection failed/)).toBeNull();
    expect(screen.getByText('Current API')).toBeTruthy();
  });
});
