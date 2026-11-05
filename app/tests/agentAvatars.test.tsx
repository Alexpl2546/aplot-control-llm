// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { AgentAvatar } from '../src/features/agent/AgentAvatar';
import { AgentPresetForm } from '../src/features/agent/AgentPresets';
import { avatarSource, presetAvatar } from '../src/features/agent/agentAvatars';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import type { AgentPreset } from '../src/features/agent/workspaceModel';

const preset: AgentPreset = { id: 'designer', name: 'Designer', templateId: 'designer', runtime: 'hermes', accessMode: 'manual', instructions: 'Design screens' };
beforeEach(async () => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  await i18n.changeLanguage('en');
  useWorkspaceStore.setState({ ready: false, presets: [preset], projects: [], tasks: [], saveError: '' });
});
afterEach(cleanup);

it('resolves template defaults while preserving custom uploads and an explicitly removed avatar', () => {
  expect(presetAvatar(preset)).toBe('builtin:ui_designer');
  expect(presetAvatar({ ...preset, avatar: '' })).toBeUndefined();
  expect(presetAvatar({ ...preset, avatar: 'data:image/webp;base64,abc' })).toBe('data:image/webp;base64,abc');
  expect(avatarSource('https://example.com/avatar.png')).toBeUndefined();
  expect(avatarSource('builtin:../outside')).toBeUndefined();
});

it('uses motion only during activity or hover and supplies a static reduced-motion source', () => {
  const { container, rerender } = render(<AgentAvatar avatar="builtin:architect"/>);
  const image = container.querySelector('img')!;
  expect(image.getAttribute('src')).toContain('/png/02_architect.png');
  fireEvent.pointerEnter(container.firstChild!);
  expect(image.getAttribute('src')).toContain('/webp/02_architect.webp');
  expect(container.querySelector('source')?.getAttribute('media')).toBe('(prefers-reduced-motion: reduce)');
  rerender(<AgentAvatar avatar="builtin:architect" animationEnabled={false} animate/>);
  expect(image.getAttribute('src')).toContain('/png/02_architect.png');
});

it('saves selection, animation setting and specialization, then keeps avatar removal after reopening', async () => {
  const view = render(<AgentPresetForm initial={preset}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Built-in avatars' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('builtin.architect.name'), exact: true }));
  fireEvent.click(screen.getByLabelText('Animate during activity and on hover'));
  fireEvent.change(screen.getByLabelText('Specialization'), { target: { value: 'Plans interfaces and acceptance criteria' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(useWorkspaceStore.getState().presets[0]).toMatchObject({ avatar: 'builtin:architect', avatarAnimated: false, description: 'Plans interfaces and acceptance criteria' }));
  view.unmount();
  render(<AgentPresetForm initial={useWorkspaceStore.getState().presets[0]}/>);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('presets.avatarRemove'), exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(presetAvatar(useWorkspaceStore.getState().presets[0])).toBeUndefined());
});
