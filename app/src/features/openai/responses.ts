import type { ArtifactBlock, ChatUsage, ContentBlock, ToolBlock, ToolKind, ToolStatus } from '../chat/content';
import { CONTENT_BLOCK_VERSION, MAX_CONTENT_BLOCKS, safeExternalUrl } from '../chat/content';
import type { ChatDelta } from '../chat/stream';

type JsonObject = Record<string, unknown>;
type OutputItem = JsonObject & { id?: string; type?: string; content?: unknown[] };

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 1000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return result ? result.slice(0, max) : undefined;
}

function identifier(value: unknown): string | undefined {
  const result = text(value, 240);
  return result && !/[\r\n]/.test(result) ? result : undefined;
}

function index(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageFrom(value: unknown): ChatUsage | undefined {
  if (!isObject(value)) return undefined;
  const detailsIn = isObject(value.input_tokens_details) ? value.input_tokens_details : {};
  const detailsOut = isObject(value.output_tokens_details) ? value.output_tokens_details : {};
  const usage: ChatUsage = {};
  const inputTokens = boundedTokenCount(value.input_tokens);
  const outputTokens = boundedTokenCount(value.output_tokens);
  const totalTokens = boundedTokenCount(value.total_tokens);
  const cachedInputTokens = boundedTokenCount(detailsIn.cached_tokens);
  const reasoningTokens = boundedTokenCount(detailsOut.reasoning_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  return Object.keys(usage).length ? usage : undefined;
}

function toolKind(itemType: unknown): ToolKind | undefined {
  switch (itemType) {
    case 'web_search_call': return 'web_search';
    case 'file_search_call': return 'file_search';
    case 'function_call': return 'function';
    case 'mcp_call': return 'mcp';
    case 'code_interpreter_call': return 'code_interpreter';
    case 'image_generation_call': return 'image_generation';
    default: return undefined;
  }
}

function statusFrom(value: unknown, fallback: ToolStatus): ToolStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'incomplete' || value === 'cancelled') return 'incomplete';
  if (value === 'in_progress' || value === 'searching' || value === 'generating') return 'in_progress';
  return fallback;
}

function itemLabel(item: OutputItem, kind: ToolKind): string {
  if (kind === 'function') return `Function request: ${text(item.name, 100) ?? 'unnamed function'}`;
  if (kind === 'mcp') {
    const server = text(item.server_label, 100), name = text(item.tool_name, 100);
    return `MCP tool: ${[server, name].filter(Boolean).join(' · ') || 'tool call'}`;
  }
  if (kind === 'web_search') return 'Web search';
  if (kind === 'file_search') return 'File search';
  if (kind === 'code_interpreter') return 'Code interpreter';
  if (kind === 'image_generation') return 'Image generation';
  return 'Response tool';
}

function itemQuery(item: OutputItem): string | undefined {
  const action = isObject(item.action) ? item.action : {};
  const query = text(action.query, 300);
  if (query) return query;
  const queries = Array.isArray(action.queries) ? action.queries : Array.isArray(item.queries) ? item.queries : [];
  return queries.map(value => text(value, 300)).find(Boolean);
}

function citationBlock(
  annotationValue: unknown,
  blockId: string,
  startIndex?: number,
  endIndex?: number,
): ContentBlock | undefined {
  if (!isObject(annotationValue)) return undefined;
  const annotation = isObject(annotationValue.url_citation) ? annotationValue.url_citation
    : isObject(annotationValue.file_citation) ? annotationValue.file_citation
      : annotationValue;
  const kind = annotation.type ?? (annotationValue.url_citation ? 'url_citation' : annotationValue.file_citation ? 'file_citation' : undefined);
  const common = {
    version: CONTENT_BLOCK_VERSION,
    id: blockId,
    type: 'citation' as const,
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(endIndex !== undefined && (startIndex === undefined || endIndex >= startIndex) ? { endIndex } : {}),
  };
  if (kind === 'url_citation') {
    const url = safeExternalUrl(annotation.url);
    const title = text(annotation.title, 300) ?? (url ? new URL(url).hostname : 'Web source');
    return { ...common, source: 'web', title, ...(url ? { url } : {}) };
  }
  if (kind === 'file_citation' || kind === 'container_file_citation') {
    const fileId = identifier(annotation.file_id);
    return { ...common, source: 'file', title: text(annotation.filename, 300) ?? fileId ?? 'File source', ...(fileId ? { fileId } : {}) };
  }
  return undefined;
}

