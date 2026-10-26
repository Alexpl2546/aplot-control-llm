import { describe,it,expect } from 'vitest';
import { claudeFrames,claudeApproval,type ClaudeStreamState } from '../src/features/openai/claudeProtocol';
const fresh=():ClaudeStreamState=>({streamed:false,output:0});
describe('Claude native protocol',()=>{
  it('does not duplicate streamed text when the full assistant packet follows',()=>{
    const s=fresh();expect(claudeFrames({type:'stream_event',event:{delta:{type:'text_delta',text:'Hello'}}},s)[0].payload?.text).toBe('Hello');
    expect(claudeFrames({type:'assistant',message:{content:[{type:'text',text:'Hello'}]}},s)).toEqual([]);
    expect(claudeFrames({type:'result',result:'Hello',is_error:false},s)[0].payload).toEqual({status:'complete'});
  });
  it('keeps child answers and thinking out of the main conversation',()=>{
    expect(claudeFrames({type:'stream_event',parent_tool_use_id:'child',event:{delta:{type:'text_delta',text:'child private output'}}},fresh())).toEqual([]);
    expect(claudeFrames({type:'system',subtype:'task_notification',task_id:'child',status:'failed',summary:'Tests failed'},fresh())[0]).toMatchObject({type:'agent.update',payload:{id:'child',status:'failed'}});
  });
  it('uses last request context, including cache, without counting cumulative billing usage',()=>{
    const s=fresh();claudeFrames({type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:20}}}},s);
    claudeFrames({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:4}}},s);
    const frame=claudeFrames({type:'result',is_error:false,usage:{input_tokens:999999},modelUsage:{m:{contextWindow:200000}}},s)[0];
    expect(frame.payload?.usage).toMatchObject({context_used:134,context_max:200000,context_estimated:false});
  });
  it('preserves tool errors and normalizes file writes for the artifact inspector',()=>{
    expect(claudeFrames({type:'assistant',message:{content:[{type:'tool_use',id:'t',name:'Write',input:{file_path:'C:/result.html'}}]}},fresh())[0]).toMatchObject({type:'tool.start',payload:{name:'write_file'}});
    expect(claudeFrames({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',is_error:true,content:'disk full'}]}},fresh())[0].payload?.result).toMatchObject({is_error:true});
  });
  it('only offers persistent approval for native rule suggestions and distinguishes destinations',()=>{
    const packet={type:'control_request',request_id:'q',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'npm test'},permission_suggestions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'npm test'}],behavior:'allow',destination:'session'}]}};
    expect(claudeFrames(packet,fresh())[0].params?.allow_permanent).toBe(true);
    expect(claudeApproval(packet,{choice:'always'})).toMatchObject({updatedPermissions:[{destination:'userSettings'}]});
    expect(claudeApproval(packet,{choice:'session'})).toMatchObject({updatedPermissions:[{destination:'session'}]});
    expect(claudeApproval(packet,{choice:'deny'})).toMatchObject({behavior:'deny'});
    expect(()=>claudeApproval({request:{input:{}}},{choice:'always'})).toThrow('unsupported-permanent');
  });
  it('maps question answers back to native question text and can decline a skipped question',()=>{
    const packet={request:{tool_name:'AskUserQuestion',input:{questions:[{question:'Continue?'}]}}};
    expect(claudeApproval(packet,{answers:{'0':'Yes'}})).toMatchObject({updatedInput:{answers:{'Continue?':'Yes'}}});
    expect(claudeApproval(packet,{})).toMatchObject({behavior:'deny'});
  });
});
