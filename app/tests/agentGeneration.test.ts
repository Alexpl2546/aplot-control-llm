import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ startAgent: vi.fn(), promptAgent: vi.fn(), stopAgent: vi.fn(), respondAgent: vi.fn(), agentVoice: vi.fn() }));
vi.mock('../src/services/agent', () => transport);
import { useAgentStore, EMPTY_AGENT, type AgentFrame } from '../src/features/agent/store';
import { sendAgent, interruptAgent, prepareAgent, finishAgentDictation, cancelAgentDictation } from '../src/features/agent/generation';
const target = { runId: 'r', generation: 2, language: 'ru' };
beforeEach(() => { vi.resetAllMocks(); useAgentStore.setState({ threads: {} }); });
describe('background agent ownership', () => {
  it('allows only one prompt while starting and ignores events from a replaced conversation', async () => {
    let deliver!: (frame: AgentFrame) => void, ready!: () => void;
    transport.startAgent.mockImplementation((_request, callback) => { deliver = callback; return new Promise<void>(resolve => { ready = resolve; }); });
    useAgentStore.getState().update('r:2', () => ({ ...EMPTY_AGENT, cwd: 'C:\\project', draft: 'read file' }));
    const running = sendAgent('r:2', target);
    await sendAgent('r:2', target);
    expect(transport.startAgent).toHaveBeenCalledTimes(1);
    useAgentStore.getState().setMode('chat');
    expect(useAgentStore.getState().threads['r:2'].pending).toBe(true);
    useAgentStore.getState().update('r:2', () => ({ ...EMPTY_AGENT }));
    deliver({ kind: 'event', type: 'message.delta', payload: { text: 'late answer' } });
    ready(); await running;
    expect(useAgentStore.getState().threads['r:2'].entries).toEqual([]);
    expect(transport.promptAgent).not.toHaveBeenCalled();
  });
  it('closes a worker when stopped during startup', async () => {
    transport.stopAgent.mockResolvedValue(undefined);
    useAgentStore.getState().update('r:2', () => ({ ...EMPTY_AGENT, id: 'owned', pending: true, starting: true }));
    await interruptAgent('r:2');
    expect(transport.stopAgent).toHaveBeenCalledWith('owned', true);
  });
  it('releases the client identity after startup failure, allowing configuration to be corrected', async () => {
    transport.startAgent.mockRejectedValue(new Error('context'));
    useAgentStore.getState().update('r:2', () => ({ ...EMPTY_AGENT, cwd: 'C:\\project', draft: 'hello' }));
    await sendAgent('r:2', target);
    expect(useAgentStore.getState().threads['r:2']).toMatchObject({ id: undefined, pending: false, starting: false, error: 'context' });
  });
  it('does not submit a prompt when Stop arrives before native startup completes', async () => {
    let ready!: () => void;
    transport.startAgent.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    transport.stopAgent.mockRejectedValueOnce(new Error('closed')).mockResolvedValue(undefined);
    useAgentStore.getState().update('r:2', () => ({ ...EMPTY_AGENT, cwd: 'C:\\project', draft: 'hello' }));
    const starting = sendAgent('r:2', target);
    await interruptAgent('r:2'); ready(); await starting;
    expect(transport.promptAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().threads['r:2']).toMatchObject({ pending: false, ended: true, stopped: true });
  });
  it('sends an attachment-only turn and restores all inputs if native staging fails',async()=>{
    const attachment={id:'a',name:'photo.png',path:'C:/photo.png',size:12,kind:'image' as const};
    transport.startAgent.mockResolvedValue(undefined);transport.promptAgent.mockRejectedValue(new Error('attachment-missing'));
    useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,cwd:'C:/project',draft:'',attachments:[attachment]}));
    await sendAgent('task',target);
    expect(transport.promptAgent).toHaveBeenCalledWith(expect.any(String),'',[attachment]);
    expect(useAgentStore.getState().threads.task).toMatchObject({pending:false,attachments:[attachment],entries:[]});
    expect(useAgentStore.getState().threads.task.id).toBeTruthy();
  });
  it('retains a newly typed draft alongside failed input and reuses the prepared worker',async()=>{
    transport.startAgent.mockResolvedValue(undefined);
    transport.promptAgent.mockImplementation(async()=>{
      useAgentStore.getState().update('task',s=>({...s,draft:'next question'}));
      throw new Error('attachment-missing');
    });
    useAgentStore.getState().update('task',()=>({...EMPTY_AGENT,cwd:'C:/project',draft:'original question'}));
    await sendAgent('task',target);
    expect(useAgentStore.getState().threads.task.draft).toBe('original question\n\nnext question');
    transport.promptAgent.mockResolvedValue(undefined);
    await sendAgent('task',target);
    expect(transport.startAgent).toHaveBeenCalledTimes(1);
  });
});

describe('manual dictation ownership',()=>{
  async function recording(){
    let deliver!:(frame:AgentFrame)=>void;
    transport.startAgent.mockImplementation(async(_request,callback)=>{deliver=callback;});
    transport.agentVoice.mockResolvedValue({status:'stopped'});
    useAgentStore.getState().update('voice',()=>({...EMPTY_AGENT,cwd:'C:/project',draft:'typed'}));
    await prepareAgent('voice',target);
    useAgentStore.getState().update('voice',s=>({...s,voiceStatus:'listening'}));
    return (frame:AgentFrame)=>deliver(frame);
  }
  it('stops into the draft without sending and ignores route changes',async()=>{
    const emit=await recording();await finishAgentDictation('voice');
    useAgentStore.getState().setMode('chat');
    emit({kind:'event',type:'voice.transcript',payload:{text:'spoken'}});
    expect(useAgentStore.getState().threads.voice.draft).toBe('typed\nspoken');
    expect(transport.promptAgent).not.toHaveBeenCalled();
  });
  it('sends exactly once after explicit Send and successful transcription',async()=>{
    const emit=await recording();await finishAgentDictation('voice',true);
    expect(transport.promptAgent).not.toHaveBeenCalled();
    emit({kind:'event',type:'voice.transcript',payload:{text:'spoken'}});
    emit({kind:'event',type:'voice.status',payload:{state:'idle'}});
    expect(transport.promptAgent).toHaveBeenCalledExactlyOnceWith(expect.any(String),'typed\nspoken',undefined);
  });
  it('discards a cancelled late transcription and keeps typed input',async()=>{
    const emit=await recording();await finishAgentDictation('voice',true);await cancelAgentDictation('voice');
    expect(useAgentStore.getState().threads.voice.voiceStatus).toBe('cancelling');
    emit({kind:'event',type:'voice.transcript',payload:{text:'must not appear'}});
    emit({kind:'event',type:'voice.status',payload:{state:'idle'}});
    expect(useAgentStore.getState().threads.voice).toMatchObject({draft:'typed',voiceStatus:'idle',voiceSendAfter:false});
    expect(transport.promptAgent).not.toHaveBeenCalled();
  });
  it('never sends typed input when the recording contains no speech',async()=>{
    const emit=await recording();await finishAgentDictation('voice',true);
    emit({kind:'event',type:'voice.transcript',payload:{text:''}});
    expect(transport.promptAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().threads.voice).toMatchObject({draft:'typed',ioError:'no-speech'});
  });
});