function annotationIndices(annotation: JsonObject): { startIndex?: number; endIndex?: number } {
  const startIndex = index(annotation.start_index);
  const endIndex = index(annotation.end_index);
  return {
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(endIndex !== undefined ? { endIndex } : {}),
  };
}

/** Responses SSE is not Chat Completions SSE; completion is an explicit event. */
export function responsesStream(onDelta: (delta: ChatDelta) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let failure = '';
  let receivedText = false;
  let receivedUnmappedText = false;
  let finalTextEmitted = false;
  let latestUsage = '';
  const outputItems = new Map<string, { item: OutputItem; outputIndex: number }>();
  const streamedTextParts = new Set<string>();
  const blocks = new Map<string, ContentBlock>();
  const overflowId = 'system:content-limit';

  const emitOverflowNotice = () => {
    if (blocks.has(overflowId) || blocks.size >= MAX_CONTENT_BLOCKS) return;
    const notice: ContentBlock = {
      version: CONTENT_BLOCK_VERSION,
      id: overflowId,
      type: 'unknown',
      sourceType: 'content_limit',
      label: 'Additional response details were omitted because the display limit was reached.',
    };
    blocks.set(notice.id, notice);
    onDelta({ blocks: [notice] });
  };

  const emitBlock = (block: ContentBlock) => {
    const previous = blocks.get(block.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(block)) return;
    if (!previous && block.id !== overflowId && blocks.size >= MAX_CONTENT_BLOCKS - 1) {
      emitOverflowNotice();
      return;
    }
    blocks.set(block.id, block);
    onDelta({ blocks: [block] });
  };

  const emitTool = (id: string, kind: ToolKind, status: ToolStatus, label: string, extra: Partial<Pick<ToolBlock, 'query' | 'referenceId'>> = {}) => {
    const block: ToolBlock = {
      version: CONTENT_BLOCK_VERSION,
      id: `tool:${id}`,
      type: 'tool',
      tool: kind,
      status,
      label: text(label, 300) ?? 'Response tool',
      ...(extra.query ? { query: text(extra.query, 300) } : {}),
      ...(extra.referenceId ? { referenceId: identifier(extra.referenceId) } : {}),
    };
    emitBlock(block);
  };

  const emitAnnotation = (annotation: unknown, itemId: string, contentIndex: number, annotationIndex: number, outputIndex: number) => {
    if (!isObject(annotation)) return;
    const directType = text(annotation.type, 80) ?? 'unknown_annotation';
    const idBase = identifier(itemId) ?? `output-${outputIndex}`;
    const annotationId = `citation:${idBase}:${contentIndex}:${annotationIndex}`;
    const { startIndex, endIndex } = annotationIndices(annotation);
    const normalized = citationBlock(annotation, annotationId, startIndex, endIndex);
    if (normalized) {
      emitBlock(normalized);
      return;
    }
    if (directType === 'file_path') {
      const fileId = identifier(annotation.file_id);
      const artifact: ArtifactBlock = {
        version: CONTENT_BLOCK_VERSION,
        id: `artifact:${idBase}:${contentIndex}:${annotationIndex}`,
        type: 'artifact',
        kind: 'file',
        name: 'Generated file',
        reference: fileId ? { type: 'openai_file', fileId } : { type: 'none' },
      };
      emitBlock(artifact);
      return;
    }
    emitBlock({ version: CONTENT_BLOCK_VERSION, id: annotationId, type: 'unknown', sourceType: directType, label: 'Unrecognized source annotation' });
  };

  const emitAnnotations = (item: OutputItem, outputIndex: number) => {
    const itemId = identifier(item.id) ?? `output-${outputIndex}`;
    const content = Array.isArray(item.content) ? item.content : [];
    content.forEach((partValue, contentIndex) => {
      if (!isObject(partValue) || !Array.isArray(partValue.annotations)) return;
      partValue.annotations.forEach((annotation, annotationIndex) => emitAnnotation(annotation, itemId, contentIndex, annotationIndex, outputIndex));
    });
  };

  const emitArtifacts = (item: OutputItem, kind: ToolKind, outputIndex: number) => {
    const id = identifier(item.id) ?? `output-${outputIndex}`;
    if (kind === 'code_interpreter') {
      const outputs = Array.isArray(item.outputs) ? item.outputs : [];
      outputs.forEach((outputValue, outputItemIndex) => {
        if (!isObject(outputValue)) return;
        const fileId = identifier(outputValue.file_id);
        if (!fileId) return;
        const artifact: ArtifactBlock = {
          version: CONTENT_BLOCK_VERSION,
          id: `artifact:${id}:${outputItemIndex}`,
          type: 'artifact',
          kind: outputValue.type === 'image' ? 'image' : 'file',
          name: text(outputValue.filename, 240) ?? (outputValue.type === 'image' ? 'Code output image' : 'Code output file'),
          reference: { type: 'openai_file', fileId },
        };
        emitBlock(artifact);
      });
    }
    // Image-generation results are base64 payloads. Keep only the safe status
    // reference in history; do not persist megabytes of binary as chat text.
    if (kind === 'image_generation' && typeof item.result === 'string' && item.result.length) {
      emitBlock({
        version: CONTENT_BLOCK_VERSION,
        id: `artifact:${id}:image`,
        type: 'artifact',
        kind: 'image',
        name: 'Generated image',
        reference: { type: 'none' },
      });
    }
  };

  const processOutputItem = (item: OutputItem, outputIndex: number, phase: 'added' | 'done') => {
    const kind = toolKind(item.type);
    const id = identifier(item.id) ?? `output-${outputIndex}`;
    if (kind) {
      const fallback: ToolStatus = phase === 'done' ? 'completed' : 'in_progress';
      const status = statusFrom(item.status, fallback);
      emitTool(id, kind, status, itemLabel(item, kind), {
        query: itemQuery(item),
        referenceId: identifier(item.call_id) ?? identifier(item.id),
      });
      emitArtifacts(item, kind, outputIndex);
      return;
    }
    emitAnnotations(item, outputIndex);
    if (item.type === 'message' || (item.type == null && Array.isArray(item.content)) || item.type === 'reasoning' || item.type === 'compaction') return;
    const type = text(item.type, 120) ?? 'unknown';
    emitBlock({ version: CONTENT_BLOCK_VERSION, id: `unknown:${id}`, type: 'unknown', sourceType: type, label: 'Unsupported response item' });
  };

  const fallbackItems = (responseOutput: unknown): Array<{ item: OutputItem; outputIndex: number }> => {
    if (Array.isArray(responseOutput) && responseOutput.length) {
      return responseOutput.filter(isObject).map((item, outputIndex) => ({ item: item as OutputItem, outputIndex }));
    }
    return [...outputItems.values()].sort((a, b) => a.outputIndex - b.outputIndex);
  };

  const textFallback = (items: Array<{ item: OutputItem; outputIndex: number }>): string => {
    if (receivedUnmappedText) return '';
    const parts: string[] = [];
    for (const { item, outputIndex } of items) {
      if ((item.type !== 'message' && item.type != null) || !Array.isArray(item.content)) continue;
      const itemId = identifier(item.id);
      item.content.forEach((partValue, contentIndex) => {
        if (!isObject(partValue) || partValue.type !== 'output_text' || typeof partValue.text !== 'string') return;
        const key = itemId ? `${itemId}:${contentIndex}` : `output-${outputIndex}:${contentIndex}`;
        if (streamedTextParts.has(key) || (!itemId && receivedText)) return;
        parts.push(partValue.text);
      });
    }
    return parts.join('');
  };

  const reconcileCompleted = (response: unknown) => {
    const payload = isObject(response) ? response : {};
    const items = fallbackItems(payload.output);
    for (const { item, outputIndex } of items) processOutputItem(item, outputIndex, 'done');

    const usage = usageFrom(payload.usage);
    if (usage) {
      const current = JSON.stringify(usage);
      if (current !== latestUsage) { latestUsage = current; onDelta({ usage }); }
    }

    if (!finalTextEmitted) {
      const fallback = textFallback(items);
      finalTextEmitted = true;
      if (fallback) onDelta({ content: fallback });
    }

    // A successful terminal response also closes tool progress cards if a
    // gateway omitted the per-tool completed event and final output item.
    for (const block of blocks.values()) {
      if (block.type === 'tool' && block.status === 'in_progress') emitTool(block.id.slice('tool:'.length), block.tool, 'completed', block.label, { query: block.query, referenceId: block.referenceId });
    }
  };

  const markOpenTools = (status: 'failed' | 'incomplete') => {
    for (const block of blocks.values()) {
      if (block.type === 'tool' && block.status === 'in_progress') emitTool(block.id.slice('tool:'.length), block.tool, status, block.label, { query: block.query, referenceId: block.referenceId });
    }
  };

  const processToolLifecycle = (type: string, payload: JsonObject) => {
    const match = /^response\.(web_search_call|file_search_call|mcp_call|code_interpreter_call|image_generation_call)\.(in_progress|searching|generating|completed|failed)$/.exec(type);
    if (!match) return false;
    const kind = toolKind(`${match[1]}`);
    if (!kind) return false;
    const itemId = identifier(payload.item_id) ?? `output-${index(payload.output_index) ?? 0}`;
    const rawStatus = match[2];
    const status: ToolStatus = rawStatus === 'failed' ? 'failed' : rawStatus === 'completed' ? 'completed' : 'in_progress';
    const existing = blocks.get(`tool:${itemId}`);
    emitTool(itemId, kind, status, existing?.type === 'tool' ? existing.label : itemLabel({}, kind), {
      query: existing?.type === 'tool' ? existing.query : undefined,
      referenceId: existing?.type === 'tool' ? existing.referenceId : itemId,
    });
    return true;
  };

  const processEvent = (frame: string) => {
    const fields = frame.split(/\r?\n|\r/);
    const eventName = fields.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = fields.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') return;
    let event: unknown;
    try { event = JSON.parse(data); } catch { throw new Error('invalidStream'); }
    if (!isObject(event)) throw new Error('invalidStream');
    const type = text(event.type, 120) ?? eventName ?? '';

    if (type === 'response.output_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta) {
        receivedText = true;
        const itemId = identifier(event.item_id), contentIndex = index(event.content_index) ?? 0;
        if (itemId) streamedTextParts.add(`${itemId}:${contentIndex}`);
        else receivedUnmappedText = true;
        onDelta({ content: delta });
      }
    } else if (type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta === 'string' && event.delta) onDelta({ reasoning: event.delta });
    } else if (type === 'response.output_text.annotation.added') {
      emitAnnotation(event.annotation, identifier(event.item_id) ?? `output-${index(event.output_index) ?? 0}`, index(event.content_index) ?? 0, index(event.annotation_index) ?? 0, index(event.output_index) ?? 0);
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = isObject(event.item) ? event.item as OutputItem : undefined;
      if (item) {
        const outputIndex = index(event.output_index) ?? outputItems.size;
        const key = identifier(item.id) ?? `output-${outputIndex}`;
        outputItems.set(key, { item, outputIndex });
        processOutputItem(item, outputIndex, type.endsWith('.done') ? 'done' : 'added');
      }
    } else if (type === 'response.function_call_arguments.done') {
      // Surface only that a request was formed. Arguments are never executed
      // or copied into the visible rich block.
      const itemId = identifier(event.item_id) ?? `output-${index(event.output_index) ?? 0}`;
      const existing = blocks.get(`tool:${itemId}`);
      const label = existing?.type === 'tool' ? existing.label : `Function request: ${text(event.name, 100) ?? 'unnamed function'}`;
      emitTool(itemId, 'function', 'completed', label, { referenceId: itemId });
    } else if (!processToolLifecycle(type, event)) {
      if (type === 'response.completed') {
        completed = true;
        const response = isObject(event.response) ? event.response : {};
        reconcileCompleted(response);
      } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'response.cancelled' || type === 'error' || eventName === 'error' || event.error) {
        failure = 'streamError';
        markOpenTools(type === 'response.incomplete' || type === 'response.cancelled' ? 'incomplete' : 'failed');
      }
    }
  };

  const consumeFrame = (frame: string) => {
    processEvent(frame);
  };

  const takeFrames = (flush: boolean) => {
    let match: RegExpExecArray | null;
    const delimiter = /\r\n\r\n|\n\n|\r\r/g;
    while ((match = delimiter.exec(buffer))) {
      consumeFrame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      delimiter.lastIndex = 0;
    }
    if (flush && buffer) { consumeFrame(buffer); buffer = ''; }
  };

  return {
    push(bytes: Uint8Array) {
      buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 2_000_000) {
        markOpenTools('incomplete');
        throw new Error('limit');
      }
      try { takeFrames(false); }
      catch (error) {
        markOpenTools('incomplete');
        throw error;
      }
    },
    finish() {
      buffer += decoder.decode();
      try { takeFrames(true); }
      catch (error) {
        markOpenTools('incomplete');
        throw error;
      }
      if (failure) throw new Error(failure);
      if (!completed) {
        markOpenTools('incomplete');
        throw new Error('incomplete');
      }
    },
    abort() { markOpenTools('incomplete'); },
  };
}
