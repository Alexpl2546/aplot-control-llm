import type {
  CreateTaskReceipt,
  MobileTaskSnapshot,
  MobileWorkspace,
  SendMessageReceipt,
  MobileAccessMode,
  MobileAccessReceipt,
} from './types';

export class MobileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'MobileApiError';
  }
}

export interface InterruptRequest {
  commandId: string;
  expectedGeneration: number;
  expectedTurnId: string;
}

type Fetcher = typeof fetch;

/** Same-origin REST client. It accepts a token per call and never stores it. */
export class MobileApi {
  private readonly fetcher: Fetcher;
  private readonly getOrigin: () => string;

  constructor(fetcher?: Fetcher, getOrigin?: () => string) {
    this.fetcher = fetcher ?? ((input, init) => window.fetch(input, init));
    this.getOrigin = getOrigin ?? (() => window.location.origin);
  }

  getWorkspace(token: string, signal?: AbortSignal): Promise<MobileWorkspace> {
    return this.request('/workspace', token, { method: 'GET', signal }, isMobileWorkspace);
  }

  getTask(taskId: string, token: string, signal?: AbortSignal): Promise<MobileTaskSnapshot> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`, token, { method: 'GET', signal }, isMobileTaskSnapshot);
  }

  createTask(
    projectId: string,
    token: string,
    body: { commandId: string; title: string },
    signal?: AbortSignal,
  ): Promise<CreateTaskReceipt> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/tasks`, token, {
      method: 'POST',
      body,
      signal,
    }, isCreateTaskReceipt);
  }

  sendMessage(
    taskId: string,
    token: string,
    body: { commandId: string; text: string },
    signal?: AbortSignal,
  ): Promise<SendMessageReceipt> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/messages`, token, {
      method: 'POST',
      body,
      expectedStatus: 202,
      signal,
    }, isSendMessageReceipt);
  }

  cancelCommand(commandId: string, token: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/commands/${encodeURIComponent(commandId)}/cancel`, token, {
      method: 'POST',
      body: {},
      signal,
    }, isAnyValue);
  }

  interruptTask(
    taskId: string,
    token: string,
    body: InterruptRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/interrupt`, token, {
      method: 'POST',
      body,
      signal,
    }, isAnyValue);
  }

  setAccessMode(
    taskId: string,
    token: string,
    body: { commandId: string; expectedRevision: number; accessMode: MobileAccessMode },
    signal?: AbortSignal,
  ): Promise<MobileAccessReceipt> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/access`, token, {
      method: 'POST', body, signal,
    }, isMobileAccessReceipt);
  }

  private async request<T>(
    path: string,
    token: string,
    options: {
      method: 'GET' | 'POST';
      body?: object;
      expectedStatus?: number;
      signal?: AbortSignal;
    },
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    const cleanToken = token.trim();
    if (!cleanToken || /[\r\n]/.test(cleanToken)) {
      throw new MobileApiError(0, 'token-invalid');
    }

    const origin = this.getOrigin();
    const url = new URL(`/api/v1${path}`, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/v1/')) {
      throw new MobileApiError(0, 'same-origin-required');
    }

    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${cleanToken}`,
    });
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12_000);
    try {
      const response = await this.fetcher(url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
        mode: 'same-origin',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        // WebKit serializes Origin as null for same-origin POSTs under the
        // shell's no-referrer policy. Keep the real origin on private API
        // calls while retaining no-referrer for external links/navigation.
        referrerPolicy: 'same-origin',
      });
      if (response.status === 401) {
        throw new MobileApiError(401, await readErrorCode(response));
      }
      if (!response.ok) {
        throw new MobileApiError(response.status, await readErrorCode(response));
      }
      if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
        throw new MobileApiError(response.status, 'unexpected-response-status');
      }
      if (response.status === 204) {
        if (options.method === 'POST' && options.expectedStatus === undefined) return undefined as T;
        throw new MobileApiError(response.status, 'response-invalid');
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new MobileApiError(response.status, 'response-invalid');
      }
      if (!validate(value)) throw new MobileApiError(response.status, 'response-invalid');
      return value;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      if (options.signal?.aborted && error instanceof DOMException && error.name === 'AbortError') throw error;
      if (timedOut) throw new MobileApiError(0, 'request-timeout');
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new MobileApiError(0, 'network-unavailable');
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isAccessMode(value: unknown): value is MobileAccessMode {
  return value === 'restricted' || value === 'full';
}

function isMobileWorkspace(value: unknown): value is MobileWorkspace {
  if (!isRecord(value) || !isString(value.serverId) || !Array.isArray(value.projects)
    || !Array.isArray(value.tasks) || !isRecord(value.capabilities) || !isString(value.model)
    || typeof value.capabilities.send !== 'boolean' || typeof value.capabilities.interrupt !== 'boolean'
    || (value.capabilities.changeAccessMode !== undefined && typeof value.capabilities.changeAccessMode !== 'boolean')
    || (value.capabilities.allowedAccessModes !== undefined && (!Array.isArray(value.capabilities.allowedAccessModes) || !value.capabilities.allowedAccessModes.every(isAccessMode)))) return false;
  return value.projects.every(project => isRecord(project) && isString(project.id) && isString(project.name))
    && value.tasks.every(task => isRecord(task)
      && isString(task.id) && isString(task.projectId) && isString(task.title) && isString(task.runtime)
      && typeof task.pending === 'boolean' && typeof task.starting === 'boolean' && typeof task.ended === 'boolean'
      && isString(task.error)
      && (task.accessMode === undefined || isAccessMode(task.accessMode))
      && (task.archived === undefined || typeof task.archived === 'boolean')
      && (task.deletedAt === undefined || task.deletedAt === null || typeof task.deletedAt === 'number'));
}

const COMMAND_STATUSES = new Set(['queued', 'dispatching', 'cancel_requested', 'completed', 'failed', 'interrupted', 'cancelled', 'unknown']);
const TURN_STATUSES = new Set(['queued', 'running', 'completed', 'interrupted', 'failed', 'cancelled']);

function isMobileAccessReceipt(value: unknown): value is MobileAccessReceipt {
  return isRecord(value) && isString(value.commandId) && isString(value.taskId)
    && value.status === 'updated' && isAccessMode(value.accessMode)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
}

function isMobileTaskSnapshot(value: unknown): value is MobileTaskSnapshot {
  if (!isRecord(value) || typeof value.cursor !== 'number' || !isRecord(value.task)
    || !isRecord(value.task.state) || !isRecord(value.metadata)
    || !Array.isArray(value.task.messages) || !Array.isArray(value.task.turns) || !Array.isArray(value.commands)) return false;
  const task = value.task as Record<string, unknown>;
  const state = task.state as Record<string, unknown>;
  const messages = task.messages as unknown[];
  const turns = task.turns as unknown[];
  const metadata = value.metadata as Record<string, unknown>;
  return isString(task.id) && isString(task.runtime) && typeof task.revision === 'number'
    && typeof state.pending === 'boolean' && typeof state.starting === 'boolean'
    && typeof state.ended === 'boolean' && typeof state.stopped === 'boolean'
    && isString(state.error) && typeof state.live === 'boolean'
    && (state.nativeGeneration === undefined || state.nativeGeneration === null || typeof state.nativeGeneration === 'number')
    && messages.every(message => isRecord(message) && isString(message.id) && isString(message.kind))
    && turns.every(turn => isRecord(turn) && isString(turn.id) && isString(turn.status) && TURN_STATUSES.has(turn.status))
    && value.commands.every(command => isRecord(command)
      && isString(command.commandId) && isString(command.taskId)
      && isString(command.status) && COMMAND_STATUSES.has(command.status)
      && isString(command.createdAt) && (command.text === undefined || isString(command.text))
      && (command.error === undefined || command.error === null || isString(command.error))
      && (command.kind === undefined || isString(command.kind))
      && (command.cancelRequested === undefined || typeof command.cancelRequested === 'boolean'))
    && isString(metadata.id) && isString(metadata.title)
    && isString(metadata.projectId) && isString(metadata.runtime)
    && (metadata.accessMode === undefined || isAccessMode(metadata.accessMode));
}

function isCreateTaskReceipt(value: unknown): value is CreateTaskReceipt {
  return isRecord(value) && isString(value.taskId) && isString(value.commandId) && value.status === 'created';
}

function isSendMessageReceipt(value: unknown): value is SendMessageReceipt {
  return isRecord(value) && isString(value.commandId) && isString(value.taskId) && value.status === 'queued';
}

function isAnyValue(_value: unknown): _value is unknown {
  return true;
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && 'error' in value) {
      const error = (value as { error?: unknown }).error;
      if (typeof error === 'string' && /^[a-z0-9-]{1,80}$/.test(error)) return error;
    }
  } catch {
    // Keep response bodies out of the UI and never include credentials in errors.
  }
  return response.status === 401 ? 'unauthorized' : 'request-failed';
}

export const mobileApi = new MobileApi();
