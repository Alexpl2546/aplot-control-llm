// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { AgentPresetForm } from '../src/features/agent/AgentPresets';
import { TaskStarter } from '../src/features/agent/TaskStarter';
import { useAgentStore } from '../src/features/agent/store';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import type { AgentPreset, AgentProject } from '../src/features/agent/workspaceModel';
import { useOpenAi } from '../src/features/openai/store';
import { useReasoningProfiles } from '../src/features/reasoning/profiles';
import { useControlStore } from '../src/store/control';

const preset: AgentPreset = { id: 'reviewer', name: 'Reviewer', runtime: 'codex', connectionProfileId: 'account', model: 'deep-model', accessMode: 'manual', instructions: '' };
const project: AgentProject = { id: 'project', name: 'Project', path: 'C:/work', createdAt: 1, skills: '' };

beforeAll(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document.documentElement, 'clientWidth', { get: () => 1024 });
  Object.defineProperty(document.documentElement, 'clientHeight', { get: () => 768 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 30, y: 30, top: 30, left: 30, right: 330, bottom: 70, width: 300, height: 40, toJSON: () => ({}) }));
});

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.clear();
  useWorkspaceStore.setState({ presets: [preset], projects: [project], tasks: [], ready: false, saveError: '' });
  useAgentStore.setState({ threads: {} });
  useControlStore.setState({ runs: [] });
  useOpenAi.setState({ profiles: [{ id: 'account', name: 'Account', provider: 'openai', enabled: true, connectionId: 'c1' }], defaults: { openai: 'account' },
    profileStatuses: { account: { connected: true, pending: false, connectionId: 'c1' } },
    catalogs: { c1: [{ id: 'deep-model', model: 'deep-model', displayName: 'Deep model' }, { id: 'plain-model', model: 'plain-model', displayName: 'Plain model' }] } });
  useReasoningProfiles.setState({ entries: {
    'codex:c1:deep-model': { modelKey: 'codex:c1:deep-model', provider: 'codex', source: 'model-list', profile: { control: 'effort', levels: [{ id: 'low' }, { id: 'ultra' }], default: 'low', canDisable: false, wire: 'codex-effort' } },
    'codex:c1:plain-model': { modelKey: 'codex:c1:plain-model', provider: 'codex', source: 'model-list', profile: { control: 'none', levels: [], canDisable: false, wire: '' } },
  } });
});

afterEach(cleanup);

it('offers the selected model levels, saves the agent default and shows it when reopened', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const view = render(<AgentPresetForm initial={preset} onSaved={onSaved}/>);
  await user.click(screen.getByRole('combobox', { name: i18n.t('reasoning.label') }));
  expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Auto (low)', 'Low', 'Ultra']);
  await user.click(screen.getByRole('option', { name: 'Ultra' }));
  await user.click(screen.getByRole('button', { name: i18n.t('aw.save'), exact: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ reasoning: 'ultra' })));
  view.unmount();
  render(<AgentPresetForm initial={useWorkspaceStore.getState().presets[0]}/>);
  expect(screen.getByRole('combobox', { name: i18n.t('reasoning.label') }).textContent).toContain('Ultra');
});

it('clears an unsupported default when switching to a model without reasoning', async () => {
  const user = userEvent.setup(), onSaved = vi.fn();
  render(<AgentPresetForm initial={{ ...preset, reasoning: 'ultra' }} onSaved={onSaved}/>);
  await user.click(screen.getByRole('combobox', { name: i18n.t('openai.model') }));
  await user.click(await screen.findByRole('option', { name: /Plain model/ }));
  expect(screen.queryByRole('combobox', { name: i18n.t('reasoning.label') })).toBeNull();
  await user.click(screen.getByRole('button', { name: i18n.t('aw.save'), exact: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ model: 'plain-model', reasoning: '' })));
});

it('applies the selected agent default when creating a task from the starter', () => {
  useWorkspaceStore.setState({ presets: [{ ...preset, reasoning: 'ultra' }] });
  const onCreated = vi.fn();
  render(<TaskStarter project={project} onCreated={onCreated}/>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Review the changes' } });
  fireEvent.click(screen.getByRole('button', { name: i18n.t('aw.starter.create') }));
  const task = useWorkspaceStore.getState().tasks[0];
  expect(task).toMatchObject({ presetId: preset.id, reasoning: 'ultra', cloudModel: preset.model, connectionId: 'c1' });
  expect(onCreated).toHaveBeenCalledWith(task.id, true);
});
