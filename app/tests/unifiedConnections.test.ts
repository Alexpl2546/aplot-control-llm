import { beforeEach,it,expect,vi } from 'vitest';
const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
vi.mock('../src/services/tauri',()=>({isTauri:()=>true}));
import { refreshOpenAi,useOpenAi } from '../src/features/openai/store';
beforeEach(()=>{native.invoke.mockReset();});
it('shares the OpenAI account and model catalogue with Codex without a second login',async()=>{
  native.invoke.mockImplementation(async(method)=>({openai_status:{connected:true,pending:false,connectionId:'openai:account',email:'owner@example.test'},codex_available:{installed:true},openai_models:{models:[{slug:'model',visibility:'list',display_name:'Model'}]},claude_status:{installed:false,connected:false}}[method as string]??{}));
  await refreshOpenAi();const s=useOpenAi.getState();expect(s.codexAccount?.email).toBe(s.status.email);expect(s.codexModels[0].model).toBe(s.models[0].slug);
  expect(native.invoke.mock.calls.some(([method,params])=>method==='codex_rpc'&&['account/login/start','account/read'].includes(params?.method))).toBe(false);
});
it('keeps chat available when the optional Codex runtime is missing',async()=>{
  native.invoke.mockImplementation(async(method)=>({openai_status:{connected:true,pending:false,connectionId:'openai:account'},codex_available:{installed:false},openai_models:{models:[{slug:'model',visibility:'list'}]},claude_status:{installed:false,connected:false}}[method as string]??{}));
  await refreshOpenAi();expect(useOpenAi.getState().status.connected).toBe(true);expect(useOpenAi.getState().installed).toBe(false);expect(useOpenAi.getState().models).toHaveLength(1);
});
it('loads Claude models from CLI metadata and clears limits when the identity changes',async()=>{
  useOpenAi.setState({claude:{installed:true,connected:true,connectionId:'old'},claudeLimits:{utilization:1}});
  native.invoke.mockImplementation(async(method)=>({openai_status:{connected:false,pending:false},codex_available:{installed:false},claude_status:{installed:true,connected:true,connectionId:'new'},claude_catalog:{models:[{value:'sonnet',displayName:'Sonnet'}]}}[method as string]??{}));
  await refreshOpenAi();expect(useOpenAi.getState().claudeModels[0].model).toBe('sonnet');expect(useOpenAi.getState().claudeLimits).toBeUndefined();
});

it('automatically reads limits only for explicitly linked Codex accounts',async()=>{
  const profiles=[{id:'p1',provider:'openai',enabled:true,name:'One',connectionId:'linked-one',email:'one@example.test'},{id:'p2',provider:'openai',enabled:true,name:'Two',connectionId:'unlinked-two',email:'two@example.test'}];
  useOpenAi.setState({profiles:[],profileStatuses:{},codexLimitsAuth:{},quotasByConnection:{},quotaErrors:{}});
  native.invoke.mockImplementation(async(method,args)=>{
    if(method==='connection_profiles')return {profiles,defaults:{openai:'p1'}};
    if(method==='openai_status')return {connected:true,pending:false,connectionId:args?.profileId==='p2'?'unlinked-two':'linked-one'};
    if(method==='codex_available')return {installed:true};
    if(method==='openai_models')return {models:[]};
    if(method==='claude_status')return {installed:false,connected:false};
    if(method==='codex_limits')return args.action==='status'?{connected:args.connectionId==='linked-one',pending:false}:{rateLimits:{primary:{usedPercent:34,windowDurationMins:300}}};
    return {};
  });
  await refreshOpenAi();
  await vi.waitFor(()=>expect(useOpenAi.getState().quotasByConnection['linked-one']).toBeDefined());
  const reads=native.invoke.mock.calls.filter(([method,args])=>method==='codex_limits'&&args.action==='read');
  expect(reads.map(([,args])=>args.connectionId)).toEqual(['linked-one']);
  expect(native.invoke.mock.calls.some(([method,args])=>method==='codex_limits'&&args.action==='login')).toBe(false);
});
it('keeps ChatGPT connected when the optional limits authorization fails',async()=>{
  const profiles=[{id:'p1',provider:'openai',enabled:true,name:'One',connectionId:'limits-unavailable'}];
  native.invoke.mockImplementation(async(method,args)=>{
    if(method==='connection_profiles')return {profiles,defaults:{openai:'p1'}};
    if(method==='openai_status')return {connected:true,pending:false,connectionId:'limits-unavailable'};
    if(method==='codex_available')return {installed:true};
    if(method==='openai_models')return {models:[{slug:'chat-model',visibility:'list'}]};
    if(method==='claude_status')return {installed:false,connected:false};
    if(method==='codex_limits')throw new Error('closed');
    return {};
  });
  await refreshOpenAi();
  expect(useOpenAi.getState().status.connected).toBe(true);
  expect(useOpenAi.getState().codexModels[0].model).toBe('chat-model');
  expect(useOpenAi.getState().codexLimitsAuth['limits-unavailable']).toMatchObject({connected:false,error:'Error: closed'});
});
