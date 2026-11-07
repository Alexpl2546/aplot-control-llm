export interface MobileProject {
  id: string;
  name: string;
}

export type MobileAccessMode = 'restricted' | 'full';

export interface MobileAccessReceipt {
  commandId: string;
  taskId: string;
  status: 'updated';
  accessMode: MobileAccessMode;
  revision: number;
}

export interface MobileTask {
  id: string;
  projectId: string;
  title: string;
  runtime: string;
  pending: boolean;
  starting: boolean;
  ended: boolean;
  error: string;
  accessMode?: MobileAccessMode;
  archived?: boolean;
  deletedAt?: number | null;
}

export interface MobileWorkspace {
  serverId: string;
  projects: MobileProject[];
  tasks: MobileTask[];
  capabilities: {
    send: boolean;
    interrupt: boolean;
    changeAccessMode?: boolean;
    allowedAccessModes?: MobileAccessMode[];
  };
  model: string;
}

export type MobileCommandStatus =
  | 'queued'
  | 'dispatching'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'unknown';

export interface MobileCommand {
  commandId: string;
  taskId: string;
  status: MobileCommandStatus;
  error?: string | null;
  kind?: string;
  cancelRequested?: boolean;
  text?: string;
  createdAt: string;
}

export interface MobileMessage {
  id: string;
  kind: string;
  text?: string;
  reasoning?: string;
  name?: string;
  status?: string;
  result?: unknown;
  args?: unknown;
  time?: number | string;
}

export type MobileTurnStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export interface MobileTurn {
  id: string;
  taskId: string;
  status: MobileTurnStatus;
  commandId?: string | null;
  nativeTurnId?: string | null;
  text?: string;
  error?: string | null;
  time?: number | null;
}

export interface MobileTaskState {
  pending: boolean;
  starting: boolean;
  ended: boolean;
  stopped: boolean;
  error: string;
  ioError?: string | null;
  live: boolean;
  nativeSessionId?: string | null;
  nativeGeneration?: number | null;
}

export interface MobileHostTaskView {
  id: string;
  runtime: string;
  revision: number;
  state: MobileTaskState;
  messages: MobileMessage[];
  turns: MobileTurn[];
  approvals?: Array<{ id: string; method: string; status: string }>;
}

export interface MobileTaskMetadata {
  id: string;
  title: string;
  projectId: string;
  runtime: string;
  accessMode?: MobileAccessMode;
}

export interface MobileTaskSnapshot {
  cursor: number;
  task: MobileHostTaskView;
  commands: MobileCommand[];
  metadata: MobileTaskMetadata;
}

export interface CreateTaskReceipt {
  taskId: string;
  commandId: string;
  status: 'created';
}

export interface SendMessageReceipt {
  commandId: string;
  taskId: string;
  status: 'queued';
}
