// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const controls = vi.hoisted(() => ({ steerHostTask: vi.fn(), reviewHostTask: vi.fn() }));
vi.mock('../src/services/agentTasks', () => controls);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { CodexTaskControls } from '../src/features/agent/CodexTaskControls';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => 'command-id' });
  controls.steerHostTask.mockResolvedValue({ status: 'accepted' });
  controls.reviewHostTask.mockResolvedValue({ status: 'accepted' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('binds steer to the projected native turn and worker generation, and offers review only while idle', async () => {
  const { rerender } = render(<CodexTaskControls taskId="task-1" activeTurnId="native-turn-9" workerGeneration={3} pending />);
  fireEvent.change(screen.getByRole('textbox', { name: 'codex.controls.steerLabel' }), { target: { value: 'Focus on the failing test' } });
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.steer' }));
  await waitFor(() => expect(controls.steerHostTask).toHaveBeenCalledWith({
    commandId: 'command-id', taskId: 'task-1', expectedTurnId: 'native-turn-9', expectedGeneration: 3, text: 'Focus on the failing test',
  }));
  expect((screen.getByRole('button', { name: 'codex.controls.review' }) as HTMLButtonElement).disabled).toBe(true);

  rerender(<CodexTaskControls taskId="task-1" workerGeneration={3} pending={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.review' }));
  await waitFor(() => expect(controls.reviewHostTask).toHaveBeenCalledWith({ commandId: 'command-id', taskId: 'task-1', expectedGeneration: 3 }));
});

it('disables Codex controls when the worker generation is missing', () => {
  render(<CodexTaskControls taskId="task-1" activeTurnId="turn" pending />);
  expect((screen.getByRole('button', { name: 'codex.controls.review' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'codex.controls.steerLabel' }) as HTMLTextAreaElement).disabled).toBe(true);
});

it('offers parent-owned native fork only for an idle, current Codex session', async () => {
  const onFork = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<CodexTaskControls taskId="source" workerGeneration={4} pending={false} onFork={onFork} />);
  const forkButton = screen.getByRole('button', { name: 'codex.controls.fork' });
  expect((forkButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(forkButton);
  await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));

  rerender(<CodexTaskControls taskId="source" workerGeneration={4} pending onFork={onFork} />);
  expect((screen.getByRole('button', { name: 'codex.controls.fork' }) as HTMLButtonElement).disabled).toBe(true);
});
