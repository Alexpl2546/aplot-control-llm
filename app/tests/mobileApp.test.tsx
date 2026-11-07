// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileApp } from '../mobile/src/App';
import { MessageFeed } from '../mobile/src/MessageFeed';
import { MobileApiError, type MobileApi } from '../mobile/api';
import type { MobileTaskSnapshot, MobileWorkspace } from '../mobile/types';

const project = { id: 'project-1', name: 'Проект Альфа' };

function workspace(serverId = 'server-one'): MobileWorkspace {
  return {
    serverId,
    projects: [project],
    tasks: [
      { id: 'task-a', projectId: project.id, title: 'Задача А', runtime: 'codex', pending: false, starting: false, ended: false, error: '', archived: false, deletedAt: null },
      { id: 'task-b', projectId: project.id, title: 'Задача Б', runtime: 'codex', pending: false, starting: false, ended: false, error: '', archived: false, deletedAt: null },
    ],
    capabilities: { send: true, interrupt: true },
    model: 'codex-test',
  };
}

function snapshot(taskId: string, text = ''): MobileTaskSnapshot {
  return {
    cursor: 1,
    task: {
      id: taskId, runtime: 'codex', revision: 1,
      state: { pending: false, starting: false, ended: false, stopped: false, error: '', live: true, nativeGeneration: 3 },
      messages: text ? [{ id: `${taskId}-message`, kind: 'assistant', text }] : [],
      turns: [],
    },
    commands: [],
    metadata: { id: taskId, title: taskId === 'task-a' ? 'Задача А' : 'Задача Б', projectId: project.id, runtime: 'codex' },
  };
}

function createApi(overrides: Partial<Record<keyof MobileApi, unknown>> = {}): MobileApi {
  return {
    getWorkspace: vi.fn().mockResolvedValue(workspace()),
    getTask: vi.fn().mockImplementation(async (taskId: string) => snapshot(taskId)),
    createTask: vi.fn(),
    sendMessage: vi.fn(),
    cancelCommand: vi.fn(),
    interruptTask: vi.fn(),
    ...overrides,
  } as unknown as MobileApi;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Ключ доступа'), 'memory-secret');
  await user.click(screen.getByRole('button', { name: 'Подключиться' }));
  await screen.findByRole('heading', { name: 'Проекты и задачи' });
}

