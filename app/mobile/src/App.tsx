import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MobileApi, MobileApiError, mobileApi, type InterruptRequest } from '../api';
import { MessageFeed } from './MessageFeed';
import { TaskAccessControl, type AccessChangeRequest } from './TaskAccessControl';
import { uuidV4 } from './uuid';
import type {
  CreateTaskReceipt,
  MobileCommand,
  MobileCommandStatus,
  MobileTask,
  MobileTaskSnapshot,
  MobileWorkspace,
  SendMessageReceipt,
} from '../types';

interface PendingSend {
  commandId: string;
  taskId: string;
  text: string;
}

interface PendingCreate {
  commandId: string;
  projectId: string;
  title: string;
}

interface PendingInterrupt {
  taskId: string;
  body: InterruptRequest;
}

type StringMap = Record<string, string>;
type BooleanMap = Record<string, boolean>;
type CommandMap = Record<string, MobileCommand[]>;

function uuid(): string {
  return uuidV4();
}

function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

function errorText(error: unknown, context: 'connect' | 'refresh' | 'send' | 'create' | 'stop' | 'cancel'): string {
  if (!(error instanceof MobileApiError)) {
    return context === 'connect' ? 'Не удалось подключиться к серверу.' : 'Не удалось выполнить запрос. Проверьте сеть и попробуйте снова.';
  }
  if (error.status === 0 || error.code === 'network-unavailable') {
    return 'Нет связи с сервером. Проверьте подключение к сети.';
  }
  if (error.status === 503) {
    return 'Эта операция сейчас недоступна на сервере.';
  }
  if (error.status === 404) {
    return context === 'refresh' ? 'Задача больше недоступна.' : 'Запрошенный объект не найден.';
  }
  if (error.status === 409) {
    return context === 'stop' ? 'Задача уже изменилась. Обновите её состояние.' : 'Запрос уже обработан или его состояние изменилось.';
  }
  if (error.status === 401) return 'Ключ доступа больше не действует. Подключитесь снова.';
  if (context === 'connect') return 'Сервер не принял токен. Проверьте его и повторите попытку.';
  if (context === 'send') return 'Не удалось подтвердить отправку. Сервер мог уже принять сообщение; повторная попытка не создаст дубликат.';
  if (context === 'create') return 'Не удалось подтвердить создание. Сервер мог уже создать задачу; повторная попытка безопасна.';
  if (context === 'stop') return 'Не удалось подтвердить остановку. Повторите тот же запрос.';
  if (context === 'cancel') return 'Не удалось подтвердить отмену. Повторите запрос.';
  return 'Не удалось обновить данные. Показываем последнюю полученную версию.';
}

function statusText(task: MobileTask): string {
  if (task.error) return 'Ошибка';
  if (task.starting) return 'Запускается';
  if (task.pending) return 'Выполняется';
  if (task.ended) return 'Завершена';
  return 'Ждёт сообщения';
}

function useVisualViewport(selected: boolean): void {
  useEffect(() => {
    if (!selected) return;
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty('--mobile-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--mobile-viewport-height');
      document.documentElement.style.removeProperty('--mobile-viewport-top');
    };
  }, [selected]);
}

function commandStatusText(status: MobileCommandStatus): string {
  switch (status) {
    case 'queued': return 'В очереди';
    case 'dispatching': return 'Отправляется';
    case 'cancel_requested': return 'Остановка запрошена';
    case 'completed': return 'Готово';
    case 'failed': return 'Ошибка';
    case 'interrupted': return 'Остановлено';
    case 'cancelled': return 'Отменено';
    default: return 'Результат неизвестен';
  }
}

function runtimeErrorText(error: string): string {
  if (error === 'timeout') return 'Время выполнения истекло. Проверьте сохранённую историю задачи.';
  if (error === 'mobile-execution-profile-changed') return 'Настройки исполнителя на сервере изменились. Сообщение не было запущено; проверьте настройки перед новой отправкой.';
  if (error.includes('account') || error.includes('auth')) return 'Проверьте подключение аккаунта исполнителя на сервере.';
  return 'Исполнитель не смог завершить запрос. Проверьте историю задачи и состояние сервера.';
}

function commandDetail(command: MobileCommand): string {
  if (command.status === 'unknown') return 'Сервер не может подтвердить результат после перезапуска. Проверьте историю перед новой отправкой; автоматического повтора не будет.';
  if (command.status === 'failed' && command.error) return runtimeErrorText(command.error);
  if (command.status === 'interrupted' && command.error === 'timeout') return runtimeErrorText(command.error);
  return '';
}

function lastUpdatedText(value: number | null): string {
  if (value === null) return 'Ещё не обновлено';
  return `Обновлено в ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(value)}`;
}

function errorIsUnauthorized(error: unknown): boolean {
  return error instanceof MobileApiError && error.status === 401;
}

