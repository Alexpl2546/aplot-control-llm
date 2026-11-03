/** Versioned, persistence-safe rich blocks produced by supported chat providers. */
export const CONTENT_BLOCK_VERSION = 1 as const;
/** Keep persisted rich content in sync with chat history validation limits. */
export const MAX_CONTENT_BLOCKS = 256;

interface BlockBase {
  version: typeof CONTENT_BLOCK_VERSION;
  id: string;
}

export interface CitationBlock extends BlockBase {
  type: 'citation';
  source: 'web' | 'file';
  title: string;
  url?: string;
  fileId?: string;
  excerpt?: string;
  startIndex?: number;
  endIndex?: number;
}

export type ToolKind = 'web_search' | 'file_search' | 'function' | 'mcp' | 'code_interpreter' | 'image_generation' | 'unknown';
export type ToolStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete';

export interface ToolBlock extends BlockBase {
  type: 'tool';
  tool: ToolKind;
  status: ToolStatus;
  label: string;
  summary?: string;
  query?: string;
  referenceId?: string;
}

export interface ArtifactBlock extends BlockBase {
  type: 'artifact';
  kind: 'file' | 'image' | 'code' | 'other';
  name: string;
  reference: { type: 'openai_file'; fileId: string } | { type: 'none' };
}

export interface TableBlock extends BlockBase {
  type: 'table';
  title?: string;
  columns: string[];
  rows: string[][];
}

export interface ChartBlock extends BlockBase {
  type: 'chart';
  title?: string;
  series: Array<{
    name: string;
    points: Array<{ x: string | number; y: number }>;
  }>;
}

export interface UnknownBlock extends BlockBase {
  type: 'unknown';
  sourceType: string;
  label: string;
  summary?: string;
}

export type ContentBlock = CitationBlock | ToolBlock | ArtifactBlock | TableBlock | ChartBlock | UnknownBlock;

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/** Only ordinary web URLs may become clickable; file, data and script URLs stay inert. */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function cleanText(value: unknown, limit = 1000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, limit) : undefined;
}

function safeId(value: unknown): string | undefined {
  const id = cleanText(value, 240);
  return id && !/[\r\n]/.test(id) ? id : undefined;
}

function indexValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unknownBlock(id: string, sourceType: string, label = 'Unsupported response content'): UnknownBlock {
  return { version: CONTENT_BLOCK_VERSION, id, type: 'unknown', sourceType: cleanText(sourceType, 120) ?? 'unknown', label };
}

/**
 * Validates persisted or provider-supplied data before rendering. Invalid and
 * future variants degrade to a readable inert block instead of being executed.
 */
export function normalizeContentBlock(value: unknown, fallbackId = 'unsupported'): ContentBlock | null {
  if (!isRecord(value)) return unknownBlock(fallbackId, 'invalid');
  const id = safeId(value.id) ?? fallbackId;
  const sourceType = cleanText(value.type, 120) ?? 'unknown';
  if (value.version !== CONTENT_BLOCK_VERSION) return unknownBlock(id, sourceType, 'Unsupported response content version');

  if (value.type === 'citation') {
    if (value.source !== 'web' && value.source !== 'file') return unknownBlock(id, sourceType);
    const block: CitationBlock = {
      version: CONTENT_BLOCK_VERSION,
      id,
      type: 'citation',
      source: value.source,
      title: cleanText(value.title, 300) ?? (value.source === 'web' ? 'Web source' : 'File source'),
    };
    const url = safeExternalUrl(value.url);
    const fileId = safeId(value.fileId);
    const excerpt = cleanText(value.excerpt, 600);
    const startIndex = indexValue(value.startIndex), endIndex = indexValue(value.endIndex);
    if (url) block.url = url;
    if (fileId) block.fileId = fileId;
    if (excerpt) block.excerpt = excerpt;
    if (startIndex !== undefined) block.startIndex = startIndex;
    if (endIndex !== undefined && (startIndex === undefined || endIndex >= startIndex)) block.endIndex = endIndex;
    return block;
  }

  if (value.type === 'tool') {
    const tool = ['web_search', 'file_search', 'function', 'mcp', 'code_interpreter', 'image_generation', 'unknown'].includes(String(value.tool)) ? value.tool as ToolKind : 'unknown';
    const status = ['in_progress', 'completed', 'failed', 'incomplete'].includes(String(value.status)) ? value.status as ToolStatus : 'incomplete';
    const block: ToolBlock = { version: CONTENT_BLOCK_VERSION, id, type: 'tool', tool, status, label: cleanText(value.label, 300) ?? 'Response tool' };
    const summary = cleanText(value.summary, 600), query = cleanText(value.query, 300), referenceId = safeId(value.referenceId);
    if (summary) block.summary = summary;
    if (query) block.query = query;
    if (referenceId) block.referenceId = referenceId;
    return block;
  }

  if (value.type === 'artifact') {
    if (!['file', 'image', 'code', 'other'].includes(String(value.kind))) return unknownBlock(id, sourceType);
    const ref = isRecord(value.reference) && value.reference.type === 'openai_file' && safeId(value.reference.fileId)
      ? { type: 'openai_file' as const, fileId: safeId(value.reference.fileId)! }
      : { type: 'none' as const };
    return {
      version: CONTENT_BLOCK_VERSION,
      id,
      type: 'artifact',
      kind: value.kind as ArtifactBlock['kind'],
      name: cleanText(value.name, 240) ?? 'Generated artifact',
      reference: ref,
    };
  }

  if (value.type === 'table') {
    const columns = Array.isArray(value.columns) ? value.columns.slice(0, 20).map(cell => cleanText(cell, 240) ?? '') : [];
    const rows = Array.isArray(value.rows) ? value.rows.slice(0, 100).map(row => Array.isArray(row) ? row.slice(0, 20).map(cell => cleanText(cell, 500) ?? '') : []) : [];
    if (!columns.length) return unknownBlock(id, sourceType);
    const title = cleanText(value.title, 240);
    return { version: CONTENT_BLOCK_VERSION, id, type: 'table', ...(title ? { title } : {}), columns, rows };
  }

  if (value.type === 'chart') {
    if (!Array.isArray(value.series)) return unknownBlock(id, sourceType);
    const series: ChartBlock['series'] = value.series.slice(0, 8).flatMap(item => {
      if (!isRecord(item) || !Array.isArray(item.points)) return [];
      const points = item.points.slice(0, 100).flatMap(point => {
        if (!isRecord(point) || typeof point.y !== 'number' || !Number.isFinite(point.y)) return [];
        if (typeof point.x !== 'string' && (typeof point.x !== 'number' || !Number.isFinite(point.x))) return [];
        const x = typeof point.x === 'string' ? point.x.slice(0, 100) : point.x;
        const y = point.y;
        return [{ x, y }];
      });
      return [{ name: cleanText(item.name, 120) ?? 'Series', points }];
    });
    if (!series.length) return unknownBlock(id, sourceType);
    const title = cleanText(value.title, 240);
    return { version: CONTENT_BLOCK_VERSION, id, type: 'chart', ...(title ? { title } : {}), series };
  }

  if (value.type === 'unknown') {
    return unknownBlock(id, cleanText(value.sourceType, 120) ?? 'unknown', cleanText(value.label, 240) ?? 'Unsupported response content');
  }

  return unknownBlock(id, sourceType);
}
