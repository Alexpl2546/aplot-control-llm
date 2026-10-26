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
  it('uses runtime context usage rather than a fixed local-model window',()=>{
    const frame=codexFrames({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{totalTokens:500},modelContextWindow:20000}}})[0];
    expect(agentFrame(EMPTY_AGENT,frame).context).toMatchObject({context_used:500,context_max:20000,context_estimated:false});
  });
});
