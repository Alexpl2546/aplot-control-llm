import { describe, expect, it } from 'vitest';
import { responsesStream } from '../src/features/openai/responses';
const bytes=(text:string)=>new TextEncoder().encode(text);
const delta='data: {"type":"response.output_text.delta","delta":"Привет"}\r\n\r\n';
const done='data: {"type":"response.completed"}\r\n\r\n';
describe('ChatGPT Responses stream',()=>{
  it('displays streamed reasoning summaries before the final answer', () => {
    const deltas: unknown[] = [], parser = responsesStream(delta => deltas.push(delta));
    parser.push(bytes('data: {"type":"response.reasoning_summary_text.delta","delta":"Checking the request"}\n\n' + delta + done));
    parser.finish();
    expect(deltas).toEqual([{ reasoning: 'Checking the request' }, { content: 'Привет' }]);
  });
  it('accepts a large completed response without text deltas and avoids duplicate streamed text', () => {
    const large = 'А'.repeat(120000), deltas: unknown[] = [], parser = responsesStream(delta => deltas.push(delta));
    parser.push(bytes(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: large }] }] } })}\n\n`));
    parser.finish(); expect(deltas).toEqual([{ content: large }]);
    let text = ''; const streamed = responsesStream(delta => { text += delta.content ?? ''; });
    streamed.push(bytes(delta + 'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Привет"}]}]}}\n\n'));
    streamed.finish(); expect(text).toBe('Привет');
  });
  it('preserves UTF-8 and CRLF when every byte arrives separately',()=>{
    let text='';const parser=responsesStream(d=>text+=d.content??'');
    for(const byte of bytes(delta+done))parser.push(new Uint8Array([byte]));parser.finish();expect(text).toBe('Привет');
  });
  it('does not mark a partial response successful',()=>{const p=responsesStream(()=>{});p.push(bytes(delta));expect(()=>p.finish()).toThrow('incomplete');});
  it('propagates failure after visible text without exposing remote error details',()=>{
    const p=responsesStream(()=>{});p.push(bytes(delta+'data: {"type":"response.failed","response":{"error":{"message":"private upstream detail"}}}\n\n'));
    expect(()=>p.finish()).toThrow('streamError');
  });
  it('does not mistake a bare DONE marker for completed',()=>{const p=responsesStream(()=>{});p.push(bytes('data: [DONE]\n\n'));expect(()=>p.finish()).toThrow('incomplete');});
});
