import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),event:undefined as undefined|((event:{payload:unknown})=>void)}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async (_name,callback)=>{mocks.event=callback;return ()=>{};})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({}))}));
vi.mock('../src/features/openai/store',()=>({codexRpc:mocks.rpc}));
import { startCodex,promptCodex,stopCodex } from '../src/services/codex';
describe('Codex turn lifecycle',()=>{
  beforeEach(()=>{mocks.rpc.mockReset();mocks.rpc.mockImplementation(async(method)=>method==='thread/start'?{thread:{id:'thread'}}:{turn:{id:'turn'}});});
  it('can send another message when completed arrives before turn/start resolves',async()=>{
    const frames:unknown[]=[];await startCodex({id:'session',runId:'',generation:0,cwd:'C:/work',language:'ru',runtime:'codex',modelId:'model'},frame=>frames.push(frame));
    mocks.rpc.mockImplementation(async(method)=>{if(method==='turn/start'){mocks.event?.({payload:{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}}});return {turn:{id:'turn'}};}return {};});
    await promptCodex('session','first');await expect(promptCodex('session','second')).resolves.toBeUndefined();
    expect(frames).toContainEqual({kind:'event',type:'message.complete',payload:{status:'complete'}});await stopCodex('session',true);
  });
  it('only closes sessions owned by the account that signed out',async()=>{
    const first:unknown[]=[],second:unknown[]=[];
    mocks.rpc.mockImplementation(async(_method,params)=>({thread:{id:params.aplotConnectionId+'-thread'}}));
    await startCodex({id:'first',connectionId:'one',runId:'',generation:0,cwd:'C:/work',language:'ru',runtime:'codex'},frame=>first.push(frame));
    await startCodex({id:'second',connectionId:'two',runId:'',generation:0,cwd:'C:/work',language:'ru',runtime:'codex'},frame=>second.push(frame));
    mocks.event?.({payload:{method:'account/updated',aplotConnectionId:'one',params:{authMode:null}}});
    expect(first).toContainEqual({kind:'closed'});expect(second).not.toContainEqual({kind:'closed'});
    mocks.rpc.mockResolvedValue({turn:{id:'still-active'}});await expect(promptCodex('second','work')).resolves.toBeUndefined();await stopCodex('second',true);
  });
  it('interrupts a turn even when Stop is pressed while turn/start is pending',async()=>{
    await startCodex({id:'pending',runId:'',generation:0,cwd:'C:/work',language:'ru',runtime:'codex',modelId:'model'},()=>{});
    let resolve!:(value:unknown)=>void;mocks.rpc.mockImplementation(method=>method==='turn/start'?new Promise(r=>{resolve=r;}):Promise.resolve({}));
    const prompting=promptCodex('pending','work');await stopCodex('pending',true);resolve({turn:{id:'late-turn'}});await prompting;
    expect(mocks.rpc).toHaveBeenCalledWith('turn/interrupt',{threadId:'thread',turnId:'late-turn'});
  });
});
