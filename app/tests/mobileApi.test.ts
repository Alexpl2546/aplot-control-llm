import { describe, expect, it, vi } from 'vitest';
import { MobileApi, MobileApiError } from '../mobile/api';

const workspace = {
  serverId: 'server-one',
  projects: [{ id: 'project/one', name: 'Alpha' }],
  tasks: [{ id: 'task/one', projectId: 'project/one', title: 'Task', runtime: 'codex', pending: false, starting: false, ended: false, error: '', archived: false, deletedAt: null }],
  capabilities: { send: true, interrupt: true },
  model: 'codex-test',
};

const taskSnapshot = {
  cursor: 9,
  task: {
    id: 'task/one', runtime: 'codex', revision: 3,
    state: { pending: false, starting: false, ended: false, stopped: false, error: '', live: true, nativeGeneration: null },
    messages: [], turns: [],
  },
  commands: [],
  metadata: { id: 'task/one', title: 'Task', projectId: 'project/one', runtime: 'codex' },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MobileApi', () => {
  it('sends only an explicit access mode and revision and validates the saved permission receipt', async () => {
    const receipt = {commandId:'access-id',taskId:'task-one',status:'updated',accessMode:'full',revision:8};
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(receipt));
    const api = new MobileApi(fetcher, () => 'https://aplot.example');
    expect(await api.setAccessMode('task-one','secret',{commandId:'access-id',expectedRevision:7,accessMode:'full'})).toEqual(receipt);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://aplot.example/api/v1/tasks/task-one/access');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({commandId:'access-id',expectedRevision:7,accessMode:'full'});
    fetcher.mockResolvedValueOnce(jsonResponse({...receipt,accessMode:'manual'}));
    await expect(api.setAccessMode('task-one','secret',{commandId:'access-id',expectedRevision:7,accessMode:'full'})).rejects.toMatchObject({code:'response-invalid'});
  });
  it('uses exact same-origin paths, Bearer auth, no cookies, and fixed request bodies', async () => {
    const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(jsonResponse(workspace))
      .mockResolvedValueOnce(jsonResponse(taskSnapshot))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'new-task', commandId: 'create-id', status: 'created' }))
      .mockResolvedValueOnce(jsonResponse({ commandId: 'send-id', taskId: 'task/one', status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'cancelled' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'cancel_requested' }));
    const api = new MobileApi(fetcher, () => 'https://aplot.example');

    await api.getWorkspace('secret');
    await api.getTask('task/one', 'secret');
    await api.createTask('project/one', 'secret', { commandId: 'create-id', title: 'New task' });
    await api.sendMessage('task/one', 'secret', { commandId: 'send-id', text: 'Hello' });
    await api.cancelCommand('send-id', 'secret');
    await api.interruptTask('task/one', 'secret', {
      commandId: 'stop-id', expectedGeneration: 4, expectedTurnId: 'turn-id',
    });

    expect(fetcher).toHaveBeenCalledTimes(6);
    const calls = fetcher.mock.calls;
    expect(calls.map(([input]) => String(input))).toEqual([
      'https://aplot.example/api/v1/workspace',
      'https://aplot.example/api/v1/tasks/task%2Fone',
      'https://aplot.example/api/v1/projects/project%2Fone/tasks',
      'https://aplot.example/api/v1/tasks/task%2Fone/messages',
      'https://aplot.example/api/v1/commands/send-id/cancel',
      'https://aplot.example/api/v1/tasks/task%2Fone/interrupt',
    ]);
    for (const [, init] of calls) {
      const request = init as RequestInit;
      expect(new Headers(request.headers).get('Authorization')).toBe('Bearer secret');
      expect(request.credentials).toBe('omit');
      expect(request.mode).toBe('same-origin');
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('error');
      expect(request.referrerPolicy).toBe('same-origin');
    }
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({ commandId: 'create-id', title: 'New task' });
    expect(JSON.parse(calls[3][1]?.body as string)).toEqual({ commandId: 'send-id', text: 'Hello' });
    expect(calls[4][1]?.body).toBe('{}');
    expect(JSON.parse(calls[5][1]?.body as string)).toEqual({
      commandId: 'stop-id', expectedGeneration: 4, expectedTurnId: 'turn-id',
    });
  });

  it('rejects malformed authenticated DTOs rather than letting the UI crash', async () => {
    const api = new MobileApi(vi.fn().mockResolvedValue(jsonResponse({ serverId: 'bad', tasks: null })), () => 'https://aplot.example');
    await expect(api.getWorkspace('secret')).rejects.toMatchObject({ status: 200, code: 'response-invalid' });
  });

  it('clears response bodies and reports unauthorized without exposing the token', async () => {
    const api = new MobileApi(vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized', detail: 'do not show' }, 401)), () => 'https://aplot.example');
    await expect(api.getWorkspace('secret')).rejects.toEqual(expect.objectContaining({
      status: 401,
      code: 'unauthorized',
    }));
    try {
      await api.getWorkspace('secret');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('do not show');
    }
  });

  it('rejects a token containing a header newline before making a request', async () => {
    const fetcher = vi.fn();
    const api = new MobileApi(fetcher, () => 'https://aplot.example');
    await expect(api.getWorkspace('secret\r\nX-Injected: yes')).rejects.toBeInstanceOf(MobileApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds a stalled request and aborts the underlying fetch', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      });
      const api = new MobileApi(fetcher, () => 'https://aplot.example');
      const pending = api.getWorkspace('secret');
      const rejection = expect(pending).rejects.toMatchObject({ status: 0, code: 'request-timeout' });
      await vi.advanceTimersByTimeAsync(12_000);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
