import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listMcpConnections, removeMcpConnection, saveMcpConnection } from '../src/services/mcpConnections';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));

it('uses project-scoped native commands and receives summaries without secret values', async () => {
  const summary = { id: 'remote', enabled: true, transport: 'http', command: null, args: [], url: 'https://mcp.example.test/mcp', hasBearerToken: true, updatedAt: '2026-11-02T00:00:00Z' };
  vi.mocked(invoke).mockResolvedValueOnce([summary]).mockResolvedValueOnce(summary).mockResolvedValueOnce(undefined);
  expect(await listMcpConnections('project-a')).toEqual([summary]);
  expect(await saveMcpConnection('project-a', { id: 'remote', enabled: true, transport: 'http', url: summary.url, bearerToken: 'write-only-token' })).toEqual(summary);
  await removeMcpConnection('project-a', 'remote');
  expect(invoke).toHaveBeenNthCalledWith(1, 'mcp_connections_list', { projectId: 'project-a' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'mcp_connections_save', { projectId: 'project-a', config: { id: 'remote', enabled: true, transport: 'http', url: summary.url, bearerToken: 'write-only-token' } });
  expect(invoke).toHaveBeenNthCalledWith(3, 'mcp_connections_remove', { projectId: 'project-a', id: 'remote' });
  expect(summary).not.toHaveProperty('bearerToken');
});
