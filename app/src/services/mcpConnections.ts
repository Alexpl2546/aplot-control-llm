import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export type McpTransport = 'stdio' | 'http';

/** A status view. Secret values never cross the native IPC boundary. */
export interface McpConnectionSummary {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  hasBearerToken: boolean;
  updatedAt: string;
}

/** Save request. `bearerToken` is write-only; a blank value keeps an existing token. */
export interface McpConnectionInput {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  bearerToken?: string;
  clearBearerToken?: boolean;
}

export async function listMcpConnections(projectId: string): Promise<McpConnectionSummary[]> {
  if (!isTauri()) return [];
  return invoke<McpConnectionSummary[]>('mcp_connections_list', { projectId });
}

export async function saveMcpConnection(projectId: string, config: McpConnectionInput): Promise<McpConnectionSummary> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke<McpConnectionSummary>('mcp_connections_save', { projectId, config });
}

export async function removeMcpConnection(projectId: string, id: string): Promise<void> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke<void>('mcp_connections_remove', { projectId, id });
}
