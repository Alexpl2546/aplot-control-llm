import { beforeEach,it,expect,vi } from 'vitest';
const transport=vi.hoisted(()=>({startAgent:vi.fn(),promptAgent:vi.fn(),stopAgent:vi.fn(),respondAgent:vi.fn(),agentVoice:vi.fn()}));
vi.mock('../src/services/agent',()=>transport);
import { useAgentStore,EMPTY_AGENT,type AgentFrame } from '../src/features/agent/store';
import { sendAgent,enqueueAgent,sendQueuedAgent } from '../src/features/agent/generation';
const target={runId:'r',generation:1,language:'ru'};
beforeEach(()=>{vi.resetAllMocks();useAgentStore.setState({threads:{}});});
it('dispatches queued input once after success while preserving the draft being typed',async()=>{
  let receive!:(frame:AgentFrame)=>void;transport.startAgent.mockImplementation(async(_request,emit)=>{receive=emit;});
  useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,cwd:'C:/work',draft:'first'}));await sendAgent('task',target);
  useAgentStore.getState().update('task',s=>({...s,draft:'second'}));enqueueAgent('task');
  useAgentStore.getState().update('task',s=>({...s,draft:'still typing'}));
  expect(transport.promptAgent).toHaveBeenCalledTimes(1);
  receive({kind:'event',type:'message.complete',payload:{status:'complete'}});await vi.waitFor(()=>expect(transport.promptAgent).toHaveBeenCalledTimes(2));
  expect(transport.promptAgent.mock.calls[1][1]).toBe('second');expect(useAgentStore.getState().threads.task.draft).toBe('still typing');expect(useAgentStore.getState().threads.task.queue).toEqual([]);
});
it('keeps queued input after interruption and requires an explicit continuation',async()=>{
  let receive!:(frame:AgentFrame)=>void;transport.startAgent.mockImplementation(async(_request,emit)=>{receive=emit;});
  useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,cwd:'C:/work',draft:'first'}));await sendAgent('task',target);
  useAgentStore.getState().update('task',s=>({...s,draft:'second'}));enqueueAgent('task');
  receive({kind:'event',type:'message.complete',payload:{status:'interrupted'}});expect(transport.promptAgent).toHaveBeenCalledTimes(1);
  await sendQueuedAgent('task',target);expect(transport.promptAgent).toHaveBeenCalledTimes(2);
});
it('retains the queue after a model error',async()=>{
  let receive!:(frame:AgentFrame)=>void;transport.startAgent.mockImplementation(async(_request,emit)=>{receive=emit;});
  useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,cwd:'C:/work',draft:'first'}));await sendAgent('task',target);
  useAgentStore.getState().update('task',s=>({...s,draft:'second'}));enqueueAgent('task');receive({kind:'event',type:'message.complete',payload:{status:'error'}});
  expect(transport.promptAgent).toHaveBeenCalledTimes(1);expect(useAgentStore.getState().threads.task.queue).toHaveLength(1);
});
