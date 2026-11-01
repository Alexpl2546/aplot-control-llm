// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { DEFAULT_SETTINGS } from '../src/types/app';
import type { StrataEngineUpdateProgress,StrataEngineUpdateResult } from '../src/services/tauri';
const bridge=vi.hoisted(()=>({strataEngineStatus:vi.fn(),subscribeStrataEngineUpdate:vi.fn(),updateStrataEngine:vi.fn(),getSettings:vi.fn()}));
vi.mock('../src/services/tauri',async original=>({...await original<typeof import('../src/services/tauri')>(),...bridge}));
import { StrataEngines } from '../src/views/StrataEngines';
import { useControlStore } from '../src/store/control';

const initial=useControlStore.getState();
beforeEach(async()=>{
  vi.clearAllMocks();await i18n.changeLanguage('en');
  useControlStore.setState({busy:false,notify:vi.fn(),refreshAvailableEngines:vi.fn(async()=>{}),rescanModels:vi.fn(async()=>{})});
  bridge.strataEngineStatus.mockResolvedValue([{family:'deepseek',installedVersion:null,path:null,availableVersion:null,checked:false,updateAvailable:false,downloadBytes:null}]);
});
afterEach(()=>{cleanup();useControlStore.setState(initial);});

it('shows real transfer progress and verification, then follows the published version folder',async()=>{
  let receive!:(event:StrataEngineUpdateProgress)=>void,finish!:(result:StrataEngineUpdateResult)=>void;
  const stop=vi.fn();
  bridge.subscribeStrataEngineUpdate.mockImplementation(async callback=>{receive=callback;return stop;});
  bridge.updateStrataEngine.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const root='C:/Aplot/components/strata/0.1.55';
  bridge.getSettings.mockResolvedValue({...DEFAULT_SETTINGS,strataRootPath:root});
  render(<StrataEngines rootPath="C:/Aplot/components/strata/0.1.50"/>);
  fireEvent.click(await screen.findByRole('button',{name:i18n.t('engine.install'),exact:true}));
  await waitFor(()=>expect(bridge.updateStrataEngine).toHaveBeenCalledTimes(1));
  act(()=>receive({family:'deepseek',phase:'download',message:'Downloading',percent:36.5,downloadedBytes:153e6,totalBytes:422e6}));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('36.5');
  expect(screen.getByText('37%')).toBeTruthy();expect(screen.getByText('145.9 MB / 402.5 MB')).toBeTruthy();
  act(()=>receive({family:'deepseek',phase:'verify',message:'Checking package'}));
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  expect(screen.getByText(i18n.t('downloads.state.verifying'))).toBeTruthy();
  await act(async()=>finish({family:'deepseek',status:'installed',currentVersion:'0.1.55',message:'Installed',rootPath:root}));
  await waitFor(()=>expect(stop).toHaveBeenCalledOnce());
  expect(useControlStore.getState().settings.strataRootPath).toBe(root);
  expect(bridge.strataEngineStatus).toHaveBeenCalledWith(root,false);
  expect(useControlStore.getState().rescanModels).toHaveBeenCalledOnce();
});
