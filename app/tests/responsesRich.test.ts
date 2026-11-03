import { describe, expect, it } from 'vitest';
import { responsesStream } from '../src/features/openai/responses';
import type { ChatDelta } from '../src/features/chat/stream';
import { MAX_CONTENT_BLOCKS, type ContentBlock } from '../src/features/chat/content';

const bytes = (value: string) => new TextEncoder().encode(value);
const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

function collect(frames: string[]) {
  const deltas: ChatDelta[] = [];
  const parser = responsesStream(delta => deltas.push(delta));
  parser.push(bytes(frames.join('')));
  parser.finish();
  return deltas;
}

function allBlocks(deltas: ChatDelta[]): ContentBlock[] {
  const blocks = new Map<string, ContentBlock>();
  for (const delta of deltas) for (const block of delta.blocks ?? []) blocks.set(block.id, block);
  return [...blocks.values()];
}

describe('Responses rich content parser', () => {
  it('tracks web search lifecycle, citations, final text fallback, and usage without duplicate blocks', () => {
    const citation = { type: 'url_citation', start_index: 8, end_index: 14, url: 'https://example.com/report', title: 'Example report' };
    const message = { id: 'msg-1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Answer [1]', annotations: [citation] }] };
    const search = { id: 'ws-1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'weather in Moscow' } };
    const deltas = collect([
      sse({ type: 'response.created', response: { id: 'resp-1' } }),
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws-1', type: 'web_search_call', status: 'in_progress' } }),
      sse({ type: 'response.web_search_call.searching', item_id: 'ws-1', output_index: 0 }),
      sse({ type: 'response.web_search_call.completed', item_id: 'ws-1', output_index: 0 }),
      sse({ type: 'response.output_item.done', output_index: 0, item: search }),
      sse({ type: 'response.output_text.annotation.added', item_id: 'msg-1', output_index: 1, content_index: 0, annotation_index: 0, annotation: citation }),
      sse({ type: 'response.output_item.done', output_index: 1, item: message }),
      sse({ type: 'response.completed', response: { id: 'resp-1', output: [search, message], usage: { input_tokens: 95, output_tokens: 18, total_tokens: 113, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 4 } } } }),
    ]);
    const blocks = allBlocks(deltas);
    expect(deltas.filter(delta => delta.content).map(delta => delta.content).join('')).toBe('Answer [1]');
    expect(blocks.filter(block => block.type === 'tool')).toEqual([expect.objectContaining({ id: 'tool:ws-1', tool: 'web_search', status: 'completed', query: 'weather in Moscow' })]);
    expect(blocks.filter(block => block.type === 'citation')).toEqual([expect.objectContaining({ id: 'citation:msg-1:0:0', source: 'web', title: 'Example report', url: 'https://example.com/report', startIndex: 8, endIndex: 14 })]);
    expect(deltas.find(delta => delta.usage)?.usage).toEqual({ inputTokens: 95, outputTokens: 18, totalTokens: 113, cachedInputTokens: 12, reasoningTokens: 4 });
  });

  it('parses file citation and generated file annotations as safe references', () => {
    const fileCitation = { type: 'file_citation', file_id: 'file-abc', filename: 'notes.txt', index: 0 };
    const filePath = { type: 'file_path', file_id: 'file-generated', index: 0 };
    const deltas = collect([
      sse({ type: 'response.output_text.annotation.added', item_id: 'msg-file', output_index: 0, content_index: 0, annotation_index: 0, annotation: fileCitation }),
      sse({ type: 'response.output_text.annotation.added', item_id: 'msg-file', output_index: 0, content_index: 0, annotation_index: 1, annotation: filePath }),
      sse({ type: 'response.completed', response: { output: [{ id: 'msg-file', type: 'message', content: [{ type: 'output_text', text: 'See the document.', annotations: [fileCitation, filePath] }] }] } }),
    ]);
    expect(allBlocks(deltas)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'citation', source: 'file', title: 'notes.txt', fileId: 'file-abc' }),
      expect.objectContaining({ type: 'artifact', kind: 'file', name: 'Generated file', reference: { type: 'openai_file', fileId: 'file-generated' } }),
    ]));
    expect(allBlocks(deltas)).toHaveLength(2);
  });

  it('surfaces function and MCP calls without exposing arguments or executing them', () => {
    const deltas = collect([
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc-1', type: 'function_call', status: 'in_progress', name: 'send_email', arguments: '{"to":"attacker@example.com"}' } }),
      sse({ type: 'response.function_call_arguments.done', item_id: 'fc-1', output_index: 0, name: 'send_email', arguments: '{"to":"attacker@example.com"}' }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc-1', type: 'function_call', status: 'completed', name: 'send_email', arguments: '{"to":"attacker@example.com"}' } }),
      sse({ type: 'response.output_item.added', output_index: 1, item: { id: 'mcp-1', type: 'mcp_call', status: 'in_progress', server_label: 'Docs', tool_name: 'search' } }),
      sse({ type: 'response.mcp_call.completed', item_id: 'mcp-1', output_index: 1 }),
      sse({ type: 'response.output_item.done', output_index: 1, item: { id: 'mcp-1', type: 'mcp_call', status: 'completed', server_label: 'Docs', tool_name: 'search' } }),
      sse({ type: 'response.completed', response: { output: [] } }),
    ]);
    const blocks = allBlocks(deltas);
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', tool: 'function', status: 'completed', label: 'Function request: send_email' }),
      expect.objectContaining({ type: 'tool', tool: 'mcp', status: 'completed', label: 'MCP tool: Docs · search' }),
    ]));
    expect(JSON.stringify(blocks)).not.toContain('attacker@example.com');
  });

  it('keeps code and image outputs as opaque provider references, not downloadable URLs or binary', () => {
    const imageBytes = 'A'.repeat(2000);
    const deltas = collect([
      sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'ci-1', type: 'code_interpreter_call', status: 'completed', outputs: [{ type: 'image', file_id: 'file-output' }] } }),
      sse({ type: 'response.output_item.done', output_index: 1, item: { id: 'img-1', type: 'image_generation_call', status: 'completed', result: imageBytes } }),
      sse({ type: 'response.completed', response: { output: [] } }),
    ]);
    const blocks = allBlocks(deltas);
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'artifact', kind: 'image', name: 'Code output image', reference: { type: 'openai_file', fileId: 'file-output' } }),
      expect.objectContaining({ type: 'artifact', kind: 'image', name: 'Generated image', reference: { type: 'none' } }),
    ]));
    expect(JSON.stringify(blocks)).not.toContain(imageBytes);
    expect(JSON.stringify(blocks)).not.toContain('data:');
  });

  it('falls back to readable inert blocks for unknown output items', () => {
    const deltas = collect([
      sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'computer-1', type: 'computer_call', command: 'do something unsafe' } }),
      sse({ type: 'response.completed', response: { output: [{ id: 'computer-1', type: 'computer_call', command: 'do something unsafe' }] } }),
    ]);
    const blocks = allBlocks(deltas);
    expect(blocks).toEqual([expect.objectContaining({ type: 'unknown', sourceType: 'computer_call', label: 'Unsupported response item' })]);
    expect(JSON.stringify(blocks)).not.toContain('do something unsafe');
  });

  it('caps rich blocks at the history limit and adds a readable overflow notice', () => {
    const frames = Array.from({ length: MAX_CONTENT_BLOCKS + 32 }, (_, output_index) => sse({
      type: 'response.output_item.done',
      output_index,
      item: { id: `unknown-${output_index}`, type: 'computer_call', command: 'never execute' },
    }));
    frames.push(sse({ type: 'response.completed', response: { output: [] } }));
    const blocks = allBlocks(collect(frames));
    expect(blocks).toHaveLength(MAX_CONTENT_BLOCKS);
    expect(blocks.at(-1)).toEqual(expect.objectContaining({
      id: 'system:content-limit',
      type: 'unknown',
      sourceType: 'content_limit',
      label: 'Additional response details were omitted because the display limit was reached.',
    }));
  });

  it('marks a failed search readably and keeps upstream error details private', () => {
    const deltas: ChatDelta[] = [];
    const parser = responsesStream(delta => deltas.push(delta));
    parser.push(bytes(sse({ type: 'response.web_search_call.in_progress', item_id: 'ws-fail', output_index: 0 })
      + sse({ type: 'response.web_search_call.failed', item_id: 'ws-fail', output_index: 0 })
      + sse({ type: 'response.failed', response: { error: { message: 'private upstream detail' } } })));
    expect(() => parser.finish()).toThrow('streamError');
    expect(allBlocks(deltas)).toEqual([expect.objectContaining({ type: 'tool', status: 'failed', tool: 'web_search' })]);
    expect(JSON.stringify(deltas)).not.toContain('private upstream detail');
  });

  it('does not duplicate final text after streamed deltas and ignores a bare DONE as completion', () => {
    const deltas = collect([
      sse({ type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hello' }),
      sse({ type: 'response.completed', response: { output: [{ id: 'msg-1', type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] } }),
    ]);
    expect(deltas.filter(delta => delta.content).map(delta => delta.content).join('')).toBe('Hello');
    const parser = responsesStream(() => {});
    parser.push(bytes('data: [DONE]\n\n'));
    expect(() => parser.finish()).toThrow('incomplete');
  });

  it('recovers every message from final-only multi-item output and ignores duplicate terminal responses', () => {
    const response = {
      type: 'response.completed',
      response: {
        output: [
          { id: 'msg-a', type: 'message', content: [{ type: 'output_text', text: 'First answer.' }] },
          { id: 'msg-b', type: 'message', content: [{ type: 'output_text', text: 'Second answer.' }] },
          { id: 'search-a', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'follow-up' } },
        ],
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      },
    };
    const deltas = collect([sse(response), sse(response)]);
    expect(deltas.filter(delta => delta.content).map(delta => delta.content).join('')).toBe('First answer.Second answer.');
    expect(deltas.filter(delta => delta.usage)).toHaveLength(1);
    expect(allBlocks(deltas).filter(block => block.type === 'tool')).toEqual([
      expect.objectContaining({ id: 'tool:search-a', status: 'completed', query: 'follow-up' }),
    ]);
  });

  it('closes active tool state as incomplete when the stream ends or is cancelled before a terminal event', () => {
    const deltas: ChatDelta[] = [];
    const parser = responsesStream(delta => deltas.push(delta));
    parser.push(bytes(sse({ type: 'response.web_search_call.in_progress', item_id: 'ws-interrupted', output_index: 0 })));
    expect(() => parser.finish()).toThrow('incomplete');
    expect(allBlocks(deltas)).toEqual([expect.objectContaining({ id: 'tool:ws-interrupted', status: 'incomplete' })]);

    const cancelled: ChatDelta[] = [];
    const cancelledParser = responsesStream(delta => cancelled.push(delta));
    cancelledParser.push(bytes(sse({ type: 'response.code_interpreter_call.in_progress', item_id: 'code-interrupted', output_index: 0 })));
    cancelledParser.abort();
    expect(allBlocks(cancelled)).toEqual([expect.objectContaining({ id: 'tool:code-interrupted', status: 'incomplete' })]);
  });

  it('closes active tool state before propagating malformed SSE errors', () => {
    const deltas: ChatDelta[] = [];
    const parser = responsesStream(delta => deltas.push(delta));
    parser.push(bytes(sse({ type: 'response.file_search_call.in_progress', item_id: 'file-interrupted', output_index: 0 })));
    expect(() => parser.push(bytes('event: response.output_item.done\ndata: {broken-json}\n\n'))).toThrow('invalidStream');
    expect(allBlocks(deltas)).toEqual([expect.objectContaining({ id: 'tool:file-interrupted', status: 'incomplete' })]);
  });
});
