// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageFeed } from '../mobile/src/MessageFeed';
import type { MobileMessage } from '../mobile/types';

afterEach(cleanup);

describe('MessageFeed tool history', () => {
  it('groups consecutive completed and settled unknown tools without reordering messages', () => {
    const messages: MobileMessage[] = [
      { id: 'user-1', kind: 'user', text: 'Find the release notes' },
      { id: 'search-1', kind: 'tool', name: 'webSearch', status: 'unknown', result: { status: null, exit_code: null, output: '' } },
      { id: 'search-2', kind: 'tool', name: 'web_search', status: 'completed', result: { output: 'Release notes found' } },
      { id: 'assistant-1', kind: 'assistant', text: 'I found the notes.' },
      { id: 'running-1', kind: 'tool', name: 'webSearch', status: 'running' },
      { id: 'failed-1', kind: 'tool', name: 'terminal', status: 'failed', result: { output: 'command failed' } },
      { id: 'error-1', kind: 'tool', name: 'file_search', status: 'error', result: { output: 'read failed' } },
    ];
    const { container } = render(<MessageFeed messages={messages} loading={false} />);
    const list = container.querySelector('.message-list')!;
    const entries = Array.from(list.children);

    expect(entries.map(entry => entry.className)).toEqual([
      'message-bubble message-user',
      'tool-history-group',
      'message-bubble message-assistant',
      'tool-card',
      'tool-card',
      'tool-card',
    ]);
    const history = entries[1] as HTMLDetailsElement;
    expect(history.open).toBe(false);
    expect(within(history).getByText('Действия агента · 2')).not.toBeNull();
    expect(within(history).getAllByText('Поиск в интернете')).toHaveLength(2);
    const emptySearch = history.querySelector('.tool-card')!;
    expect(emptySearch.querySelector('.tool-card-content')).toBeNull();
    expect(emptySearch.textContent).not.toContain('{}');
    expect(entries[3].textContent).toContain('Выполняется');
    expect(entries[4].textContent).toContain('Ошибка');
    expect(entries[5].textContent).toContain('Ошибка');
  });

  it('keeps an unknown tool visible while the task is pending', () => {
    const { container } = render(<MessageFeed pending messages={[
      { id: 'unknown-1', kind: 'tool', name: 'webSearch', status: 'unknown', result: { status: null, exit_code: null, output: '' } },
      { id: 'complete-1', kind: 'tool', name: 'terminal', status: 'completed', result: { output: 'done' } },
    ]} loading={false} />);

    expect(container.querySelector('.message-list > .tool-card')?.textContent).toContain('Поиск в интернете');
    expect(container.querySelector('.tool-history-group > summary')?.textContent).toBe('Действия агента · 1');
    expect(container.querySelector('.message-list > .tool-card .tool-card-content')).toBeNull();
    expect(screen.getByText('Готово').closest('details')?.open).toBe(false);
  });
});
