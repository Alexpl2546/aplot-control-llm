import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => mocks.desktop }));

import { invoke } from '@tauri-apps/api/core';
import {
  createProjectDocument,
  documentFromSource,
  ProjectDocumentInputError,
  projectDocumentName,
  workbookFromCsv,
} from '../src/services/projectDocuments';

const file = {
  id: 'managed-doc',
  projectId: 'project-1',
  name: 'summary.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytes: 256,
  sha256: 'abc123',
  version: 1,
  createdAt: '2026-11-03T10:00:00Z',
  indexed: true,
  truncated: false,
};

beforeEach(() => { mocks.desktop = true; vi.mocked(invoke).mockReset(); });
afterEach(() => vi.clearAllMocks());

it('calls the native generator with the project id and typed request envelope', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(file);
  const request = {
    name: 'summary.docx',
    content: { format: 'docx' as const, document: { title: 'Summary', blocks: [{ type: 'paragraph' as const, text: 'Hello' }] } },
  };

  await expect(createProjectDocument('project-1', request)).resolves.toEqual(file);
  expect(invoke).toHaveBeenCalledWith('project_documents_create', { projectId: 'project-1', request });
});

it('keeps project document creation desktop-only', async () => {
  mocks.desktop = false;
  await expect(createProjectDocument('project-1', {
    name: 'summary.docx', content: { format: 'docx', document: { title: 'Summary', blocks: [] } },
  })).rejects.toThrow('desktop application');
  expect(invoke).not.toHaveBeenCalled();
});

it('adds the selected extension and rejects unsafe or mismatched Windows filenames', () => {
  expect(projectDocumentName('Quarterly report', 'pdf')).toBe('Quarterly report.pdf');
  expect(projectDocumentName('Quarterly report.docx', 'docx')).toBe('Quarterly report.docx');
  expect(() => projectDocumentName('../report', 'docx')).toThrow(ProjectDocumentInputError);
  expect(() => projectDocumentName('CON', 'xlsx')).toThrow(ProjectDocumentInputError);
  expect(() => projectDocumentName('NUL .other.docx', 'docx')).toThrow(ProjectDocumentInputError);
  for (const name of ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']) expect(() => projectDocumentName(name, 'docx')).toThrow(ProjectDocumentInputError);
  expect(() => projectDocumentName('report.pdf', 'docx')).toThrow(ProjectDocumentInputError);
  expect(() => projectDocumentName(' report ', 'docx')).toThrow(ProjectDocumentInputError);
});

it('converts simple Markdown headings, lists, paragraphs, and pipe tables into safe blocks', () => {
  const document = documentFromSource('Résumé', [
    '# Overview',
    '',
    'A paragraph with <literal> text.',
    '',
    '- First',
    '- Second',
    '',
    '| City | Notes |',
    '| --- | --- |',
    '| 東京 | A \\| B |',
  ].join('\n'));

  expect(document).toEqual({
    title: 'Résumé',
    blocks: [
      { type: 'heading', level: 1, text: 'Overview' },
      { type: 'paragraph', text: 'A paragraph with <literal> text.' },
      { type: 'bulletList', items: ['First', 'Second'] },
      { type: 'table', headers: ['City', 'Notes'], rows: [['東京', 'A | B']] },
    ],
  });
});

it('applies DOCX/PDF table limits separately from the larger workbook CSV limits', () => {
  const wideHeaders = Array.from({ length: 9 }, (_value, index) => `c${index}`);
  const wideTable = [
    `|${wideHeaders.join('|')}|`,
    `|${wideHeaders.map(() => '---').join('|')}|`,
  ].join('\n');
  expect(() => documentFromSource('Wide', wideTable)).toThrow(ProjectDocumentInputError);

  const tallTable = ['|value|', '|---|', ...Array.from({ length: 201 }, () => '|x|')].join('\n');
  expect(() => documentFromSource('Tall', tallTable)).toThrow(ProjectDocumentInputError);
});

it('parses quoted CSV commas, quotes, and line breaks while keeping every cell literal text', () => {
  const workbook = workbookFromCsv('Revenue', 'Name,Value,Note\r\n"Alpha, Inc.","=SUM(A1:A2)","line 1\r\nline 2"\r\n"Say ""hello""",12,plain');

  expect(workbook).toEqual({
    title: 'Revenue',
    sheets: [{
      name: 'Sheet1',
      columns: ['Name', 'Value', 'Note'],
      rows: [
        ['Alpha, Inc.', '=SUM(A1:A2)', 'line 1\r\nline 2'],
        ['Say "hello"', '12', 'plain'],
      ],
    }],
  });
  expect(typeof workbook.sheets[0]?.rows[0]?.[1]).toBe('string');
});

it('rejects malformed CSV quoting and inconsistent or oversized workbook shapes', () => {
  expect(() => workbookFromCsv('Bad', 'A,B\n"unterminated,1')).toThrow(ProjectDocumentInputError);
  expect(() => workbookFromCsv('Bad', 'A,B\n1')).toThrow(ProjectDocumentInputError);
  expect(() => workbookFromCsv('Bad', 'A,B\n"quoted" trailing,1')).toThrow(ProjectDocumentInputError);

  const tooManyColumns = Array.from({ length: 129 }, (_value, index) => `c${index}`).join(',');
  expect(() => workbookFromCsv('Wide', tooManyColumns)).toThrow(ProjectDocumentInputError);
  const tooManyCells = [Array.from({ length: 101 }, (_value, index) => `c${index}`).join(','), ...Array.from({ length: 100 }, () => Array(101).fill('x').join(','))].join('\n');
  expect(() => workbookFromCsv('Large', tooManyCells)).toThrow(ProjectDocumentInputError);
  const tooManyRows = ['value', ...Array.from({ length: 2_001 }, () => 'x')].join('\n');
  expect(() => workbookFromCsv('Tall', tooManyRows)).toThrow(ProjectDocumentInputError);
});

it('enforces UTF-8 text limits and rejects XML-invalid control characters', () => {
  expect(() => documentFromSource('Large', '🌍'.repeat(16_001))).toThrow(ProjectDocumentInputError);
  expect(() => documentFromSource('Bad', 'control\u0001')).toThrow(ProjectDocumentInputError);
  expect(() => workbookFromCsv('Bad\u0000', 'A\nvalue')).toThrow(ProjectDocumentInputError);
});
