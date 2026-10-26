import { describe, expect, it } from 'vitest';
import { isActivityEvent, lifecycleChanged } from '../src/features/activity/model';
describe('structured activity journal',()=>{
  it('records real lifecycle changes without turning inference traffic into event spam',()=>{
    expect(lifecycleChanged(undefined,{state:'starting',generation:1})).toBe(true);
    expect(lifecycleChanged({state:'loading',generation:1},{state:'ready',generation:1})).toBe(true);
    expect(lifecycleChanged({state:'ready',generation:1},{state:'busy',generation:1})).toBe(false);
    expect(lifecycleChanged({state:'busy',generation:1},{state:'ready',generation:1})).toBe(false);
    expect(lifecycleChanged({state:'ready',generation:1},{state:'ready',generation:2})).toBe(true);
    expect(lifecycleChanged({state:'ready',generation:2},{state:'crashed',generation:2})).toBe(true);
  });
  it('rejects malformed persisted records before rendering dates or details',()=>{
    const row={id:'test',time:Date.now(),kind:'agent.tool',level:'info',name:'Task',data:{tool:'read_file',outcome:'success'}};
    expect(isActivityEvent(row)).toBe(true);
    expect(isActivityEvent({...row,time:Infinity})).toBe(false);
    expect(isActivityEvent({...row,kind:'arbitrary'})).toBe(false);
    expect(isActivityEvent({...row,data:{nested:{secret:'value'}}})).toBe(false);
  });
});
