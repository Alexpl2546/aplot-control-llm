import { beforeEach,it,expect,vi } from 'vitest';
const native=vi.hoisted(()=>({invoke:vi.fn(),event:undefined as undefined|((v:{payload:{id:string;packet:Record<string,unknown>}})=>void)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async(_name,callback)=>{native.event=callback;return ()=>{};})}));
vi.mock('../src/features/openai/store',()=>({useOpenAi:{setState:vi.fn()}}));
import { startClaude,promptClaude,stopClaude } from '../src/services/claude';
import type { AgentFrame } from '../src/features/agent/store';
beforeEach(()=>{native.invoke.mockReset();native.invoke.mockResolvedValue({});});
it('waits for native idle after result before completing the task',async()=>{
  const frames:AgentFrame[]=[];
  await startClaude({id:'idle-test',cwd:'C:/work',runId:'',generation:0,language:'ru',runtime:'claude',connectionId:'claude:owner',modelId:'sonnet'},frame=>frames.push(frame));
  const emit=(packet:Record<string,unknown>)=>native.event?.({payload:{id:'idle-test',packet}});
  emit({type:'system',subtype:'session_state_changed',state:'running'});emit({type:'result',is_error:false});
  expect(frames.some(f=>f.type==='message.complete')).toBe(false);
  emit({type:'system',subtype:'session_state_changed',state:'idle'});expect(frames.filter(f=>f.type==='message.complete')).toHaveLength(1);
  await stopClaude('idle-test',true);
});
it('pins native session ownership and sends images as native content blocks',async()=>{
  native.invoke.mockImplementation(async(method)=>method==='claude_images'?[{type:'image',source:{type:'base64',media_type:'image/png',data:'fixture'}}]:{});
  const frames:AgentFrame[]=[];
  await startClaude({id:'resume-test',cwd:'C:/work',runId:'',generation:0,language:'ru',runtime:'claude',connectionId:'claude:owner',modelId:'sonnet',nativeSessionId:'00000000-0000-4000-8000-000000000001'},f=>frames.push(f));
  expect(native.invoke).toHaveBeenCalledWith('claude_start',expect.objectContaining({request:expect.objectContaining({sessionId:'00000000-0000-4000-8000-000000000001',connectionId:'claude:owner',chat:false})}));
  native.event?.({payload:{id:'resume-test',packet:{type:'system',subtype:'init',session_id:'native',model:'sonnet'}}});
  expect(frames[0]).toMatchObject({type:'session.created',payload:{runtime:'claude',connectionId:'claude:owner'}});
  await promptClaude('resume-test','Describe',[{id:'f',path:'C:/photo.png',name:'photo.png',size:12,kind:'image'}]);
  expect(native.invoke).toHaveBeenCalledWith('claude_send',expect.objectContaining({packet:expect.objectContaining({message:expect.objectContaining({content:[{type:'text',text:'Describe'},{type:'image',source:{type:'base64',media_type:'image/png',data:'fixture'}}]})})}));
  await stopClaude('resume-test',true);
});
