import { describe, expect, it } from 'vitest';
import { codexApproval,codexFrames,codexPolicy } from '../src/features/openai/codexProtocol';
import { agentFrame, EMPTY_AGENT } from '../src/features/agent/store';
describe('Codex adapter protocol',()=>{
  it('keeps restricted access read-only and never upgrades unsupported sandbox modes',()=>{
    expect(codexPolicy('restricted','C:/work')).toMatchObject({approvalPolicy:'never',sandbox:'read-only',sandboxPolicy:{type:'readOnly',networkAccess:false}});
    expect(codexPolicy('manual','C:/work')).toMatchObject({approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:['C:/work'],networkAccess:false}});
    expect(codexPolicy('full','C:/work').sandbox).toBe('danger-full-access');
  });
  it('maps real completion statuses and preserves cancellation',()=>{
    for(const [status,result] of [['completed','complete'],['interrupted','interrupted'],['failed','error']])expect(codexFrames({method:'turn/completed',params:{turn:{status}}})[0].payload?.status).toBe(result);
  });
  it('offers permanent approval only for an actual execpolicy amendment',()=>{
    const event={method:'item/commandExecution/requestApproval',id:19,params:{command:'npm test'}};
    expect(codexFrames(event)[0].params?.choices).not.toContain('always');
    expect(()=>codexApproval(event,{choice:'always'})).toThrow('unsupported-permanent');
    const amended={...event,params:{...event.params,proposedExecpolicyAmendment:['npm','test']}};
    expect(codexFrames(amended)[0].params?.choices).toContain('always');
    expect(codexApproval(amended,{choice:'always'})).toEqual({decision:{acceptWithExecpolicyAmendment:{execpolicy_amendment:['npm','test']}}});
    expect(codexApproval(event,{choice:'session'})).toEqual({decision:'acceptForSession'});
  });
  it('maps clarification answers by question ID',()=>{expect(codexApproval({method:'item/tool/requestUserInput',id:'q'},{answers:{color:'blue'}})).toEqual({answers:{color:{answers:['blue']}}});});
  it('does not turn a failed command into a successful tool result',()=>{
    const frame=codexFrames({method:'item/completed',params:{item:{id:'tool',type:'commandExecution',status:'completed',exitCode:2,aggregatedOutput:'failed'}}})[0];
    expect(agentFrame(EMPTY_AGENT,frame).entries[0].status).toBe('error');
  });
  it('keeps image generation lifecycle and reference metadata without leaking inline data or absolute paths',()=>{
    const started=codexFrames({method:'item/started',params:{item:{id:'image-1',type:'imageGeneration',status:'inProgress',generationId:'gen-1'}}})[0];
    expect(started).toMatchObject({type:'tool.start',payload:{tool_id:'image-1',name:'image_generation',result:{status:'running'}}});
    const completed=codexFrames({method:'item/completed',params:{item:{id:'image-1',type:'imageGeneration',status:'completed',fileId:'attachment-1',savedPath:'C:\\Users\\private\\image.png',result:'large-inline-bytes',generationId:'gen-1'}}})[0];
    expect(completed).toMatchObject({type:'tool.complete',payload:{result:{status:'completed',image_generation:{file_id:'attachment-1',inline_result:true,saved_path_available:true}}}});
    expect(JSON.stringify(completed)).not.toContain('C:\\Users\\private');
    expect(JSON.stringify(completed)).not.toContain('large-inline-bytes');
  });
  it('keeps failed and incomplete image generation items from appearing successful',()=>{
    const failed=codexFrames({method:'item/completed',params:{item:{id:'failed-image',type:'imageGeneration',status:'failed',failure:{type:'usageLimitExceeded',limitId:'images'}}}})[0];
    expect(failed.payload?.result).toMatchObject({status:'failed',image_generation:{failure_type:'usageLimitExceeded'}});
    expect(agentFrame(EMPTY_AGENT,failed).entries[0].status).toBe('error');
    const incomplete=codexFrames({method:'item/completed',params:{item:{id:'pending-image',type:'imageGeneration',status:'inProgress',fileId:'pending'}}})[0];
    expect(incomplete.payload?.result).toMatchObject({status:'unknown'});
    expect(agentFrame(EMPTY_AGENT,incomplete).entries[0].status).toBe('unknown');
    expect(codexFrames({method:'item/completed',params:{item:{type:'imageGeneration',status:'completed',result:'unaddressable'}}})).toHaveLength(0);
  });
  it('uses runtime context usage rather than a fixed local-model window',()=>{
    const frame=codexFrames({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{totalTokens:500},modelContextWindow:20000}}})[0];
    expect(agentFrame(EMPTY_AGENT,frame).context).toMatchObject({context_used:500,context_max:20000,context_estimated:false});
  });
});
