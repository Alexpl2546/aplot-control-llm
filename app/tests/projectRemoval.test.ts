import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/services/agentWorkspace',()=>({loadWorkspace:vi.fn(),saveWorkspace:vi.fn(),validateWorkspaceFolder:vi.fn()}));
import {EMPTY_AGENT,useAgentStore} from '../src/features/agent/store';
import {projectHasActiveSessions,removeProject,useWorkspaceStore} from '../src/features/agent/workspace';
const project=(id:string)=>({id,name:id,path:`C:/missing/${id}`,skills:'',createdAt:1});
const task=(id:string,projectId:string)=>({id,projectId,title:id,archived:false,unread:false,createdAt:1,updatedAt:1});
beforeEach(()=>{
 useWorkspaceStore.setState({ready:false,saveError:'',projects:[project('workspace'),project('other')],tasks:[task('remove','workspace'),{...task('old','workspace'),deletedAt:1},task('keep','other')],memory:[{id:'memory',projectId:'workspace',text:'private memory',category:'fact',confirmed:true,updatedAt:1},{id:'keep-memory',projectId:'other',text:'other',category:'fact',confirmed:true,updatedAt:1}],presets:[{id:'employee',name:'Reviewer',runtime:'codex',accessMode:'manual',instructions:'',projectIds:['workspace','other']}],selectedProjectId:'workspace',selectedTaskId:'remove',visibleTaskId:'remove'});
 useAgentStore.setState({threads:{remove:{...EMPTY_AGENT,entries:[{id:'message',kind:'assistant',text:'Stored reply'}]},old:{...EMPTY_AGENT},keep:{...EMPTY_AGENT,draft:'Keep this draft'}}});
});
it('removes project records and assignments, retains other projects and agents, and selects a remaining task',async()=>{
 await removeProject('workspace');const state=useWorkspaceStore.getState();
 expect(state.projects.map(p=>p.id)).toEqual(['other']);expect(state.tasks.map(t=>t.id)).toEqual(['keep']);expect(state.memory.map(m=>m.id)).toEqual(['keep-memory']);
 expect(state.presets[0]).toMatchObject({id:'employee',projectIds:['other']});expect(state).toMatchObject({selectedProjectId:'other',selectedTaskId:'keep',visibleTaskId:''});
 expect(Object.keys(useAgentStore.getState().threads)).toEqual(['keep']);expect(useAgentStore.getState().threads.keep.draft).toBe('Keep this draft');
});
it('clears selection when the last project is removed, even if its folder is missing',async()=>{
 await removeProject('workspace');await removeProject('other');expect(useWorkspaceStore.getState()).toMatchObject({projects:[],tasks:[],memory:[],selectedProjectId:'',selectedTaskId:'',visibleTaskId:''});
});
for(const change of [{id:'live',ended:false},{starting:true},{pending:true},{requests:[{id:'approval',method:'approve',params:{}}]},{voiceStatus:'recording' as const}])it(`refuses removal while a task is active: ${Object.keys(change).join(',')}`,async()=>{
 useAgentStore.setState(s=>({threads:{...s.threads,remove:{...s.threads.remove,...change}}}));const before=useWorkspaceStore.getState();
 expect(projectHasActiveSessions('workspace')).toBe(true);await expect(removeProject('workspace')).rejects.toThrow('project-busy');expect(useWorkspaceStore.getState()).toBe(before);
});
it('leaves the current selection and live session of another project intact',async()=>{
 useWorkspaceStore.setState({selectedProjectId:'other',selectedTaskId:'keep',visibleTaskId:'keep'});useAgentStore.setState(s=>({threads:{...s.threads,keep:{...s.threads.keep,id:'other-live'}}}));
 await removeProject('workspace');expect(useWorkspaceStore.getState()).toMatchObject({selectedProjectId:'other',selectedTaskId:'keep',visibleTaskId:'keep'});expect(useAgentStore.getState().threads.keep.id).toBe('other-live');
});
