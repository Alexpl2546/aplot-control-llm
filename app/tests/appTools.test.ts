// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/features/agent/generation',()=>({sendAgent:vi.fn(async()=>undefined)}));
import { sendAgent } from '../src/features/agent/generation';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import { cancelAgentProposal, handleAppTool, resolveAgentProposal, useAgentProposals, type AppToolRequest } from '../src/features/agent/appTools';
import { BUILTIN_AGENTS, startTemplateSeeding } from '../src/features/agent/builtin/builtinAgents';
import { useControlStore } from '../src/store/control';

const tool=(name:string,args:Record<string,unknown>={},requestId=crypto.randomUUID())=>handleAppTool({requestId,taskId:'parent',name,arguments:args} satisfies AppToolRequest) as Promise<Record<string,unknown>>;
const oldControl=useControlStore.getState();
beforeEach(()=>{
 vi.clearAllMocks();
 useWorkspaceStore.setState({ready:false,saveError:'',templatesSeeded:true,builtinSeedVersion:0,projects:[{id:'p',name:'Project',path:'C:/project',skills:'',createdAt:1}],tasks:[{id:'parent',projectId:'p',title:'Request',runtime:'codex',cloudModel:'model',connectionId:'account',presetId:'orchestrator',accessMode:'manual',archived:false,unread:false,createdAt:1,updatedAt:1}],presets:[{id:'reviewer',name:'Reviewer',runtime:'hermes',title:'Code reviewer',accessMode:'full',instructions:'Review carefully'}],selectedTaskId:'parent',selectedProjectId:'p'});
 useAgentStore.setState({threads:{parent:{...EMPTY_AGENT,pending:true}}});
});
afterEach(()=>{useAgentProposals.getState().items.forEach(item=>cancelAgentProposal(item.requestId));useControlStore.setState(oldControl);});

it('adds the orchestrator once to an existing workspace and preserves deleted starter agents',()=>{
 useControlStore.setState({initialized:true});useWorkspaceStore.setState({ready:true});
 const stop=startTemplateSeeding();stop();
 expect(useWorkspaceStore.getState().presets.map(agent=>agent.templateId)).toEqual(['orchestrator',undefined]);
 expect(BUILTIN_AGENTS[0].instructions).toContain('aplot_propose_agent');
 useWorkspaceStore.setState(state=>({presets:state.presets.filter(agent=>agent.templateId!=='orchestrator')}));
 startTemplateSeeding()();expect(useWorkspaceStore.getState().presets).toHaveLength(1);
 useWorkspaceStore.setState({ready:false});
});
it('starts a linked specialist task on the caller model without escalating access or switching the visible chat',async()=>{
 const result=await tool('aplot_delegate',{agentId:'reviewer',prompt:'Check the implementation'});
 const child=useWorkspaceStore.getState().tasks.find(task=>task.id===result.taskId)!;
 expect(child).toMatchObject({parentTaskId:'parent',projectId:'p',presetId:'reviewer',runtime:'codex',cloudModel:'model',connectionId:'account',accessMode:'manual',instructions:'Review carefully'});
 expect(useWorkspaceStore.getState().selectedTaskId).toBe('parent');
 expect(sendAgent).toHaveBeenCalledWith(child.id,expect.any(Object));
 useAgentStore.getState().update(child.id,thread=>({...thread,pending:false,entries:[{id:'reply',kind:'assistant',text:'Checked: one issue'}]}));
 expect(await tool('aplot_task_result',{taskId:child.id})).toMatchObject({status:'completed',result:'Checked: one issue'});
 await expect(tool('aplot_task_result',{taskId:'parent'})).rejects.toThrow('not delegated');
});
it('preserves an explicitly configured specialist runtime and model',async()=>{
 useWorkspaceStore.setState(state=>({presets:state.presets.map(agent=>({...agent,runtime:'codex',model:'specialist-model',accessMode:'restricted'}))}));
 const result=await tool('aplot_delegate',{agentId:'reviewer',prompt:'Check'});
 expect(useWorkspaceStore.getState().tasks.find(task=>task.id===result.taskId)).toMatchObject({runtime:'codex',cloudModel:'specialist-model',accessMode:'restricted'});
});
it('creates a proposed agent only after approval, once, with the reviewed instructions',async()=>{
 const pending=tool('aplot_propose_agent',{name:'Database expert',title:'Database engineer',instructions:'Review schemas'},'proposal');
 expect(useWorkspaceStore.getState().presets).toHaveLength(1);
 expect(useAgentProposals.getState().items[0].agent).toMatchObject({runtime:'codex',model:'model',projectIds:['p']});
 await Promise.all([resolveAgentProposal('proposal',true),resolveAgentProposal('proposal',true)]);
 const result=await pending;
 expect(result).toMatchObject({created:true,name:'Database expert'});
 expect(useWorkspaceStore.getState().presets).toHaveLength(2);
 expect(useWorkspaceStore.getState().presets[1].instructions).toBe('Review schemas');
});
it('does not create agents after rejection, cancellation or a stopped caller',async()=>{
 for(const decision of ['reject','cancel','stop']){
  const pending=tool('aplot_propose_agent',{name:'Expert',title:'Specialist',instructions:'Do the work'},decision);
  if(decision==='cancel')cancelAgentProposal(decision);
  else {if(decision==='stop')useAgentStore.getState().update('parent',thread=>({...thread,pending:false}));await resolveAgentProposal(decision,decision==='stop');}
  expect(await pending).toHaveProperty('error');
 }
 expect(useWorkspaceStore.getState().presets).toHaveLength(1);
 await expect(tool('aplot_list_agents')).rejects.toThrow('no longer running');
});
it('enforces delegation bounds and project assignment before starting work',async()=>{
 useWorkspaceStore.setState(state=>({presets:state.presets.map(agent=>({...agent,projectIds:['another-project']}))}));
 await expect(tool('aplot_delegate',{agentId:'reviewer',prompt:'Check'})).rejects.toThrow('not assigned');
 await expect(tool('aplot_propose_agent',{name:'x'.repeat(21),title:'x',instructions:'x'})).rejects.toThrow('Invalid name');
 expect(sendAgent).not.toHaveBeenCalled();
});
it('does not preserve a higher access mode if the caller was restricted while a proposal was open',async()=>{
 const pending=tool('aplot_propose_agent',{name:'Expert',title:'Specialist',instructions:'Do the work'},'permission-change');
 useAgentStore.getState().update('parent',thread=>({...thread,accessMode:'restricted'}));
 await resolveAgentProposal('permission-change',true);
 expect(await pending).toHaveProperty('error');expect(useWorkspaceStore.getState().presets).toHaveLength(1);
});
