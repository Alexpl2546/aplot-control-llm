// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listMcpConnections, removeMcpConnection, saveMcpConnection, type McpConnectionSummary } from '../src/services/mcpConnections';
import { McpConnectionsPanel } from '../src/features/agent/McpConnectionsPanel';

vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));
vi.mock('../src/services/mcpConnections', () => ({
  listMcpConnections: vi.fn(),
  removeMcpConnection: vi.fn(),
  saveMcpConnection: vi.fn(),
}));
vi.mock('../src/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, confirmLabel, onConfirm }: { open: boolean; confirmLabel: string; onConfirm: () => void }) => open
    ? <div role="dialog"><button type="button" onClick={onConfirm}>{confirmLabel}</button></div>
    : null,
}));

const remote: McpConnectionSummary = {
  id: 'remote-docs', enabled: true, transport: 'http', command: null, args: [],
  url: 'https://mcp.example.test/mcp', hasBearerToken: true, updatedAt: '2026-11-02T00:00:00Z',
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('saves stdio arguments as separate lines and explains new-session behavior', async () => {
  vi.mocked(listMcpConnections).mockResolvedValue([]);
  vi.mocked(saveMcpConnection).mockResolvedValue({ ...remote, id: 'docs', transport: 'stdio', command: 'node', args: ['-y', '@example/mcp-server'], url: null, hasBearerToken: false });
  render(<McpConnectionsPanel projectId="project-a"/>);
  fireEvent.change(screen.getByLabelText('Resource ID'), { target: { value: 'docs' } });
  fireEvent.change(screen.getByLabelText('Executable command'), { target: { value: 'node' } });
  fireEvent.change(screen.getByLabelText('Arguments (one per line)'), { target: { value: '-y\n@example/mcp-server' } });
  expect(screen.getByText(/Changes apply to new sessions/)).toBeTruthy();
  expect(screen.getByText(/No shell command parsing is used/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() => expect(saveMcpConnection).toHaveBeenCalledWith('project-a', {
    id: 'docs', enabled: true, transport: 'stdio', command: 'node', args: ['-y', '@example/mcp-server'],
  }));
});

it('shows that a token is stored without revealing it and preserves a blank edit', async () => {
  vi.mocked(listMcpConnections).mockResolvedValue([remote]);
  vi.mocked(saveMcpConnection).mockResolvedValue(remote);
  render(<McpConnectionsPanel projectId="project-b"/>);
  expect(await screen.findByText('API token stored securely')).toBeTruthy();
  expect(screen.getByText('remote-docs')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const token = screen.getByLabelText('API token (optional)') as HTMLInputElement;
  expect(token.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() => expect(saveMcpConnection).toHaveBeenCalledWith('project-b', {
    id: 'remote-docs', enabled: true, transport: 'http', url: remote.url, clearBearerToken: false,
  }));
});

it('removes only the selected project configuration', async () => {
  vi.mocked(listMcpConnections).mockResolvedValue([remote]);
  vi.mocked(removeMcpConnection).mockResolvedValue(undefined);
  render(<McpConnectionsPanel projectId="project-c"/>);
  await screen.findByText('remote-docs');
  fireEvent.click(screen.getByRole('button', { name: 'Remove configuration' }));
  fireEvent.click(screen.getByRole('dialog').querySelector('button')!);
  await waitFor(() => expect(removeMcpConnection).toHaveBeenCalledWith('project-c', 'remote-docs'));
  expect(screen.getByText(/does not stop servers already used by an existing session/)).toBeTruthy();
});
