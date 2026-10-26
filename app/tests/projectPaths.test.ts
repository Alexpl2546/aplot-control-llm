import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/services/agentWorkspace',()=>({loadWorkspace:vi.fn(),saveWorkspace:vi.fn(),validateWorkspaceFolder:vi.fn()}));
import {validateWorkspaceFolder} from '../src/services/agentWorkspace';
import {EMPTY_AGENT,useAgentStore} from '../src/features/agent/store';
import {updateProjectSettings,useWorkspaceStore} from '../src/features/agent/workspace';
beforeEach(()=>{
 vi.mocked(validateWorkspaceFolder).mockReset().mockResolvedValue('C:\\new\\workspace');
 useWorkspaceStore.setState({ready:false,saveError:'',projects:[{id:'p',name:'workspace',path:'C:\\old\\workspace',skills:'',createdAt:1},{id:'other',name:'other',path:'C:\\other',skills:'',createdAt:1}],tasks:[{id:'t',projectId:'p',title:'Task',createdAt:1,updatedAt:1,archived:false,unread:false}],memory:[],presets:[]});
 useAgentStore.setState({threads:{t:{...EMPTY_AGENT,cwd:'C:\\old\\workspace',nativeSessionId:'old',hermesSessionId:'old',draft:'draft',entries:[{id:'m',kind:'user',text:'history'}]},other:{...EMPTY_AGENT,cwd:'C:\\other'}}});
});
it('validates and relinks a project while keeping tasks, messages and draft',async()=>{
 const tasks=useWorkspaceStore.getState().tasks;await updateProjectSettings('p','Renamed','C:\\new\\workspace');
 expect(useWorkspaceStore.getState().projects[0]).toMatchObject({name:'Renamed',path:'C:\\new\\workspace'});expect(useWorkspaceStore.getState().tasks).toBe(tasks);
 expect(useAgentStore.getState().threads.t).toMatchObject({cwd:'C:\\new\\workspace',draft:'draft',entries:[{id:'m',kind:'user',text:'history'}],ended:true});expect(useAgentStore.getState().threads.t.nativeSessionId).toBeUndefined();expect(useAgentStore.getState().threads.other.cwd).toBe('C:\\other');
});
it('keeps settings intact when a folder cannot be validated',async()=>{
 vi.mocked(validateWorkspaceFolder).mockRejectedValue('folder');const before=useWorkspaceStore.getState();await expect(updateProjectSettings('p','Rename','missing')).rejects.toBe('folder');expect(useWorkspaceStore.getState()).toBe(before);
});
it('allows renaming a missing folder without requiring disk access',async()=>{await updateProjectSettings('p','Rename','C:\\old\\workspace');expect(validateWorkspaceFolder).not.toHaveBeenCalled();expect(useWorkspaceStore.getState().projects[0].name).toBe('Rename');});
it('rejects a folder owned by another project including Windows path aliases',async()=>{
 vi.mocked(validateWorkspaceFolder).mockResolvedValue('\\\\?\\C:\\OTHER\\');await expect(updateProjectSettings('p','Rename','new')).rejects.toThrow('project-folder-used');
});
it('checks active sessions again after folder validation',async()=>{
 vi.mocked(validateWorkspaceFolder).mockImplementation(async()=>{useAgentStore.getState().update('t',thread=>({...thread,pending:true}));return 'C:\\new';});await expect(updateProjectSettings('p','Rename','new')).rejects.toThrow('project-busy');expect(useWorkspaceStore.getState().projects[0].path).toBe('C:\\old\\workspace');
});
