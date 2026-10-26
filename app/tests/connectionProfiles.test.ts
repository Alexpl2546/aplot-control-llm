import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
import {cloudSelection,useOpenAi} from '../src/features/openai/store';
import {useWorkspaceStore,createTask,saveAgentPreset,deleteAgentPreset,assignAgentPreset} from '../src/features/agent/workspace';
import {useAgentStore,EMPTY_AGENT} from '../src/features/agent/store';
import {agentInstructions,resolveAgentServer} from '../src/features/agent/generation';
import {useControlStore} from '../src/store/control';
import {chatAttachmentPayload} from '../src/features/chat/media';

beforeEach(()=>{
  useOpenAi.setState({profiles:[{id:'personal',provider:'openai',name:'Personal',enabled:true,connectionId:'account-a'},{id:'work',provider:'openai',name:'Work',enabled:true,connectionId:'account-b'}],defaults:{openai:'work'},profileStatuses:{personal:{connected:true,pending:false,connectionId:'account-a'},work:{connected:true,pending:false,connectionId:'account-b'}},catalogs:{'account-a':[{id:'one',model:'one',displayName:'One'}],'account-b':[{id:'two',model:'two',displayName:'Two'}]}});
  useWorkspaceStore.setState({ready:false,presets:[],tasks:[],projects:[{id:'project',name:'Project',path:'C:/work',skills:'',createdAt:0}],memory:[]});useAgentStore.setState({threads:{}});
});
it('selects a task’s account independently of the default account',()=>{
  expect(cloudSelection(useOpenAi.getState(),'openai','account-a').models[0].model).toBe('one');
  expect(cloudSelection(useOpenAi.getState(),'openai').models[0].model).toBe('two');
});
it('never substitutes the default account for a deleted or disabled task profile',()=>{
  expect(cloudSelection(useOpenAi.getState(),'openai','removed-account').status.connected).toBe(false);
  useOpenAi.setState(s=>({profiles:s.profiles.map(p=>p.id==='personal'?{...p,enabled:false}:p)}));
  expect(cloudSelection(useOpenAi.getState(),'openai','account-a').status.connected).toBe(false);
});
it('does not silently replace an explicitly selected missing profile',()=>{
  expect(cloudSelection(useOpenAi.getState(),'openai',undefined,'deleted').status.connected).toBe(false);
  useOpenAi.setState({profiles:[],status:{connected:true,pending:false,connectionId:'legacy'}});expect(cloudSelection(useOpenAi.getState(),'openai',undefined,'deleted').status.connected).toBe(false);
});
it('copies agent instructions and ownership into a task and keeps them after preset edits or removal',()=>{
  const preset={id:'preset',name:'Reviewer',runtime:'codex' as const,connectionProfileId:'personal',model:'one',instructions:'Review the code carefully.',accessMode:'manual' as const};
  saveAgentPreset(preset);const taskId=createTask('project','Review');assignAgentPreset(taskId,'preset');
  saveAgentPreset({...preset,instructions:'Different instructions.'});deleteAgentPreset('preset');
  const task=useWorkspaceStore.getState().tasks[0];expect(task).toMatchObject({connectionId:'account-a',instructions:'Review the code carefully.',agentName:'Reviewer'});
  expect(agentInstructions(taskId,EMPTY_AGENT)).toContain('Review the code carefully.');
  useAgentStore.getState().update(taskId,s=>({...s,id:'running'}));saveAgentPreset(preset);expect(()=>assignAgentPreset(taskId,'preset')).toThrow('session-pinned');
});
it('starts a saved local server before starting the agent and pins its actual generation',async()=>{
  const state=useControlStore.getState(),original=state.startManagedRun;
  const binding={runId:'profile:local',generation:0,name:'Local',modelId:'model',engine:'strata' as const,contextTokens:131072};
  useWorkspaceStore.setState({tasks:[{id:'task',projectId:'project',title:'Task',runtime:'hermes',autoStartServer:true,binding,archived:false,unread:false,createdAt:0,updatedAt:0}]});
  useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,id:'owned',starting:true}));
  const start=vi.fn(async()=>{useControlStore.setState(s=>({runs:s.runs.map(r=>({...r,info:{...r.info,state:'ready',generation:7}}))}));});
  useControlStore.setState({runs:[{info:{...binding,endpoint:'http://127.0.0.1:8080',mode:'single',state:'stopped',managed:true}} as typeof state.runs[number]],selectedRunId:undefined,runDrafts:{},error:undefined,startManagedRun:start});
  try{const target=await resolveAgentServer('task',{runId:binding.runId,generation:0,language:'ru'},'owned');expect(start).toHaveBeenCalledWith(binding.runId);expect(target.generation).toBe(7);expect(useWorkspaceStore.getState().tasks[0].binding?.generation).toBe(7);}finally{useControlStore.setState({startManagedRun:original,runs:[]});}
});
it('marks sampled video frames and rejects excessive combined image input',()=>{
  const value=chatAttachmentPayload([{id:'v',name:'clip.mp4',kind:'video',frames:['frame1','frame2','frame3','frame4']}]);expect(value.images).toHaveLength(4);expect(value.text).toContain('audio and unsampled frames are unavailable');
  expect(()=>chatAttachmentPayload([{id:'v',name:'clip',kind:'video',frames:Array(9).fill('frame')}])).toThrow('attachment-limit');
});
