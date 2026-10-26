import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn()}));
vi.mock('../src/services/tauri',()=>({isTauri:()=>true}));
import { codexLimitsAction,remaining,refreshCodexLimitsStatus,refreshQuota,useOpenAi } from '../src/features/openai/store';
describe('account quota snapshots',()=>{
  beforeEach(()=>{mocks.invoke.mockReset();useOpenAi.setState({status:{connected:true,pending:false,connectionId:'quota-test'},quotaProfileId:undefined,profiles:[],profileStatuses:{},quotasByConnection:{},quotaConnectionId:'quota-test',quota:undefined,quotaAt:undefined,quotaError:undefined});});
  it('converts consumed usage to remaining and clamps overage',()=>{expect(remaining({usedPercent:25})).toBe(75);expect(remaining({usedPercent:110})).toBe(0);expect(remaining({usedPercent:-1})).toBe(100);});
  it('deduplicates concurrent readers without inventing missing windows',async()=>{
    const snapshot={rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:15}}}};
    mocks.invoke.mockResolvedValue(snapshot);await Promise.all([refreshQuota(),refreshQuota(),refreshQuota()]);
    expect(mocks.invoke).toHaveBeenCalledWith('codex_limits',{action:'read',connectionId:'quota-test'});expect(mocks.invoke).toHaveBeenCalledTimes(1);expect(useOpenAi.getState().quota).toEqual(snapshot);expect(useOpenAi.getState().quota?.rateLimitsByLimitId?.codex.secondary).toBeUndefined();
  });
  it('keeps account responses separate when readers finish out of order',async()=>{
    let finish!:(value:unknown)=>void;
    mocks.invoke.mockImplementation((_method,args)=>args.connectionId==='first'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({rateLimits:{primary:{usedPercent:42}}}));
    const first=refreshQuota(true,'first'),second=refreshQuota(true,'second');finish({rateLimits:{primary:{usedPercent:1}}});await Promise.all([first,second]);
    expect(useOpenAi.getState().quotasByConnection.first.value.rateLimits?.primary?.usedPercent).toBe(1);expect(useOpenAi.getState().quotasByConnection.second.value.rateLimits?.primary?.usedPercent).toBe(42);expect(mocks.invoke).toHaveBeenCalledTimes(2);expect(useOpenAi.getState().quotaConnectionId).toBe('second');expect(useOpenAi.getState().quota?.rateLimits?.primary?.usedPercent).toBe(42);
  });
  it('drops a late response after disconnecting that Codex authorization',async()=>{
    let finish!:(value:unknown)=>void;
    mocks.invoke.mockImplementation((_method,args)=>args.action==='read'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({}));
    const reading=refreshQuota(true,'late-logout');
    await codexLimitsAction('logout','late-logout');
    finish({rateLimits:{primary:{usedPercent:5}}});await reading;
    expect(useOpenAi.getState().quotasByConnection['late-logout']).toBeUndefined();
    expect(useOpenAi.getState().codexLimitsAuth['late-logout']).toEqual({connected:false,pending:false});
  });
  it('starts a fresh reader after reconnecting even when an old request has not finished',async()=>{
    let finishOld!:(value:unknown)=>void;let reads=0;
    mocks.invoke.mockImplementation((_method,args)=>args.action!=='read'?Promise.resolve({}):++reads===1?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve({rateLimits:{primary:{usedPercent:67}}}));
    const old=refreshQuota(true,'reconnected');
    await codexLimitsAction('logout','reconnected');
    await refreshQuota(true,'reconnected');
    finishOld({rateLimits:{primary:{usedPercent:1}}});await old;
    expect(reads).toBe(2);
    expect(useOpenAi.getState().quotasByConnection.reconnected.value.rateLimits?.primary?.usedPercent).toBe(67);
  });
  it('refreshes limits immediately after login without waiting for model catalogue requests',async()=>{
    useOpenAi.setState({profiles:[{id:'ready',provider:'openai',name:'Ready',enabled:true,connectionId:'ready-account'}],profileStatuses:{ready:{connected:true,pending:false,connectionId:'ready-account'}}});
    mocks.invoke.mockImplementation((_method,args)=>Promise.resolve(args.action==='status'?{connected:true,pending:false}:{rateLimits:{primary:{usedPercent:26}}}));
    await refreshCodexLimitsStatus('ready-account');
    expect(mocks.invoke.mock.calls.map(([method,args])=>[method,args.action])).toEqual([['codex_limits','status'],['codex_limits','read']]);
    expect(useOpenAi.getState().quotasByConnection['ready-account'].value.rateLimits?.primary?.usedPercent).toBe(26);
  });
  it('does not fetch limits while browser authorization is still pending',async()=>{
    useOpenAi.setState({profiles:[{id:'waiting',provider:'openai',name:'Waiting',enabled:true,connectionId:'waiting-account'}],profileStatuses:{waiting:{connected:true,pending:false,connectionId:'waiting-account'}}});
    mocks.invoke.mockResolvedValue({connected:false,pending:true});await refreshCodexLimitsStatus('waiting-account');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(useOpenAi.getState().codexLimitsAuth['waiting-account']).toEqual({connected:false,pending:true});
  });
  it('does not read the default account when a signed-out profile is selected',async()=>{
    useOpenAi.setState({quotaProfileId:'offline',profiles:[{id:'offline',provider:'openai',name:'Offline',enabled:true}],profileStatuses:{offline:{connected:false,pending:false}}});await refreshQuota();expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('retains the last snapshot with a stale marker on a failed refresh',async()=>{
    const snapshot={rateLimits:{primary:{usedPercent:72}}};useOpenAi.setState({quota:snapshot,quotaAt:123});mocks.invoke.mockRejectedValue(new Error('offline'));await refreshQuota();
    expect(useOpenAi.getState()).toMatchObject({quota:snapshot,quotaAt:123,quotaError:'unavailable'});
  });
});
