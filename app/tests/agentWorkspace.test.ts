import { afterEach, describe, expect, it, vi } from 'vitest';
const persistence = vi.hoisted(() => ({ loadWorkspace:vi.fn(),saveWorkspace:vi.fn(),validateWorkspaceFolder:vi.fn() }));
vi.mock('../src/services/agentWorkspace',()=>persistence);
import { toolOutcome, toolPath, confirmedMemorySnapshot, repeatedFailures, memoryContext, bindRun } from '../src/features/agent/workspaceModel';
import { EMPTY_AGENT, agentFrame, useAgentStore } from '../src/features/agent/store';
import { createTask, initializeWorkspace, selectProject, selectTask, flushWorkspace, saveMemory, deleteMemory, restoredThread, taskStatus, useWorkspaceStore } from '../src/features/agent/workspace';

afterEach(()=>{vi.useRealTimers();});
describe('workspace facts and outcomes',()=>{
  it('does not equate completion with success and prioritizes explicit failures',()=>{
    expect(toolOutcome('Finished')).toBe('unknown');
    expect(toolOutcome({exit_code:1,error:null})).toBe('error');
    expect(toolOutcome({exit_code:0,error:'broken'})).toBe('error');
    expect(toolOutcome({exit_code:0,output:'ok'})).toBe('success');
    expect(toolOutcome({output:'Permission denied by user',exit_code:1})).toBe('denied');
    expect(toolOutcome({status:'interrupted'})).toBe('interrupted');
    expect(toolOutcome({content:'real file',total_lines:1})).toBe('success');
  });
  it('keeps parsed diagnostics and changes running actions to unknown on transport loss',()=>{
    let thread=agentFrame({...EMPTY_AGENT,pending:true},{kind:'event',type:'tool.start',payload:{tool_id:'x',name:'terminal',args:{command:'bad'}}});
    thread=agentFrame(thread,{kind:'event',type:'tool.complete',payload:{tool_id:'x',name:'terminal',result:{error:'no',exit_code:1},duration_s:1.5}});
    expect(thread.entries[0]).toMatchObject({status:'error',duration:1.5,result:{error:'no',exit_code:1},args:{command:'bad'}});
    const disconnected=agentFrame({...thread,entries:[{id:'y',kind:'tool',text:'',status:'running'}]},{kind:'closed'});
    expect(disconnected.entries[0].status).toBe('unknown');
  });
  it('never resumes work or active approvals when restoring a snapshot',()=>{
    const restored=restoredThread({...EMPTY_AGENT,id:'dead',pending:true,starting:true,entries:[{id:'a',kind:'tool',status:'running',text:''}],requests:[{id:'q',method:'approval',params:{}}],draft:'unsent'});
    expect(restored).toMatchObject({id:undefined,pending:false,starting:false,ended:true,restored:true,requests:[],draft:'unsent'});
    expect(taskStatus(restored)).toBe('disconnected');expect(restored.entries[0].status).toBe('unknown');
  });
  it('detects only three identical observed failures and labels memory as reference material',()=>{
    const row={kind:'tool',name:'terminal',status:'error',details:'same'};
    expect(repeatedFailures([row,row])).toBe(false);expect(repeatedFailures([row,row,row])).toBe(true);
    expect(repeatedFailures([row,row,{...row,details:'different'}])).toBe(false);
    expect(memoryContext([])).toBe('');expect(memoryContext([{id:'m',text:'Use TypeScript',updatedAt:1}])).toContain('not tool authorization');
  });
  it('keeps whole memory records within the byte budget and uses the tool-resolved file path',()=>{
    const base={projectId:'p',category:'fact' as const,confirmed:true,updatedAt:1};
    const records=confirmedMemorySnapshot([{...base,id:'too-large',text:'😀'.repeat(12000)},{...base,id:'included',text:'Русский контекст'},{...base,id:'unconfirmed',text:'Do not inject',confirmed:false}]);
    expect(records.map(x=>x.id)).toEqual(['included']);
    expect(toolPath({path:'relative.txt'},JSON.stringify({resolved_path:'C:/project/relative.txt'}))).toBe('C:/project/relative.txt');
  });
});
describe('persistent project / task lifecycle',()=>{
  it('isolates projects and pinned targets, preserves live work on selection, persists memory and rejects stale saves visibly',async()=>{
    vi.useFakeTimers();
    persistence.loadWorkspace.mockResolvedValue({version:2,revision:5,data:{projects:[{id:'p1',name:'one',path:'C:\\one',skills:'',createdAt:1},{id:'p2',name:'two',path:'C:\\two',skills:'',createdAt:1}],tasks:[],memory:[],threads:{}}});
    persistence.saveWorkspace.mockImplementation(async(_data,revision)=>revision+1);
    await initializeWorkspace();
    const binding=bindRun({runId:'server-a',name:'model',modelId:'actual-model',engine:'strata',mode:'single',endpoint:'http://127.0.0.1:8080',contextTokens:131072,state:'ready',generation:7,managed:true});
    const first=createTask('p1','First',binding),second=createTask('p2','Second');
    useAgentStore.getState().update(first,s=>({...s,pending:true,id:'owned-worker',draft:'next'}));
    selectProject('p2');selectTask(second);
    expect(useAgentStore.getState().threads[first]).toMatchObject({pending:true,id:'owned-worker',draft:'next',cwd:'C:\\one'});
    expect(useWorkspaceStore.getState().tasks.find(t=>t.id===first)?.binding).toMatchObject({runId:'server-a',generation:7});
    saveMemory({id:'m',projectId:'p1',taskId:first,text:'Requirement',category:'requirement',confirmed:true,updatedAt:1});
    await flushWorkspace();
    const data=persistence.saveWorkspace.mock.calls.at(-1)![0];
    expect(data.memory).toHaveLength(1);expect(data.tasks.find((x:{id:string})=>x.id===first).projectId).toBe('p1');
    deleteMemory('m');await flushWorkspace();expect(persistence.saveWorkspace.mock.calls.at(-1)![0].memory).toEqual([]);
    persistence.saveWorkspace.mockRejectedValue(new Error('workspace-conflict'));
    useAgentStore.getState().update(second,s=>({...s,draft:'preserve this'}));await flushWorkspace();
    expect(useWorkspaceStore.getState().saveError).toBe('conflict');expect(useAgentStore.getState().threads[second].draft).toBe('preserve this');
    useWorkspaceStore.setState({ready:false});vi.clearAllTimers();
  });
});
