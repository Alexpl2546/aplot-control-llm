// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { DEFAULT_SETTINGS } from '../src/types/app';

const MB = 1024 ** 2;
const root = 'C:\\Users\\Example\\AppData\\Local\\Aplot Control LLM\\components';
const services = vi.hoisted(() => ({
  getComponentMaintenance: vi.fn(),
  getComponentUpdates: vi.fn(),
  updateComponent: vi.fn(),
  installComponent: vi.fn(),
  removeOldComponentVersions: vi.fn(),
  subscribeComponentUpdate: vi.fn(async () => () => undefined),
  removeInstalledComponents: vi.fn(),
  launchUninstaller: vi.fn(),
  openUninstallSettings: vi.fn(),
  isRemovedComponentPath: () => false,
}));
vi.mock('../src/services/components', () => services);
vi.mock('../src/services/desktop', () => ({ revealItem: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
const bridge = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('../src/services/tauri', async original => ({ ...(await original<object>()), getSettings: bridge.getSettings }));

import { ComponentManager } from '../src/components/config/ComponentManager';
import { useControlStore } from '../src/store/control';
import { useComponentJobs } from '../src/components/config/componentJobs';

const updateName = () => new RegExp(`^${i18n.t('components.update.action')}$`);
const module = (id: string, name: string, version: string, bytes: number) => ({ id, name, versions: [version], paths: [`${root}\\${id}\\${version}`], bytes, externalPath: null, blocked: null });

beforeAll(async () => { await i18n.changeLanguage('ru'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); useComponentJobs.setState({ maintenance: null, catalog: null, finished: [], failed: null }); });

describe('component updates', () => {
  it('offers the pinned version and updates through the installer', async () => {
    services.getComponentMaintenance.mockResolvedValue({ root, uninstallerPath: null, modules: [module('strata', 'Strata', '0.1.45', 1500 * MB), module('llama_cpp', 'llama.cpp', 'b11723', 40 * MB)] });
    services.getComponentUpdates.mockResolvedValue({ reviewedAt: '2026-10-26', installerAvailable: true, components: [
      { id: 'strata', installedVersion: '0.1.45', availableVersion: '0.1.50', updateAvailable: true, downloadBytes: null, repository: '' },
      { id: 'llama_cpp', installedVersion: 'b11723', availableVersion: 'b11723', updateAvailable: false, downloadBytes: 32 * MB, repository: '' },
    ] });
    services.updateComponent.mockResolvedValue({ id: 'strata', previousVersion: '0.1.45', version: '0.1.50', path: `${root}\\strata\\0.1.50` });
    bridge.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, strataRootPath: `${root}\\strata\\0.1.50` });
    const refreshAvailableEngines = vi.fn(async () => undefined);
    useControlStore.setState({ refreshAvailableEngines });

    render(<ComponentManager/>);
    expect(await screen.findByText(i18n.t('components.update.available', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('v0.1.50')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: updateName() });
    // Banner and the Strata card; llama.cpp is already on the pinned version.
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(services.updateComponent).toHaveBeenCalledWith('strata'));
    await waitFor(() => expect(refreshAvailableEngines).toHaveBeenCalled());
    expect(useControlStore.getState().settings.strataRootPath).toContain('0.1.50');
    expect(await screen.findByText(i18n.t('components.update.finished', { names: 'Strata' }))).toBeTruthy();
  });

  it('explains a Strata update blocked by a running server', async () => {
    services.getComponentMaintenance.mockResolvedValue({ root, uninstallerPath: null, modules: [module('strata', 'Strata', '0.1.45', 1500 * MB)] });
    services.getComponentUpdates.mockResolvedValue({ reviewedAt: '', installerAvailable: true, components: [{ id: 'strata', installedVersion: '0.1.45', availableVersion: '0.1.50', updateAvailable: true, downloadBytes: null, repository: '' }] });
    services.updateComponent.mockRejectedValue('Stop the Strata server before updating its engine');

    render(<ComponentManager/>);
    fireEvent.click((await screen.findAllByRole('button', { name: updateName() }))[0]);
    expect(await screen.findByText(i18n.t('components.update.strataRunning'))).toBeTruthy();
  });

  it('hides updates when the bundled installer is missing', async () => {
    services.getComponentMaintenance.mockResolvedValue({ root, uninstallerPath: null, modules: [module('strata', 'Strata', '0.1.45', 1500 * MB)] });
    services.getComponentUpdates.mockResolvedValue({ reviewedAt: '', installerAvailable: false, components: [{ id: 'strata', installedVersion: '0.1.45', availableVersion: '0.1.50', updateAvailable: true, downloadBytes: null, repository: '' }] });

    render(<ComponentManager/>);
    await screen.findByText('v0.1.45');
    expect(screen.queryByRole('button', { name: updateName() })).toBeNull();
  });

  it('installs a missing component from its card', async () => {
    const absent = { id: 'claude', name: 'Claude Code', versions: [], paths: [], bytes: 0, externalPath: null, blocked: null };
    services.getComponentMaintenance.mockResolvedValueOnce({ root, uninstallerPath: null, modules: [absent] })
      .mockResolvedValue({ root, uninstallerPath: null, modules: [module('claude', 'Claude Code', '2.1.292', 243 * MB)] });
    services.getComponentUpdates.mockResolvedValue({ reviewedAt: '', installerAvailable: true, components: [{ id: 'claude', installedVersion: null, availableVersion: '2.1.292', updateAvailable: false, downloadBytes: 243 * MB, repository: '' }] });
    services.installComponent.mockResolvedValue({ id: 'claude', previousVersion: null, version: '2.1.292', path: `${root}\\claude\\2.1.292\\claude.exe` });
    bridge.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
    useControlStore.setState({ refreshAvailableEngines: vi.fn(async () => undefined) });

    render(<ComponentManager/>);
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('components.install.action') }));
    await waitFor(() => expect(services.installComponent).toHaveBeenCalledWith('claude'));
    expect(await screen.findByText(i18n.t('components.install.finished', { names: 'Claude Code' }))).toBeTruthy();
    expect(await screen.findByText('v2.1.292')).toBeTruthy();
  });

  it('marks versions left by an update and removes them', async () => {
    const strata = { ...module('strata', 'Strata', '0.1.50', 3400 * MB), versions: ['0.1.45', '0.1.50'], current: '0.1.50', oldBytes: 1500 * MB };
    services.getComponentMaintenance.mockResolvedValueOnce({ root, uninstallerPath: null, modules: [strata] })
      .mockResolvedValue({ root, uninstallerPath: null, modules: [{ ...strata, versions: ['0.1.50'], oldBytes: 0, bytes: 1900 * MB }] });
    services.getComponentUpdates.mockResolvedValue({ reviewedAt: '', installerAvailable: true, components: [] });
    services.removeOldComponentVersions.mockResolvedValue({ removed: [`${root}\\strata\\0.1.45`], errors: [] });

    render(<ComponentManager/>);
    expect(await screen.findByText(i18n.t('components.oldVersion'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('components.removeOld', { size: '' }).replace(/[·\s]+$/, '')) }));
    await waitFor(() => expect(services.removeOldComponentVersions).toHaveBeenCalledWith('strata'));
    await waitFor(() => expect(screen.queryByText(i18n.t('components.oldVersion'))).toBeNull());
  });
});
