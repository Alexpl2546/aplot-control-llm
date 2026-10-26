import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const persistence=vi.hoisted(()=>({loadWorkspace:vi.fn(),saveWorkspace:vi.fn(),validateWorkspaceFolder:vi.fn()}));
vi.mock('../src/services/agentWorkspace',()=>persistence);
import { createTask, flushWorkspace, initializeWorkspace, renameProject, restoreTask, selectProject, trashTask, useWorkspaceStore } from '../src/features/agent/workspace';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';

beforeAll(async()=>{
  persistence.loadWorkspace.mockResolvedValue(null);
  persistence.saveWorkspace.mockImplementation(async(_data,revision)=>revision+1);
  await initializeWorkspace();
});
beforeEach(()=>{
  vi.useFakeTimers();
  useAgentStore.setState({threads:{}});
  useWorkspaceStore.setState({ready:true,saveError:'',projects:[{id:'p',name:'folder',path:'C:\\project',skills:'C:\\skills',createdAt:1}],tasks:[],memory:[],selectedProjectId:'p',selectedTaskId:''});
});
afterEach(async()=>{await flushWorkspace();vi.clearAllTimers();vi.useRealTimers();});
describe('task trash and project identity',()=>{
  it('preserves history, inputs and project memory while removing a task from active selection, and persists trash',async()=>{
    const first=createTask('p','First'),second=createTask('p','Second');
    useAgentStore.getState().update(second,s=>({...s,entries:[{id:'u',kind:'user',text:'Keep history'}],draft:'unsent'}));
    useWorkspaceStore.setState({memory:[{id:'m',taskId:second,projectId:'p',text:'Keep shared decision',confirmed:true,category:'decision',updatedAt:1}]});
    await trashTask(second,vi.fn());
    expect(useWorkspaceStore.getState().selectedTaskId).toBe(first);
    expect(useWorkspaceStore.getState().tasks.find(t=>t.id===second)?.deletedAt).toBeGreaterThan(0);
    expect(useAgentStore.getState().threads[second]).toMatchObject({draft:'unsent',entries:[{text:'Keep history'}],ended:true});
    expect(persistence.saveWorkspace.mock.calls.at(-1)?.[0]).toMatchObject({memory:[{id:'m'}],tasks:[{id:first},{id:second,deletedAt:expect.any(Number)}]});
    restoreTask(second);
    expect(useWorkspaceStore.getState().tasks.find(t=>t.id===second)).toMatchObject({deletedAt:undefined,archived:false});
    expect(useAgentStore.getState().threads[second].draft).toBe('unsent');
  });
  it('waits for the active worker to close before moving a task to trash',async()=>{
    const id=createTask('p','Working');
    useAgentStore.getState().update(id,s=>({...s,id:'worker',pending:true,requests:[{id:'approval',method:'approval',params:{}}]}));
    let finish!:(value:boolean)=>void;
    const close=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    const deleting=trashTask(id,close);
    expect(close).toHaveBeenCalledWith(id);
    expect(useWorkspaceStore.getState().tasks[0].deletedAt).toBeUndefined();
    finish(true);await deleting;
    expect(useAgentStore.getState().threads[id]).toMatchObject({id:undefined,pending:false,requests:[]});
    expect(useWorkspaceStore.getState().tasks[0].deletedAt).toBeGreaterThan(0);
  });
  it('keeps the task and active selection when closing the worker fails',async()=>{
    const id=createTask('p','Working');
    useAgentStore.getState().update(id,s=>({...s,id:'worker',pending:true}));
    await expect(trashTask(id,async()=>false)).rejects.toThrow('task-close-failed');
    expect(useWorkspaceStore.getState()).toMatchObject({selectedTaskId:id,tasks:[{id}]});
    expect(useWorkspaceStore.getState().tasks[0].deletedAt).toBeUndefined();
    expect(useAgentStore.getState().threads[id]).toMatchObject({id:'worker',pending:true});
  });
  it('does not close or hide other tasks when one task is removed',async()=>{
    const first=createTask('p','One'),second=createTask('p','Two');
    useAgentStore.getState().update(second,()=>({...EMPTY_AGENT,id:'other-worker',pending:true}));
    const close=vi.fn();await trashTask(first,close);
    expect(close).not.toHaveBeenCalled();
    expect(useAgentStore.getState().threads[second]).toMatchObject({id:'other-worker',pending:true});
    expect(useWorkspaceStore.getState().selectedTaskId).toBe(second);
    selectProject('p');expect(useWorkspaceStore.getState().selectedTaskId).toBe(second);
  });
  it('changes only a project display name and retains task ownership, folder and skills',()=>{
    const id=createTask('p','Task');renameProject('p','  My application  ');
    expect(useWorkspaceStore.getState().projects[0]).toMatchObject({id:'p',name:'My application',path:'C:\\project',skills:'C:\\skills'});
    expect(useWorkspaceStore.getState().tasks[0]).toMatchObject({id,projectId:'p'});
    expect(useAgentStore.getState().threads[id].cwd).toBe('C:\\project');
  });
});
