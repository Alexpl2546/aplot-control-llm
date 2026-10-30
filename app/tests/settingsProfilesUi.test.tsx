// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { DEFAULT_SETTINGS } from '../src/types/app';
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG } from '../src/types/config';

const bridge = vi.hoisted(() => ({ isTauri: () => false, discoverStrataModels: vi.fn(async () => []), createRunStartRequest: vi.fn(async () => null) }));
vi.mock('../src/services/tauri', () => bridge);
vi.mock('../src/features/openai/OpenAiPanel', () => ({ ConnectionsSettingsContent: () => null }));
vi.mock('../src/features/agent/AgentPresets', () => ({ AgentPresetsSettingsContent: () => null }));
vi.mock('../src/components/config/ComponentManager', () => ({ ComponentManager: () => null }));
vi.mock('../src/components/config/CliPreview', () => ({ CliPreview: () => null }));
vi.mock('../src/components/config/ResourceEstimator', () => ({ ResourceEstimator: () => null }));
vi.mock('../src/features/resources/ResourcePlanPanel', () => ({ ResourcePlanPanel: () => null }));
vi.mock('../src/features/launches/EngineProfileControls', () => ({ EngineProfileControls: () => null }));
vi.mock('../src/features/launches/LaunchControls', () => ({ LaunchControls: () => null }));
vi.mock('../src/features/smartTasks/SmartTaskDesk', () => ({ SmartTaskDesk: () => null }));

import { useControlStore } from '../src/store/control';
import { SettingsView } from '../src/views/SettingsView';
import { ProfilesView } from '../src/views/ProfilesView';
import { ConfigurationView } from '../src/views/ConfigurationView';
import { SaveAsDialog } from '../src/components/config/SaveAsDialog';
import { ConfigEditor } from '../src/components/config/ConfigEditor';

const initial = useControlStore.getState();
const notify = vi.fn();
const t = (key: string) => i18n.t(key);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

beforeAll(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
});
beforeEach(async () => {
  vi.clearAllMocks();
  bridge.discoverStrataModels.mockResolvedValue([]);
  await i18n.changeLanguage('en');
  useControlStore.setState({
    ...initial, notify, settingsSection: 'engine', busy: false, optimizerRunning: false,
    config: { ...DEFAULT_CONFIG, binaryPath: 'server.exe', modelPath: 'model.gguf', profileName: 'Original' },
    savedConfig: { ...DEFAULT_CONFIG }, profiles: [], libraryModels: [],
    settings: { ...DEFAULT_SETTINGS, serverEngine: 'llama_cpp', routerPort: 8080, strataPort: 8081, routerApiKey: 'old-key', binaryPath: 'server.exe' },
    capabilities: { ...DEFAULT_CAPABILITIES },
  });
});
afterEach(() => { cleanup(); useControlStore.setState(initial); });

describe('settings save interactions', () => {
  it('preserves other unsaved fields when generating and persisting a router API key', async () => {
    const updateSettings = vi.fn(async patch => { useControlStore.setState(state => ({ settings: { ...state.settings, ...patch } })); });
    useControlStore.setState({ updateSettings });
    render(<SettingsView/>);
    fireEvent.change(screen.getByDisplayValue('8080'), { target: { value: '9000' } });
    fireEvent.change(screen.getByDisplayValue('server.exe'), { target: { value: 'other-server.exe' } });
    fireEvent.click(screen.getByRole('button', { name: t('router.generateApiKey') }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect((screen.getByDisplayValue('9000') as HTMLInputElement).value).toBe('9000');
    expect(screen.getByDisplayValue('other-server.exe')).toBeTruthy();
    expect(updateSettings.mock.calls[0][0].routerApiKey).toMatch(/^aplot_[a-f0-9]{64}$/);
  });

  it('reports a failed key save without showing a false success or replacing the key', async () => {
    useControlStore.setState({ updateSettings: vi.fn(async () => { throw new Error('disk-full'); }) });
    render(<SettingsView/>);
    fireEvent.click(screen.getByRole('button', { name: t('router.generateApiKey') }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'Error: disk-full'));
    expect(notify).not.toHaveBeenCalledWith('success', expect.anything());
    expect(screen.getByDisplayValue('old-key')).toBeTruthy();
  });

  it('saves edited fields automatically once and keeps the draft after a failure', async () => {
    const pending = deferred();
    const updateSettings = vi.fn(async () => { await pending.promise; throw new Error('write-failed'); });
    useControlStore.setState({ updateSettings });
    render(<SettingsView/>);
    expect(screen.queryByRole('button', { name: t('actions.save'), exact: true })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('8080'), { target: { value: '9000' } });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.getAllByRole('status').map(node => node.textContent).join(' ')).toContain('write-failed'));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('9000')).toBeTruthy();
  });
});

