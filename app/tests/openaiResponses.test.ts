import { describe, expect, it } from 'vitest';
import { responsesStream } from '../src/features/openai/responses';
const bytes=(text:string)=>new TextEncoder().encode(text);
const delta='data: {"type":"response.output_text.delta","delta":"Привет"}\r\n\r\n';
const done='data: {"type":"response.completed"}\r\n\r\n';
describe('ChatGPT Responses stream',()=>{
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
