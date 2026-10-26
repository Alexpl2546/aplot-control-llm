// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../src/lib/i18n';
import i18n from '../src/lib/i18n';
import { LogPanel } from '../src/components/LogPanel';
import { useControlStore } from '../src/store/control';
import type { LogLine } from '../src/types/runtime';

const line = (id: string): LogLine => ({ id, message: `Message ${id}`, timestamp: new Date().toISOString(), level: 'INFO', source: 'control' });
const initialState = useControlStore.getState();
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  useControlStore.setState({ logs: [line('first')], logFilter: 'ALL', logSearch: '', selectedRunId: null });
});
afterEach(() => { cleanup(); useControlStore.setState(initialState, true); vi.unstubAllGlobals(); });

it('clears a paused snapshot and keeps new messages hidden until resumed', () => {
  render(<LogPanel/>);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('logs.pause') }));
  act(() => useControlStore.setState({ logs: [line('first'), line('second')] }));
  expect(screen.queryByText('Message second')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('logs.clear') }));
  expect(screen.queryByText('Message first')).toBeNull();
  expect(useControlStore.getState().logs).toEqual([]);
  act(() => useControlStore.setState({ logs: [line('third')] }));
  expect(screen.queryByText('Message third')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('logs.resume') }));
  expect(screen.getByText('Message third')).toBeTruthy();
});

it('shows the selected server logs when switching away from a paused server', () => {
  act(() => useControlStore.setState({ selectedRunId: 'first-server' }));
  render(<LogPanel/>);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('logs.pause') }));
  act(() => useControlStore.setState({ selectedRunId: 'second-server', logs: [line('second-server')] }));
  expect(screen.queryByText('Message first')).toBeNull();
  expect(screen.getByText('Message second-server')).toBeTruthy();
  expect(screen.getByRole('button', { name: i18n.t('logs.pause') })).toBeTruthy();
});
