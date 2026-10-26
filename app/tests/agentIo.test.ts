import { describe,expect,it } from 'vitest';
import { approvalChoices,contextPercent,readContext } from '../src/features/agent/ioModel';
import { agentFrame,EMPTY_AGENT } from '../src/features/agent/store';
import { restoredThread } from '../src/features/agent/workspace';
describe('agent context and input',()=>{
  it('uses session occupancy rather than lifetime input and preserves provenance',()=>{
    expect(readContext({input:90000,total:180000})).toBeUndefined();
    const context=readContext({context_used:32000,context_max:128000,context_source:'provider_usage_plus_estimate',context_estimated:true,estimated_total:31000,categories:[{id:'conversation',tokens:30000,label:'Conversation'}]});
    expect(contextPercent(context)).toBe(25);expect(context?.context_source).toBe('provider_usage_plus_estimate');
    expect(contextPercent(readContext({context_used:100,context_max:0}))).toBeUndefined();
  });
  it('adds voice transcription to the task draft without sending a prompt',()=>{
    const thread=agentFrame({...EMPTY_AGENT,draft:'Existing text',pending:false},{kind:'event',type:'voice.transcript',payload:{text:'Русская речь'}});
    expect(thread.draft).toBe('Existing text\nРусская речь');expect(thread.pending).toBe(false);expect(thread.entries).toEqual([]);
    expect(restoredThread({...thread,voiceStatus:'listening'}).voiceStatus).toBe('idle');
  });
  it('only exposes approval options offered by Hermes and respects scope restrictions',()=>{
    expect(approvalChoices({})).toEqual(['once','deny']);
    expect(approvalChoices({choices:['once','always','session','deny','other'],allow_permanent:false})).toEqual(['once','session','deny']);
    expect(approvalChoices({choices:['always'],allow_permanent:true})).toEqual(['always']);
  });
});
