// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskAccessControl, type AccessChangeRequest } from '../mobile/src/TaskAccessControl';

afterEach(cleanup);

const defaults = {
  taskId: 'task-one', accessMode: 'restricted' as const, revision: 7, busy: false,
  allowedModes: ['restricted', 'full'] as const, onRefresh: vi.fn(),
};

describe('TaskAccessControl', () => {
  it('requires the owner to confirm full access before sending a revision-fenced request', async () => {
    const onApply = vi.fn(async (body: AccessChangeRequest) => ({...body, taskId:'task-one',status:'updated' as const,revision:8}));
    const user = userEvent.setup();
    render(<TaskAccessControl {...defaults} onApply={onApply} />);
    await user.click(screen.getByRole('button', {name:/^Полный доступ/}));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/в том числе вне папки проекта/)).not.toBeNull();
    await user.click(screen.getByRole('button', {name:'Разрешить полный доступ'}));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0][0]).toMatchObject({expectedRevision:7,accessMode:'full'});
  });

  it('retries an uncertain mode change with its original UUID, revision and mode', async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error('lost reply'))
      .mockImplementationOnce(async (body: AccessChangeRequest) => ({...body,taskId:'task-one',status:'updated',revision:8}));
    const user = userEvent.setup();
    const view = render(<TaskAccessControl {...defaults} onApply={onApply} />);
    await user.click(screen.getByRole('button', {name:/^Полный доступ/}));
    await user.click(screen.getByRole('button', {name:'Разрешить полный доступ'}));
    await screen.findByRole('alert');
    const first = onApply.mock.calls[0][0];
    view.rerender(<TaskAccessControl {...defaults} revision={12} onApply={onApply} />);
    await user.click(screen.getByRole('button', {name:'Повторить изменение доступа'}));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    expect(onApply.mock.calls[1][0]).toEqual(first);
  });

  it('keeps permission changes unavailable while work is running', async () => {
    const onApply = vi.fn();
    render(<TaskAccessControl {...defaults} busy onApply={onApply} />);
    expect((screen.getByRole('button', {name:/^Полный доступ/}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Дождитесь завершения/)).not.toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });
});