describe('save as dialog', () => {
  it('shows a failed save and preserves the entered name for retry', async () => {
    const duplicateProfile = vi.fn(async () => { throw new Error('name-conflict'); });
    const onClose = vi.fn();
    useControlStore.setState({ duplicateProfile });
    render(<SaveAsDialog open onClose={onClose}/>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My profile' } });
    fireEvent.click(screen.getByRole('button', { name: t('actions.saveAs') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('name-conflict'));
    expect(duplicateProfile).toHaveBeenCalledWith('My profile');
    expect(screen.getByDisplayValue('My profile')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores repeated Enter and dismissal until the save finishes', async () => {
    const pending = deferred();
    const duplicateProfile = vi.fn(() => pending.promise);
    const onClose = vi.fn();
    useControlStore.setState({ duplicateProfile });
    render(<SaveAsDialog open onClose={onClose}/>);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.mouseDown(screen.getByRole('presentation'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(duplicateProfile).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot submit using Enter while an optimizer blocks profile edits', () => {
    const duplicateProfile = vi.fn();
    useControlStore.setState({ duplicateProfile, optimizerRunning: true });
    render(<SaveAsDialog open onClose={vi.fn()}/>);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(duplicateProfile).not.toHaveBeenCalled();
  });
});

describe('profile actions', () => {
  it('handles profile selection errors and keeps the current screen', async () => {
    const selectProfile = vi.fn(async () => { throw new Error('read-failed'); });
    const setView = vi.fn();
    useControlStore.setState({ selectProfile, setView, profiles: [{ id: 'p', name: 'Profile', config: { ...DEFAULT_CONFIG }, createdAt: '', updatedAt: '' }] });
    render(<ProfilesView/>);
    fireEvent.click(screen.getByRole('button', { name: t('profiles.select') }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'Error: read-failed'));
    expect(setView).not.toHaveBeenCalled();
  });

  it('shows only saved Strata profiles and omits llama.cpp cache and GPU defaults', async () => {
    const configPath = 'C:/strata/config.json';
    const selectProfile = vi.fn(async () => undefined);
    useControlStore.setState({ selectProfile, strataModels: [{ configPath, modelName: 'Discovered duplicate', contextLength: 32768 }] as never,
      profiles: [{ id: 'saved-strata', name: 'Saved Strata', config: { ...DEFAULT_CONFIG, engine: 'strata', engineOptions: { strata: { strataConfigPath: configPath } } }, createdAt: '', updatedAt: '' }] });
    render(<ProfilesView engineFilter="strata"/>);
    expect(screen.getByText('Saved Strata')).toBeTruthy();
    expect(screen.queryByText('Discovered duplicate')).toBeNull();
    expect(screen.queryByText('q8_0 / q8_0')).toBeNull();
    expect(bridge.discoverStrataModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('profiles.select') }));
    await waitFor(() => expect(selectProfile).toHaveBeenCalledWith('saved-strata'));
  });
});

describe('engine configuration', () => {
  it('serializes save actions and navigates only after saving succeeds', async () => {
    const pending = deferred();
    const saveCurrentProfile = vi.fn(() => pending.promise);
    const setView = vi.fn();
    useControlStore.setState({ saveCurrentProfile, setView });
    render(<ConfigurationView/>);
    // Exact parameters fold under the sliders; open the block as a click on its summary would.
    const details = screen.getByText(t('smart.tabs.engine')).closest('details')!;
    act(() => { details.open = true; fireEvent(details, new Event('toggle')); });
    const save = await screen.findByRole('button', { name: t('actions.saveAndHome') });
    fireEvent.click(save); fireEvent.click(save);
    expect(saveCurrentProfile).toHaveBeenCalledTimes(1);
    expect(setView).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(setView).toHaveBeenCalledWith('dashboard');
  });

  it('shows extra command arguments as supported and interpolates validation errors', () => {
    useControlStore.setState({ config: { ...useControlStore.getState().config, parallel: 65 } });
    const { container } = render(<ConfigEditor/>);
    fireEvent.click(screen.getByRole('button', { name: t('config.tabs.advanced') }));
    expect(container.querySelector('.disabledReason')).toBeNull();
    expect(container.querySelector('.validationList')?.textContent).not.toContain('{{');
    expect(container.querySelector('.validationList')?.textContent).toContain('64');
  });
});