function mergeCommands(remote: MobileCommand[], local: MobileCommand[]): MobileCommand[] {
  const byId = new Map<string, MobileCommand>();
  for (const command of [...local, ...remote]) byId.set(command.commandId, command);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function isCommandHistoryItem(command: MobileCommand): boolean {
  return command.status === 'completed' || command.status === 'cancelled' || command.status === 'interrupted';
}

function requestController(controllers: Set<AbortController>): { signal: AbortSignal; finish: () => void } {
  const controller = new AbortController();
  controllers.add(controller);
  return { signal: controller.signal, finish: () => controllers.delete(controller) };
}

export function MobileApp({ api = mobileApi }: { api?: MobileApi }) {
  const apiRef = useRef(api);
  apiRef.current = api;
  const tokenRef = useRef('');
  const serverIdRef = useRef('');
  const authEpochRef = useRef(0);
  const selectionEpochRef = useRef(0);
  const selectedTaskRef = useRef('');
  const refreshInFlightRef = useRef(false);
  const refreshAgainRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const pendingSendsRef = useRef<Record<string, PendingSend>>({});
  const pendingInterruptsRef = useRef<Record<string, PendingInterrupt>>({});
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatWasAtBottomRef = useRef(true);
  const autoScrolledTaskRef = useRef('');
  const displayedFeedVersionRef = useRef('');

  const [connected, setConnected] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [workspace, setWorkspace] = useState<MobileWorkspace | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskSnapshot, setTaskSnapshot] = useState<MobileTaskSnapshot | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [drafts, setDrafts] = useState<StringMap>({});
  const [createTitle, setCreateTitle] = useState('');
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend>>({});
  const [sending, setSending] = useState<BooleanMap>({});
  const [localCommands, setLocalCommands] = useState<CommandMap>({});
  const [pendingInterrupts, setPendingInterrupts] = useState<Record<string, PendingInterrupt>>({});
  const [stopping, setStopping] = useState<BooleanMap>({});
  const [canceling, setCanceling] = useState<BooleanMap>({});
  const [cancelErrors, setCancelErrors] = useState<StringMap>({});
  const [actionError, setActionError] = useState('');
  const [taskOptionsOpen, setTaskOptionsOpen] = useState(false);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  const taskOptionsSheetRef = useRef<HTMLElement>(null);
  const taskOptionsButtonRef = useRef<HTMLButtonElement>(null);

  useVisualViewport(Boolean(selectedTaskId));

  useEffect(() => {
    if (!taskOptionsOpen) return;
    taskOptionsSheetRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskOptionsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      taskOptionsButtonRef.current?.focus({ preventScroll: true });
    };
  }, [taskOptionsOpen]);

  const clearPrivateViews = useCallback((message: string) => {
    authEpochRef.current += 1;
    tokenRef.current = '';
    serverIdRef.current = '';
    controllersRef.current.forEach(controller => controller.abort());
    controllersRef.current.clear();
    setConnected(false);
    setConnecting(false);
    setTokenInput('');
    setWorkspace(null);
    setSelectedProjectId('');
    setSelectedTaskId('');
    setTaskOptionsOpen(false);
    selectedTaskRef.current = '';
    selectionEpochRef.current += 1;
    setTaskSnapshot(null);
    setTaskLoading(false);
    setTaskError('');
    setSyncError('');
    setLastUpdated(null);
    setDrafts({});
    setCreateTitle('');
    setPendingCreate(null);
    setCreating(false);
    setCreateError('');
    setPendingSends({});
    pendingSendsRef.current = {};
    setSending({});
    setLocalCommands({});
    setPendingInterrupts({});
    pendingInterruptsRef.current = {};
    setStopping({});
    setCanceling({});
    setCancelErrors({});
    setActionError('');
    setConnectionError(message);
  }, []);

  const invalidateUnauthorized = useCallback((epoch: number) => {
    if (authEpochRef.current === epoch) clearPrivateViews('Срок действия токена завершился. Подключитесь снова.');
  }, [clearPrivateViews]);

  const refreshNow = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || !online || document.visibilityState !== 'visible') return;
    if (refreshInFlightRef.current) {
      refreshAgainRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const authEpoch = authEpochRef.current;
    const selectionEpoch = selectionEpochRef.current;
    const taskId = selectedTaskRef.current;
    const request = requestController(controllersRef.current);
    setTaskLoading(Boolean(taskId && taskSnapshot?.task.id !== taskId));
    const workspacePromise = apiRef.current.getWorkspace(token, request.signal);
    const taskPromise = taskId
      ? apiRef.current.getTask(taskId, token, request.signal)
      : Promise.resolve(null);
    try {
      const [workspaceResult, taskResult] = await Promise.allSettled([workspacePromise, taskPromise]);
      if (authEpoch !== authEpochRef.current || token !== tokenRef.current) return;

      const errors = [workspaceResult, taskResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (errors.some(errorIsUnauthorized)) {
        invalidateUnauthorized(authEpoch);
        return;
      }

      let updated = false;
      if (workspaceResult.status === 'fulfilled') {
        const nextWorkspace = workspaceResult.value;
        const currentServerId = serverIdRef.current;
        if (currentServerId && nextWorkspace.serverId !== currentServerId) {
          clearPrivateViews('Ответ сервера изменился. Введите токен для нового подключения.');
          return;
        }
        serverIdRef.current = nextWorkspace.serverId;
        setWorkspace(nextWorkspace);
        setSelectedProjectId(current => nextWorkspace.projects.some(project => project.id === current)
          ? current
          : nextWorkspace.projects[0]?.id ?? '');
        updated = true;
      }

      if (taskResult.status === 'fulfilled' && taskResult.value
        && taskId === selectedTaskRef.current && selectionEpoch === selectionEpochRef.current) {
        const nextTask = taskResult.value;
        setTaskSnapshot(nextTask);
        setTaskError('');
        const pending = pendingSendsRef.current[taskId];
        if (pending && nextTask.commands.some(command => command.commandId === pending.commandId)) {
          const remaining = omitKey(pendingSendsRef.current, taskId);
          pendingSendsRef.current = remaining;
          setPendingSends(remaining);
          setDrafts(current => current[taskId] === pending.text ? { ...current, [taskId]: '' } : current);
        }
        const remoteCommandIds = new Set(nextTask.commands.map(command => command.commandId));
        setLocalCommands(current => {
          const previous = current[taskId] ?? [];
          const remaining = previous.filter(command => !remoteCommandIds.has(command.commandId));
          return remaining.length === previous.length ? current : { ...current, [taskId]: remaining };
        });
        const pendingStop = pendingInterruptsRef.current[taskId];
        if (pendingStop) {
          const activeTurn = nextTask.task.turns.find(turn => turn.status === 'running');
          const sameRun = nextTask.task.state.pending
            && nextTask.task.state.nativeGeneration === pendingStop.body.expectedGeneration
            && activeTurn?.id === pendingStop.body.expectedTurnId;
          if (!sameRun) {
            const remaining = omitKey(pendingInterruptsRef.current, taskId);
            pendingInterruptsRef.current = remaining;
            setPendingInterrupts(remaining);
          }
        }
        updated = true;
      } else if (taskResult.status === 'rejected'
        && taskId === selectedTaskRef.current && selectionEpoch === selectionEpochRef.current) {
        if (taskResult.reason instanceof MobileApiError && taskResult.reason.status === 404) {
          setTaskSnapshot(null);
          setTaskError(errorText(taskResult.reason, 'refresh'));
        }
      }

      if (updated) setLastUpdated(Date.now());
      const relevantErrors = errors.filter(error => !(error instanceof DOMException && error.name === 'AbortError'));
      setSyncError(relevantErrors.length ? errorText(relevantErrors[0], 'refresh') : '');
      if (taskResult.status === 'rejected' && taskId === selectedTaskRef.current && selectionEpoch === selectionEpochRef.current) {
        setTaskLoading(false);
        if (!(taskResult.reason instanceof MobileApiError && taskResult.reason.status === 404)) {
          setTaskError(errorText(taskResult.reason, 'refresh'));
        }
      }
    } catch (error) {
      if (authEpoch === authEpochRef.current) setSyncError(errorText(error, 'refresh'));
    } finally {
      request.finish();
      if (authEpoch === authEpochRef.current && taskId === selectedTaskRef.current
        && selectionEpoch === selectionEpochRef.current) setTaskLoading(false);
      refreshInFlightRef.current = false;
      if (refreshAgainRef.current) {
        refreshAgainRef.current = false;
          queueMicrotask(() => void refreshRef.current());
      }
    }
  }, [clearPrivateViews, invalidateUnauthorized, online, taskSnapshot]);
  refreshRef.current = refreshNow;

  useEffect(() => {
    const timer = window.setInterval(() => void refreshRef.current(), 1000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshRef.current();
    };
    const updateOnline = () => {
      setOnline(true);
      void refreshRef.current();
    };
    const updateOffline = () => setOnline(false);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOffline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOffline);
    };
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate || connecting) return;
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    tokenRef.current = candidate;
    serverIdRef.current = '';
    setConnecting(true);
    setConnectionError('');
    const request = requestController(controllersRef.current);
    try {
      const nextWorkspace = await apiRef.current.getWorkspace(candidate, request.signal);
      if (epoch !== authEpochRef.current) return;
      if (!nextWorkspace.serverId) throw new MobileApiError(502, 'server-id-missing');
      tokenRef.current = candidate;
      serverIdRef.current = nextWorkspace.serverId;
      setWorkspace(nextWorkspace);
      setConnected(true);
      setSelectedProjectId(nextWorkspace.projects[0]?.id ?? '');
      setSelectedTaskId('');
      selectedTaskRef.current = '';
      setTaskSnapshot(null);
      setLastUpdated(Date.now());
      setTokenInput('');
      setConnectionError('');
      setSyncError('');
    } catch (error) {
      if (epoch !== authEpochRef.current) return;
      tokenRef.current = '';
      serverIdRef.current = '';
      authEpochRef.current += 1;
      if (errorIsUnauthorized(error)) {
        setTokenInput('');
        setConnectionError('Сервер не принял токен. Проверьте его и попробуйте снова.');
      } else {
        setConnectionError(errorText(error, 'connect'));
      }
    } finally {
      request.finish();
      setConnecting(false);
    }
  };

  const disconnect = () => clearPrivateViews('');

  const selectTask = (taskId: string) => {
    selectedTaskRef.current = taskId;
    selectionEpochRef.current += 1;
    setSelectedTaskId(taskId);
    setTaskOptionsOpen(false);
    setTaskSnapshot(null);
    setTaskError('');
    setTaskLoading(true);
    setActionError('');
    void refreshNow();
  };

  const backToTasks = () => {
    selectedTaskRef.current = '';
    selectionEpochRef.current += 1;
    setSelectedTaskId('');
    setTaskOptionsOpen(false);
    setTaskSnapshot(null);
    setTaskError('');
    setActionError('');
  };

  const sendPending = async (pending: PendingSend) => {
    const token = tokenRef.current;
    if (!token) return;
    const epoch = authEpochRef.current;
    setSending(current => ({ ...current, [pending.taskId]: true }));
    setActionError('');
    const request = requestController(controllersRef.current);
    try {
      const receipt: SendMessageReceipt = await apiRef.current.sendMessage(
        pending.taskId,
        token,
        { commandId: pending.commandId, text: pending.text },
        request.signal,
      );
      if (epoch !== authEpochRef.current) return;
      if (receipt.taskId !== pending.taskId || receipt.commandId !== pending.commandId || receipt.status !== 'queued') {
        throw new MobileApiError(502, 'receipt-mismatch');
      }
      if (pendingSendsRef.current[pending.taskId]?.commandId === pending.commandId) {
        const remaining = omitKey(pendingSendsRef.current, pending.taskId);
        pendingSendsRef.current = remaining;
        setPendingSends(remaining);
      }
      setDrafts(current => current[pending.taskId] === pending.text
        ? { ...current, [pending.taskId]: '' }
        : current);
      setLocalCommands(current => ({
        ...current,
        [pending.taskId]: mergeCommands(current[pending.taskId] ?? [], [{
          commandId: pending.commandId,
          taskId: pending.taskId,
          status: 'queued',
          text: pending.text,
          createdAt: new Date().toISOString(),
        }]),
      }));
      void refreshNow();
    } catch (error) {
      if (epoch !== authEpochRef.current) return;
      if (errorIsUnauthorized(error)) invalidateUnauthorized(epoch);
      else setActionError(errorText(error, 'send'));
    } finally {
      request.finish();
      if (epoch === authEpochRef.current) setSending(current => omitKey(current, pending.taskId));
    }
  };

  const beginSend = (event: FormEvent) => {
    event.preventDefault();
    if (!workspace?.capabilities.send || !selectedTaskId) return;
    const current = pendingSends[selectedTaskId];
    if (current) {
      void sendPending(current);
      return;
    }
    const text = drafts[selectedTaskId] ?? '';
    if (!text.trim()) return;
    const pending: PendingSend = { commandId: uuid(), taskId: selectedTaskId, text };
    const nextPending = { ...pendingSendsRef.current, [selectedTaskId]: pending };
    pendingSendsRef.current = nextPending;
    setPendingSends(nextPending);
    void sendPending(pending);
  };

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace?.capabilities.send || !selectedProjectId || creating) return;
    const pending = pendingCreate ?? {
      commandId: uuid(),
      projectId: selectedProjectId,
      title: createTitle.trim(),
    };
    if (!pending.title.trim()) return;
    setPendingCreate(pending);
    setCreating(true);
    setCreateError('');
    const token = tokenRef.current;
    const epoch = authEpochRef.current;
    if (!token) { setCreating(false); return; }
    const request = requestController(controllersRef.current);
    try {
      const receipt: CreateTaskReceipt = await apiRef.current.createTask(
        pending.projectId,
        token,
        { commandId: pending.commandId, title: pending.title },
        request.signal,
      );
      if (epoch !== authEpochRef.current) return;
      if (!receipt.taskId || receipt.commandId !== pending.commandId || receipt.status !== 'created') {
        throw new MobileApiError(502, 'receipt-mismatch');
      }
      setPendingCreate(null);
      setCreateTitle(current => current.trim() === pending.title ? '' : current);
      setSelectedProjectId(pending.projectId);
      selectTask(receipt.taskId);
      void refreshNow();
    } catch (error) {
      if (epoch !== authEpochRef.current) return;
      if (errorIsUnauthorized(error)) invalidateUnauthorized(epoch);
      else setCreateError(errorText(error, 'create'));
    } finally {
      request.finish();
      if (epoch === authEpochRef.current) setCreating(false);
    }
  };

  const stopTask = async (taskId: string) => {
    if (!workspace?.capabilities.interrupt || !taskSnapshot || taskSnapshot.task.id !== taskId) return;
    const previous = pendingInterruptsRef.current[taskId];
    const runningTurn = taskSnapshot.task.turns.find(turn => turn.status === 'running');
    const generation = taskSnapshot.task.state.nativeGeneration;
    const pending: PendingInterrupt | undefined = previous ?? (
      typeof generation === 'number' && runningTurn?.id
        ? { taskId, body: { commandId: uuid(), expectedGeneration: generation, expectedTurnId: runningTurn.id } }
        : undefined
    );
    if (!pending) {
      setActionError('Не удалось определить текущий запуск. Обновите задачу и попробуйте снова.');
      return;
    }
    const nextInterrupts = { ...pendingInterruptsRef.current, [taskId]: pending };
    pendingInterruptsRef.current = nextInterrupts;
    setPendingInterrupts(nextInterrupts);
    setStopping(current => ({ ...current, [taskId]: true }));
    setActionError('');
    const token = tokenRef.current;
    const epoch = authEpochRef.current;
    if (!token) { setStopping(current => omitKey(current, taskId)); return; }
    const request = requestController(controllersRef.current);
    try {
      await apiRef.current.interruptTask(taskId, token, pending.body, request.signal);
      if (epoch !== authEpochRef.current) return;
      if (pendingInterruptsRef.current[taskId]?.body.commandId === pending.body.commandId) {
        const remaining = omitKey(pendingInterruptsRef.current, taskId);
        pendingInterruptsRef.current = remaining;
        setPendingInterrupts(remaining);
      }
      void refreshNow();
    } catch (error) {
      if (epoch !== authEpochRef.current) return;
      if (errorIsUnauthorized(error)) invalidateUnauthorized(epoch);
      else setActionError(errorText(error, 'stop'));
    } finally {
      request.finish();
      if (epoch === authEpochRef.current) setStopping(current => omitKey(current, taskId));
    }
  };

  const cancelCommand = async (command: MobileCommand) => {
    if ((command.status !== 'queued' && command.status !== 'dispatching') || canceling[command.commandId]) return;
    const token = tokenRef.current;
    if (!token) return;
    const epoch = authEpochRef.current;
    setCanceling(current => ({ ...current, [command.commandId]: true }));
    setCancelErrors(current => omitKey(current, command.commandId));
    const request = requestController(controllersRef.current);
    try {
      await apiRef.current.cancelCommand(command.commandId, token, request.signal);
      if (epoch !== authEpochRef.current) return;
      setLocalCommands(current => ({
        ...current,
        [command.taskId]: (current[command.taskId] ?? []).map(item => item.commandId === command.commandId
          ? { ...item, status: 'cancelled' }
          : item),
      }));
      void refreshNow();
    } catch (error) {
      if (epoch !== authEpochRef.current) return;
      if (errorIsUnauthorized(error)) invalidateUnauthorized(epoch);
      else setCancelErrors(current => ({ ...current, [command.commandId]: errorText(error, 'cancel') }));
    } finally {
      request.finish();
      if (epoch === authEpochRef.current) setCanceling(current => omitKey(current, command.commandId));
    }
  };

  const updateTaskAccess = async (body: AccessChangeRequest) => {
    const taskId = selectedTaskRef.current;
    const token = tokenRef.current;
    if (!token || !taskSnapshot || taskSnapshot.task.id !== taskId || !workspace?.capabilities.changeAccessMode) {
      throw new MobileApiError(409, 'access-change-unavailable');
    }
    const epoch = authEpochRef.current;
    const selection = selectionEpochRef.current;
    const request = requestController(controllersRef.current);
    try {
      const receipt = await apiRef.current.setAccessMode(taskId, token, body, request.signal);
      if (epoch !== authEpochRef.current) throw new DOMException('Connection changed', 'AbortError');
      if (receipt.taskId !== taskId || receipt.commandId !== body.commandId || receipt.accessMode !== body.accessMode) {
        throw new MobileApiError(502, 'access-receipt-mismatch');
      }
      if (selectedTaskRef.current === taskId && selection === selectionEpochRef.current) {
        // Fence a snapshot started before the permission transaction, then read
        // the actual saved task rather than guessing its post-update state.
        selectionEpochRef.current += 1;
        const refreshedSelection = selectionEpochRef.current;
        const savedTask = await apiRef.current.getTask(taskId, token, request.signal);
        if (savedTask.task.revision < receipt.revision) throw new MobileApiError(502, 'access-snapshot-stale');
        if (epoch === authEpochRef.current && selectedTaskRef.current === taskId
          && refreshedSelection === selectionEpochRef.current) setTaskSnapshot(savedTask);
      }
      void refreshRef.current();
      return receipt;
    } catch (cause) {
      if (errorIsUnauthorized(cause)) invalidateUnauthorized(epoch);
      throw cause;
    } finally {
      request.finish();
    }
  };

  const visibleTasks = useMemo(() => workspace?.tasks.filter(task =>
    task.projectId === selectedProjectId && !task.archived && !task.deletedAt,
  ) ?? [], [workspace, selectedProjectId]);
  const selectedTask = workspace?.tasks.find(task => task.id === selectedTaskId);
  const currentDraft = selectedTaskId ? drafts[selectedTaskId] ?? '' : '';
  const currentPendingSend = selectedTaskId ? pendingSends[selectedTaskId] : undefined;
  const currentPendingStop = selectedTaskId ? pendingInterrupts[selectedTaskId] : undefined;
  const commands = taskSnapshot
    ? mergeCommands(taskSnapshot.commands, localCommands[taskSnapshot.task.id] ?? [])
    : [];
  const messages = taskSnapshot?.task.messages ?? [];
  const feedVersion = useMemo(() => {
    const last = messages[messages.length - 1];
    return last
      ? `${messages.length}\u0000${last.id}\u0000${last.kind}\u0000${last.text?.length ?? 0}:${last.text?.slice(-160) ?? ''}\u0000${last.reasoning?.length ?? 0}:${last.reasoning?.slice(-80) ?? ''}\u0000${last.status ?? ''}`
      : '0';
  }, [messages]);

  useLayoutEffect(() => {
    if (!selectedTaskId) {
      autoScrolledTaskRef.current = '';
      displayedFeedVersionRef.current = '';
      chatWasAtBottomRef.current = true;
      setHasUnreadBelow(false);
      return;
    }
    if (!taskSnapshot || taskSnapshot.task.id !== selectedTaskId) return;
    const panel = chatScrollRef.current;
    if (!panel) return;
    const firstLoad = autoScrolledTaskRef.current !== selectedTaskId;
    const feedChanged = displayedFeedVersionRef.current !== feedVersion;
    if (firstLoad || (feedChanged && chatWasAtBottomRef.current)) {
      panel.scrollTop = panel.scrollHeight;
      chatWasAtBottomRef.current = true;
      setHasUnreadBelow(false);
    } else if (feedChanged && !chatWasAtBottomRef.current) {
      setHasUnreadBelow(true);
    }
    autoScrolledTaskRef.current = selectedTaskId;
    displayedFeedVersionRef.current = feedVersion;
  }, [selectedTaskId, taskSnapshot, feedVersion]);
  const showQueuedText = (command: MobileCommand) => Boolean(command.text)
    && (command.status === 'queued' || command.status === 'unknown')
    && !taskSnapshot?.task.messages.some(message => message.kind === 'user' && message.text === command.text);
  const runningTurn = taskSnapshot?.task.turns.find(turn => turn.status === 'running');
  const canStop = Boolean(workspace?.capabilities.interrupt && taskSnapshot?.task.state.pending && runningTurn?.id && typeof taskSnapshot.task.state.nativeGeneration === 'number');
  const runtimeError = taskSnapshot?.task.state.error || selectedTask?.error || '';
  const activeCommands = commands.filter(command => !isCommandHistoryItem(command));
  const commandHistory = commands.filter(isCommandHistoryItem);

  return (
    <div className={`mobile-shell${connected && selectedTaskId ? ' mobile-shell-chat' : ''}`}>
      <header className="topbar">
        {connected
          ? <button className="brand brand-button" type="button" onClick={() => selectedTaskId ? backToTasks() : void refreshNow()} aria-label="Aplot Mobile — список задач">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span>Aplot</span><small>mobile</small>
          </button>
          : <a className="brand" href="/mobile/" aria-label="Aplot Mobile — главная">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span>Aplot</span><small>mobile</small>
          </a>}
        {connected && <div className="topbar-actions">
          <span className="server-pill" title={`Сервер ${window.location.host}`}>{window.location.host}</span>
          <button className="quiet-button disconnect-button" type="button" onClick={disconnect}>Отключить</button>
        </div>}
      </header>

      {!connected ? (
        <main className="connect-layout">
          <section className="connect-card" aria-labelledby="connect-title">
            <div className="eyebrow"><span className="online-dot" /> ЛИЧНОЕ ПОДКЛЮЧЕНИЕ</div>
            <h1 id="connect-title">Задачи всегда под рукой.</h1>
            <p className="connect-copy">Введите ключ доступа вашего Aplot-сервера. Ключ не сохраняется и исчезнет после закрытия вкладки.</p>
            <form className="connect-form" onSubmit={connect}>
              <label htmlFor="access-token">Ключ доступа</label>
              <input
                id="access-token"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                type="password"
                value={tokenInput}
                onChange={event => setTokenInput(event.currentTarget.value)}
                placeholder="Вставьте ключ доступа"
                aria-describedby={connectionError ? 'connect-error' : 'token-help'}
              />
              <p id="token-help" className="field-help">Ключ останется только в памяти вкладки. После закрытия подключитесь снова.</p>
              {connectionError && <p id="connect-error" className="error-message" role="alert">{connectionError}</p>}
              <button className="primary-button connect-submit" type="submit" disabled={!tokenInput.trim() || connecting}>
                {connecting ? <><span className="button-spinner" aria-hidden="true" /> Подключаемся…</> : 'Подключиться'}
              </button>
            </form>
            <div className="privacy-note"><span aria-hidden="true">◈</span><span>История задач не сохраняется на телефоне. Для установки приложения используйте HTTPS.</span></div>
          </section>
          <p className="connect-footer">Aplot · ваши проекты и агенты</p>
        </main>
      ) : (
        <>
          <div className="sync-strip" aria-live="polite">
            <div className="sync-status">
              <span className={`online-dot ${online ? '' : 'offline-dot'}`} />
              <strong>{online ? 'Подключено' : 'Нет сети'}</strong>
              <span className="sync-divider">·</span>
              <span>{lastUpdatedText(lastUpdated)}</span>
            </div>
            <button className="icon-button refresh-button" type="button" onClick={() => void refreshNow()} aria-label="Обновить данные" title="Обновить">
              <span aria-hidden="true">↻</span>
            </button>
          </div>
          {!selectedTaskId && !online && <div className="notice-banner" role="status">Нет сети. После восстановления подключения данные обновятся автоматически.</div>}
          {!selectedTaskId && syncError && <div className="notice-banner notice-error" role="status">{syncError}</div>}

          {selectedTaskId ? (
            <main className="chat-screen">
              <div className="chat-heading">
                <button className="back-button" type="button" onClick={backToTasks} aria-label="Вернуться к списку задач"><span aria-hidden="true">‹</span></button>
                <div className="chat-title-wrap">
                  <h1>{selectedTask?.title ?? taskSnapshot?.metadata.title ?? 'Задача'}</h1>
                </div>
                {canStop ? <button className="stop-button" type="button" disabled={Boolean(stopping[selectedTaskId])} onClick={() => void stopTask(selectedTaskId)}>
                  {stopping[selectedTaskId] ? 'Останавливаем…' : 'Стоп'}
                </button> : selectedTask && <span className={`task-state-pill ${selectedTask.pending ? 'task-state-active' : ''}`}>{statusText(selectedTask)}</span>}
                <button ref={taskOptionsButtonRef} className="icon-button task-options-button" type="button" aria-label="Параметры задачи" aria-haspopup="dialog" aria-expanded={taskOptionsOpen} onClick={() => setTaskOptionsOpen(true)}>
                  <span aria-hidden="true">⋯</span>
                </button>
              </div>
              <div className="chat-scroll" ref={chatScrollRef} onScroll={event => {
                const panel = event.currentTarget;
                const isAtBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 36;
                chatWasAtBottomRef.current = isAtBottom;
                if (isAtBottom) setHasUnreadBelow(false);
              }} aria-live="polite" aria-relevant="additions text">
                {!online && <div className="notice-banner" role="status">Нет сети. После восстановления подключения данные обновятся автоматически.</div>}
                {syncError && <div className="notice-banner notice-error" role="status">{syncError}</div>}
                {(taskError || actionError) && <div className="notice-banner notice-error" role="alert">{taskError || actionError}</div>}
                {runtimeError && <div className="notice-banner notice-error" role="status">{runtimeErrorText(runtimeError)}</div>}
                <MessageFeed messages={messages} loading={taskLoading} error={taskError} pending={Boolean(taskSnapshot?.task.state.pending || taskSnapshot?.task.state.starting)} />
                {activeCommands.length > 0 && <section className="command-list" aria-label="Текущие отправки">
                  {activeCommands.map(command => <div className="command-entry" key={command.commandId}>
                    <div className="command-row">
                      <span className={`command-dot command-${command.status}`} aria-hidden="true" />
                      <span>{commandStatusText(command.status)}</span>
                      {(command.status === 'queued' || command.status === 'dispatching') && <button type="button" className="text-button" disabled={Boolean(canceling[command.commandId])} onClick={() => void cancelCommand(command)}>
                        {canceling[command.commandId] ? 'Отменяем…' : cancelErrors[command.commandId] ? 'Повторить отмену' : 'Отменить'}
                      </button>}
                      {cancelErrors[command.commandId] && <span className="command-error">{cancelErrors[command.commandId]}</span>}
                    </div>
                    {commandDetail(command) && <p className="command-error-detail">{commandDetail(command)}</p>}
                    {showQueuedText(command) && <div className="queued-prompt"><span>Сообщение</span><p>{command.text}</p></div>}
                  </div>)}
                </section>}
                {commandHistory.length > 0 && <details className="command-history">
                  <summary>История отправок · {commandHistory.length}</summary>
                  <div className="command-list" aria-label="История отправок">
                    {commandHistory.map(command => <div className="command-entry" key={command.commandId}>
                      <div className="command-row"><span className={`command-dot command-${command.status}`} aria-hidden="true" /><span>{commandStatusText(command.status)}</span></div>
                    </div>)}
                  </div>
                </details>}
              </div>
              {hasUnreadBelow && <button className="latest-message-button" type="button" onClick={() => {
                const panel = chatScrollRef.current;
                if (panel) panel.scrollTop = panel.scrollHeight;
                chatWasAtBottomRef.current = true;
                setHasUnreadBelow(false);
              }}>К последнему <span aria-hidden="true">↓</span></button>}
              {currentPendingSend && <div className="retry-card" role="status">
                <div><strong>Отправка не подтверждена</strong><p>Сервер мог уже принять сообщение. Повторная попытка не отправит его дважды.</p><blockquote>{currentPendingSend.text}</blockquote></div>
                <button className="secondary-button" type="button" disabled={Boolean(sending[selectedTaskId])} onClick={() => void sendPending(currentPendingSend)}>
                  {sending[selectedTaskId] ? 'Повторяем…' : 'Повторить'}
                </button>
              </div>}
              <form className="composer" onSubmit={beginSend}>
                <label className="sr-only" htmlFor="message-draft">Сообщение для задачи</label>
                <textarea
                  id="message-draft"
                  inputMode="text"
                  rows={2}
                  value={currentDraft}
                  onChange={event => {
                    const taskId = selectedTaskId;
                    const value = event.currentTarget.value;
                    if (taskId) setDrafts(current => ({ ...current, [taskId]: value }));
                  }}
                  placeholder={workspace?.capabilities.send ? 'Напишите сообщение…' : 'Отправка недоступна'}
                  disabled={!workspace?.capabilities.send}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <button className="send-button" type="submit" disabled={!workspace?.capabilities.send || !currentDraft.trim() || Boolean(currentPendingSend) || Boolean(sending[selectedTaskId])} aria-label="Отправить сообщение">
                  <span aria-hidden="true">↑</span>
                </button>
                <span className="composer-hint">Ctrl/⌘ + Enter</span>
              </form>
              {!workspace?.capabilities.send && <p className="capability-note">Сервер не принимает новые сообщения в этой сессии.</p>}
              {taskOptionsOpen && <div className="task-options-backdrop">
                <button className="task-options-scrim" type="button" tabIndex={-1} aria-label="Закрыть параметры задачи" onClick={() => setTaskOptionsOpen(false)} />
                <section ref={taskOptionsSheetRef} className="task-options-sheet" role="dialog" aria-modal="true" aria-labelledby="task-options-title" onKeyDown={event => {
                  if (event.key !== 'Tab') return;
                  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')];
                  const first = controls[0];
                  const last = controls.at(-1);
                  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }}>
                  <div className="task-options-heading">
                    <h2 id="task-options-title">Параметры задачи</h2>
                    <button className="icon-button" type="button" aria-label="Закрыть параметры задачи" onClick={() => setTaskOptionsOpen(false)}>×</button>
                  </div>
                  <p className="task-options-connection"><span className={`online-dot ${online ? '' : 'offline-dot'}`} />{online ? 'Подключено' : 'Нет сети'} · {window.location.host}</p>
                  {canStop && <button className="stop-button task-options-stop" type="button" disabled={Boolean(stopping[selectedTaskId])} onClick={() => void stopTask(selectedTaskId)}>
                    {stopping[selectedTaskId] ? 'Останавливаем…' : currentPendingStop ? 'Повторить остановку' : 'Остановить задачу'}
                  </button>}
                  {workspace?.capabilities.changeAccessMode && taskSnapshot && <div className="task-options-access-slot" data-mobile-access-controls-slot>
                    <TaskAccessControl
                      key={taskSnapshot.task.id}
                      taskId={taskSnapshot.task.id}
                      accessMode={taskSnapshot.metadata.accessMode ?? 'restricted'}
                      revision={taskSnapshot.task.revision}
                      busy={taskSnapshot.task.state.pending || taskSnapshot.task.state.starting || taskSnapshot.task.state.live || commands.some(command => ['queued', 'dispatching', 'cancel_requested'].includes(command.status))}
                      allowedModes={workspace.capabilities.allowedAccessModes ?? ['restricted']}
                      onApply={updateTaskAccess}
                      onRefresh={() => void refreshRef.current()}
                    />
                  </div>}
                  <button className="task-options-action" type="button" onClick={() => void refreshNow()}><span aria-hidden="true">↻</span> Обновить данные</button>
                  <p className="task-options-updated">{lastUpdatedText(lastUpdated)}</p>
                  <button className="task-options-action task-options-disconnect" type="button" onClick={disconnect}>Отключиться</button>
                </section>
              </div>}
            </main>
          ) : (
            <main className="home-screen">
              <section className="home-heading">
                <div><p className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p><h1>Проекты и задачи</h1></div>
                <span className="model-pill">{workspace?.model || 'Aplot'}</span>
              </section>
              <section className="project-picker">
                <label htmlFor="project-select">Проект</label>
                <select id="project-select" value={selectedProjectId} onChange={event => setSelectedProjectId(event.currentTarget.value)} disabled={!workspace?.projects.length}>
                  {workspace?.projects.length
                    ? workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)
                    : <option value="">Нет проектов</option>}
                </select>
              </section>
              <section className="task-section" aria-labelledby="task-list-title">
                <div className="section-heading"><h2 id="task-list-title">Задачи</h2><span>{visibleTasks.length}</span></div>
                {visibleTasks.length === 0
                  ? <div className="empty-task-card"><span aria-hidden="true">✦</span><p>В этом проекте пока нет активных задач.</p></div>
                  : <div className="task-list">{visibleTasks.map(task => <TaskCard key={task.id} task={task} onSelect={() => selectTask(task.id)} />)}</div>}
              </section>
              {pendingCreate && <div className="retry-card create-retry" role="status">
                <div><strong>Создание не подтверждено</strong><p>«{pendingCreate.title}» · сервер мог уже создать эту задачу.</p></div>
                <button className="secondary-button" type="button" disabled={creating} onClick={() => {
                  const synthetic = { preventDefault() {} } as FormEvent;
                  void createTask(synthetic);
                }}>{creating ? 'Повторяем…' : 'Повторить'}</button>
              </div>}
              {createError && <p className="error-message" role="alert">{createError}</p>}
              <form className="new-task-form" onSubmit={createTask}>
                <label htmlFor="new-task-title">Новая задача</label>
                <div className="new-task-row">
                  <input
                    id="new-task-title"
                    value={createTitle}
                    onChange={event => setCreateTitle(event.currentTarget.value)}
                    placeholder="Например, проверить сборку"
                    maxLength={120}
                    disabled={!workspace?.capabilities.send || Boolean(pendingCreate)}
                  />
                  <button className="primary-button" type="submit" disabled={!workspace?.capabilities.send || !selectedProjectId || !createTitle.trim() || Boolean(pendingCreate) || creating}>
                    {creating ? 'Создаём…' : 'Создать'}
                  </button>
                </div>
                {pendingCreate && <p className="field-help">Дождитесь ответа или повторите запрос выше.</p>}
              </form>
            </main>
          )}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, onSelect }: { task: MobileTask; onSelect: () => void }) {
  return (
    <button className="task-card" type="button" onClick={onSelect} aria-label={`Открыть задачу ${task.title}`}>
      <span className={`task-card-status ${task.pending ? 'task-card-status-active' : ''}`} aria-hidden="true" />
      <span className="task-card-copy"><strong>{task.title}</strong><span>{task.runtime} · {statusText(task)}</span></span>
      <span className="task-card-chevron" aria-hidden="true">›</span>
    </button>
  );
}