describe('MobileApp', () => {
  it('changes access through task options and shows the mode read back from the server', async () => {
    let full = false;
    const setAccessMode = vi.fn(async (_taskId: string, _token: string, body: {commandId:string;expectedRevision:number;accessMode:'restricted'|'full'}) => {
      full = body.accessMode === 'full';
      return {commandId:body.commandId,taskId:'task-a',status:'updated',accessMode:body.accessMode,revision:full ? 2 : 3};
    });
    const api = createApi({
      getWorkspace: vi.fn().mockImplementation(async () => ({...workspace(),capabilities:{send:true,interrupt:true,changeAccessMode:true,allowedAccessModes:['restricted','full']}})),
      getTask: vi.fn().mockImplementation(async (id:string) => {
        const value = snapshot(id);
        value.task.state.live = false;
        value.task.revision = full ? 2 : 1;
        value.metadata.accessMode = full ? 'full' : 'restricted';
        return value;
      }),
      setAccessMode,
    });
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);
    await user.click(screen.getByRole('button',{name:'Открыть задачу Задача А'}));
    await screen.findByText('Начните задачу сообщением ниже.');
    await user.click(screen.getByRole('button',{name:'Параметры задачи'}));
    const options = screen.getByRole('dialog',{name:'Параметры задачи'});
    await user.click(within(options).getByRole('button',{name:/^Полный доступ/}));
    expect(setAccessMode).not.toHaveBeenCalled();
    await user.click(within(options).getByRole('button',{name:'Разрешить полный доступ'}));
    await waitFor(() => expect(setAccessMode).toHaveBeenCalledOnce());
    expect(setAccessMode.mock.calls[0][0]).toBe('task-a');
    expect(setAccessMode.mock.calls[0][2]).toMatchObject({accessMode:'full',expectedRevision:1});
    await waitFor(() => expect(within(options).getByText('полный доступ',{exact:true})).not.toBeNull());
  });

  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the key in memory and clears private views on 401', async () => {
    const api = createApi();
    const getWorkspace = api.getWorkspace as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<MobileApp api={api} />);
    await connect(user);
    expect(setItem).not.toHaveBeenCalled();
    expect(screen.getByText('localhost:3000')).not.toBeNull();

    getWorkspace.mockRejectedValueOnce(new MobileApiError(401, 'unauthorized'));
    await user.click(screen.getByRole('button', { name: 'Обновить данные' }));
    await screen.findByRole('heading', { name: 'Задачи всегда под рукой.' });
    expect((screen.getByLabelText('Ключ доступа') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Задача А')).toBeNull();
  });

  it('clears the token when the same origin starts returning a different server identity', async () => {
    const api = createApi();
    const getWorkspace = api.getWorkspace as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);
    getWorkspace.mockResolvedValueOnce(workspace('server-two'));
    await user.click(screen.getByRole('button', { name: 'Обновить данные' }));
    await screen.findByRole('heading', { name: 'Задачи всегда под рукой.' });
    expect((screen.getByLabelText('Ключ доступа') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain('Ответ сервера изменился');
  });

  it('fences stale task responses after the user switches tasks', async () => {
    let resolveA!: (value: MobileTaskSnapshot) => void;
    let resolveB!: (value: MobileTaskSnapshot) => void;
    const api = createApi({
      getTask: vi.fn((taskId: string) => new Promise<MobileTaskSnapshot>(resolve => {
        if (taskId === 'task-a') resolveA = resolve;
        else resolveB = resolve;
      })),
    });
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);

    await user.click(screen.getByRole('button', { name: 'Открыть задачу Задача А' }));
    await waitFor(() => expect(resolveA).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: 'Вернуться к списку задач' }));
    await user.click(screen.getByRole('button', { name: 'Открыть задачу Задача Б' }));
    resolveA(snapshot('task-a', 'STALE TASK A'));
    await waitFor(() => expect(resolveB).toBeTypeOf('function'));
    resolveB(snapshot('task-b', 'CURRENT TASK B'));

    expect(await screen.findByText('CURRENT TASK B')).not.toBeNull();
    expect(screen.queryByText('STALE TASK A')).toBeNull();
  });

  it('keeps an uncertain send for exact manual retry and preserves edits made while waiting', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ commandId: '123e4567-e89b-42d3-a456-426614174000', taskId: 'task-a', status: 'queued' });
    const api = createApi({ sendMessage });
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);
    await user.click(screen.getByRole('button', { name: 'Открыть задачу Задача А' }));
    await screen.findByText('Начните задачу сообщением ниже.');

    const composer = screen.getByLabelText('Сообщение для задачи');
    await user.type(composer, 'Исходный запрос');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await screen.findByText('Отправка не подтверждена');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const exactFirstBody = (sendMessage.mock.calls[0] as unknown[])[2];
    expect(exactFirstBody).toEqual({ commandId: '123e4567-e89b-42d3-a456-426614174000', text: 'Исходный запрос' });

    await user.clear(composer);
    await user.type(composer, 'Следующая заметка');
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect((sendMessage.mock.calls[1] as unknown[])[2]).toEqual(exactFirstBody);
    await waitFor(() => expect(screen.queryByText('Отправка не подтверждена')).toBeNull());
    expect((composer as HTMLTextAreaElement).value).toBe('Следующая заметка');
    expect(await screen.findByText('Исходный запрос')).not.toBeNull();
  });

  it('keeps completed command rows collapsed while active and uncertain sends stay visible', async () => {
    const api = createApi({
      getTask: vi.fn().mockResolvedValue({
        ...snapshot('task-a'),
        commands: [
          { commandId: 'done-1', taskId: 'task-a', status: 'completed', createdAt: '2026-11-06T08:00:00Z' },
          { commandId: 'active-1', taskId: 'task-a', status: 'dispatching', text: 'Отправляется сейчас', createdAt: '2026-11-06T08:01:00Z' },
          { commandId: 'failed-1', taskId: 'task-a', status: 'failed', error: 'timeout', createdAt: '2026-11-06T08:02:00Z' },
          { commandId: 'unknown-1', taskId: 'task-a', status: 'unknown', text: 'Неизвестный результат', createdAt: '2026-11-06T08:03:00Z' },
        ],
      }),
    });
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);
    await user.click(screen.getByRole('button', { name: 'Открыть задачу Задача А' }));
    await screen.findByText('Отправляется');

    const composer = screen.getByLabelText('Сообщение для задачи');
    await user.type(composer, 'Локальный черновик');
    expect(screen.getByText(/Время выполнения истекло/)).not.toBeNull();
    expect(screen.getByText('Результат неизвестен')).not.toBeNull();
    expect(screen.getByText('История отправок · 1')).not.toBeNull();
    expect(screen.getByText('Готово').closest('details')?.open).toBe(false);

    await user.click(screen.getByText('История отправок · 1'));
    expect(screen.getByText('Готово')).not.toBeNull();
    expect(screen.getByText('Готово').closest('details')?.open).toBe(true);
    expect((composer as HTMLTextAreaElement).value).toBe('Локальный черновик');

    await user.click(screen.getByRole('button', { name: 'Параметры задачи' }));
    const options = screen.getByRole('dialog', { name: 'Параметры задачи' });
    expect(within(options).queryByText('Доступ агента')).toBeNull();
    expect(within(options).getByRole('button', { name: 'Обновить данные' })).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((composer as HTMLTextAreaElement).value).toBe('Локальный черновик');
  });

  it('follows new messages only while at the bottom and preserves history reading position', async () => {
    let reply = 'Первая часть истории';
    const api = createApi({
      getTask: vi.fn().mockImplementation(async (taskId: string) => snapshot(taskId, reply)),
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-scroll') ? 1200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-scroll') ? 400 : 0;
    });
    const user = userEvent.setup();
    render(<MobileApp api={api} />);
    await connect(user);
    await user.click(screen.getByRole('button', { name: 'Открыть задачу Задача А' }));
    await screen.findByText('Первая часть истории');

    const panel = document.querySelector<HTMLElement>('.chat-scroll')!;
    expect(panel.scrollTop).toBe(1200);
    panel.scrollTop = 100;
    fireEvent.scroll(panel);
    reply = 'Новый ответ пока вне экрана';
    await user.click(screen.getByRole('button', { name: 'Обновить данные' }));
    await screen.findByText('Новый ответ пока вне экрана');
    expect(panel.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: /К последнему/ })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /К последнему/ }));
    expect(panel.scrollTop).toBe(1200);
    reply = 'Ответ после перехода к концу';
    await user.click(screen.getByRole('button', { name: 'Обновить данные' }));
    await screen.findByText('Ответ после перехода к концу');
    expect(panel.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: /К последнему/ })).toBeNull();
  });

  it('keeps finished tool output collapsed and never renders message HTML or images', () => {
    const { container } = render(<MessageFeed loading={false} messages={[
      { id: 'tool-1', kind: 'tool', name: 'read_file', status: 'success', result: 'safe output' },
      { id: 'assistant-1', kind: 'assistant', text: 'Text <img src="https://example.invalid/a.png" onerror="alert(1)"> [unsafe](javascript:alert(1))' },
    ]} />);
    expect(container.querySelector('details.tool-result')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('safe output');
  });
});
