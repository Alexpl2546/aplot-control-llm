import { invoke } from '@tauri-apps/api/core';
import type { ProjectFile } from './projectFiles';
import { isTauri } from './tauri';

export type DocumentFormat = 'docx' | 'pdf' | 'xlsx';

export type DocumentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string; level: 1 | 2 | 3 }
  | { type: 'bulletList'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'pageBreak' };

export interface TextDocument {
  title: string;
  blocks: DocumentBlock[];
}

export type WorkbookCell = string | number | boolean | null | { formula: string };

export interface WorkbookSheet {
  name: string;
  columns: string[];
  rows: WorkbookCell[][];
}

export interface WorkbookDocument {
  title: string;
  sheets: WorkbookSheet[];
}

export type ProjectDocumentContent =
  | { format: 'docx'; document: TextDocument }
  | { format: 'pdf'; document: TextDocument }
  | { format: 'xlsx'; workbook: WorkbookDocument };

export interface ProjectDocumentRequest {
  name: string;
  content: ProjectDocumentContent;
}

export type ProjectDocumentInputErrorCode =
  | 'invalid-title'
  | 'invalid-filename'
  | 'invalid-content'
  | 'invalid-csv'
  | 'limit';

export class ProjectDocumentInputError extends Error {
  readonly code: ProjectDocumentInputErrorCode;

  constructor(code: ProjectDocumentInputErrorCode) {
    super(code);
    this.name = 'ProjectDocumentInputError';
    this.code = code;
  }
}

const MAX_TEXT_BYTES = 64_000;
const MAX_SOURCE_BYTES = 256_000;
const MAX_BLOCKS = 100;
const MAX_DOCUMENT_TABLE_ROWS = 200;
const MAX_DOCUMENT_TABLE_COLUMNS = 8;
const MAX_CSV_ROWS = 2_000;
const MAX_CSV_COLUMNS = 128;
const MAX_CSV_CELLS = 10_000;
const SUPPORTED_EXTENSIONS = new Set<DocumentFormat>(['docx', 'pdf', 'xlsx']);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isValidXmlCharacter(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return point === 0x9 || point === 0xa || point === 0xd
    || (point >= 0x20 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd)
    || (point >= 0x10000 && point <= 0x10ffff);
}

function validateText(value: string, total: { bytes: number }): void {
  total.bytes += utf8Bytes(value);
  if (total.bytes > MAX_TEXT_BYTES) throw new ProjectDocumentInputError('limit');
  if (Array.from(value).some(character => !isValidXmlCharacter(character))) {
    throw new ProjectDocumentInputError('invalid-content');
  }
}

function validWindowsLeafName(value: string): boolean {
  if (!value || value.trim() !== value || value.endsWith('.') || value.endsWith(' ')) return false;
  if (/[/\\:*?"<>|\u0000-\u001f\u007f]/u.test(value)) return false;
  const reserved = value.split('.')[0]?.replace(/ +$/u, '').toUpperCase() ?? '';
  if (['CON', 'PRN', 'AUX', 'NUL'].includes(reserved)) return false;
  if (/^(?:COM|LPT)[1-9¹²³]$/u.test(reserved)) return false;
  return true;
}

/** Appends the selected format and validates the filename as a Windows-safe leaf. */
export function projectDocumentName(base: string, format: DocumentFormat): string {
  if (!SUPPORTED_EXTENSIONS.has(format)) throw new ProjectDocumentInputError('invalid-filename');
  const knownExtension = /\.(docx|pdf|xlsx)$/iu.exec(base);
  let stem = base;
  if (knownExtension) {
    if (knownExtension[1]?.toLowerCase() !== format) {
      throw new ProjectDocumentInputError('invalid-filename');
    }
    stem = base.slice(0, -knownExtension[0].length);
  }
  if (!validWindowsLeafName(stem)) throw new ProjectDocumentInputError('invalid-filename');
  const name = `${stem}.${format}`;
  if (utf8Bytes(name) > 200) throw new ProjectDocumentInputError('invalid-filename');
  return name;
}

function validateDocument(title: string, blocks: DocumentBlock[]): TextDocument {
  if (!title.trim()) throw new ProjectDocumentInputError('invalid-title');
  const total = { bytes: 0 };
  validateText(title, total);
  if (blocks.length > MAX_BLOCKS) throw new ProjectDocumentInputError('limit');
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        validateText(block.text, total);
        break;
      case 'bulletList':
        if (block.items.length > 200) throw new ProjectDocumentInputError('limit');
        block.items.forEach(item => validateText(item, total));
        break;
      case 'table':
        if (!block.headers.length || block.headers.length > MAX_DOCUMENT_TABLE_COLUMNS || block.rows.length > MAX_DOCUMENT_TABLE_ROWS) {
          throw new ProjectDocumentInputError('limit');
        }
        block.headers.forEach(header => validateText(header, total));
        for (const row of block.rows) {
          if (row.length !== block.headers.length) throw new ProjectDocumentInputError('invalid-content');
          row.forEach(cell => validateText(cell, total));
        }
        break;
      case 'pageBreak':
        break;
    }
  }
  return { title, blocks };
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitPipeRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell.trim()));
}

function splitPipeRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  const characters = Array.from(source);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (character === '\\' && (characters[index + 1] === '|' || characters[index + 1] === '\\')) {
      current += characters[index + 1];
      index += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Converts plain text with simple Markdown headings, lists, and pipe tables to declarative blocks. */
export function documentFromSource(title: string, source: string): TextDocument {
  if (utf8Bytes(source) > MAX_SOURCE_BYTES) throw new ProjectDocumentInputError('limit');
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      index += 1;
      continue;
    }

    const isListItem = (value: string) => /^\s*[-*]\s+\S/u.test(value);
    if (isListItem(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && isListItem(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/u, ''));
        index += 1;
      }
      blocks.push({ type: 'bulletList', items });
      continue;
    }

    const nextLine = lines[index + 1] ?? '';
    if (line.includes('|') && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      const headers = splitPipeRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        const row = splitPipeRow(lines[index] ?? '');
        if (row.length !== headers.length) throw new ProjectDocumentInputError('invalid-content');
        rows.push(row);
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return validateDocument(title, blocks);
}

function parseCsvRows(source: string): string[][] {
  if (!source.trim() || utf8Bytes(source) > MAX_SOURCE_BYTES) {
    throw new ProjectDocumentInputError(source.trim() ? 'limit' : 'invalid-csv');
  }

  const characters = Array.from(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;
  let atFieldStart = true;
  let endedWithNewline = false;

  const finishField = () => {
    row.push(field);
    field = '';
    quoteClosed = false;
    atFieldStart = true;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
    endedWithNewline = true;
    if (rows.length > MAX_CSV_ROWS + 1) throw new ProjectDocumentInputError('limit');
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (quoted) {
      endedWithNewline = false;
      if (character === '"') {
        if (characters[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed && character !== ',' && character !== '\r' && character !== '\n') {
      throw new ProjectDocumentInputError('invalid-csv');
    }
    if (character === ',') {
      endedWithNewline = false;
      finishField();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && characters[index + 1] === '\n') index += 1;
      finishRow();
    } else if (character === '"') {
      if (!atFieldStart || quoteClosed) throw new ProjectDocumentInputError('invalid-csv');
      quoted = true;
      atFieldStart = false;
      endedWithNewline = false;
    } else {
      if (quoteClosed) throw new ProjectDocumentInputError('invalid-csv');
      field += character;
      atFieldStart = false;
      endedWithNewline = false;
    }
  }

  if (quoted) throw new ProjectDocumentInputError('invalid-csv');
  if (!endedWithNewline) {
    finishField();
    rows.push(row);
  }
  return rows;
}

/** Creates a one-sheet workbook from RFC 4180-style CSV; every cell remains literal text. */
export function workbookFromCsv(title: string, source: string, sheetName = 'Sheet1'): WorkbookDocument {
  const records = parseCsvRows(source);
  const columns = records[0] ?? [];
  const rows = records.slice(1);
  if (!columns.length || columns.length > MAX_CSV_COLUMNS || columns.some(column => !column.trim())) {
    throw new ProjectDocumentInputError('invalid-csv');
  }
  if (rows.length > MAX_CSV_ROWS || rows.some(row => row.length !== columns.length)) {
    throw new ProjectDocumentInputError(rows.length > MAX_CSV_ROWS ? 'limit' : 'invalid-csv');
  }
  if (columns.length * (rows.length + 1) > MAX_CSV_CELLS) {
    throw new ProjectDocumentInputError('limit');
  }

  const total = { bytes: 0 };
  if (!title.trim()) throw new ProjectDocumentInputError('invalid-title');
  validateText(title, total);
  validateText(sheetName, total);
  for (const value of [...columns, ...rows.flat()]) validateText(value, total);
  return { title, sheets: [{ name: sheetName, columns, rows }] };
}

/** Creates a managed project document using the native local-only command. */
export async function createProjectDocument(
  projectId: string,
  request: ProjectDocumentRequest,
): Promise<ProjectFile> {
  if (!isTauri()) throw new Error('Project document creation is only available in the desktop application.');
  return invoke<ProjectFile>('project_documents_create', { projectId, request });
}
