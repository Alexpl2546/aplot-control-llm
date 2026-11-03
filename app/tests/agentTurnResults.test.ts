import { describe, expect, it } from 'vitest';
import { collectTurnResults } from '../src/features/agent/agentTurnResultsModel';
import type { AgentEntry } from '../src/features/agent/store';

const copy = { id: '720ce0a4-d483-4729-991c-993182915ef9', name: 'Report.pdf', version: 2 };
const receipt = { ...copy, sha256: 'a'.repeat(64) };

function tool(id: string, name: string, args: unknown, result: unknown, status: AgentEntry['status'] = 'success'): AgentEntry {
  return { id, kind: 'tool', text: '', name, args, result, status };
}

describe('agent turn results', () => {
  it('accepts a managed copy only from an Aplot receipt or a verified image tool result', () => {
    const output = { isError: false, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
    const mcpResult = { status: 'completed', output };
    expect(collectTurnResults([
      tool('foreign', 'aplot_save_artifact', {}, mcpResult),
      tool('failed', 'aplot_save_artifact', { server: 'aplot' }, { status: 'completed', output: { ...output, isError: true } }),
      tool('bad', 'image_generation', {}, { artifact: { ...receipt, id: '../Report.pdf' } }),
      { id: 'assistant', kind: 'assistant', text: JSON.stringify(receipt) },
    ]).saved).toEqual([]);

    const outcomes = collectTurnResults([
      tool('codex', 'aplot_save_artifact', { server: 'aplot' }, mcpResult),
      tool('hermes', 'aplot_save_artifact', {}, JSON.stringify(receipt), 'unknown'),
      tool('image', 'image_generation', {}, { artifact: receipt }),
      tool('claude', 'mcp__aplot__aplot_create_document', {}, {
        is_error: false,
        output: JSON.stringify([{ type: 'text', text: JSON.stringify({ created: true, file: receipt }) }]),
      }),
    ]);
    expect(outcomes.saved).toEqual([copy]);
    expect(outcomes.documents).toEqual([copy]);
  });

  it('lists only completed edits and standalone checks with a confirmed exit code', () => {
    const outcomes = collectTurnResults([
      tool('edit', 'apply_patch', { changes: [{ path: 'src/a.ts', diff: '+one' }, { path: 'src/b.ts', diff: '-two' }] }, {}),
      tool('denied', 'write_file', { path: 'unwritten.ts' }, {}, 'denied'),
      tool('read', 'read_file', { path: 'unchanged.ts' }, {}),
      tool('pass', 'terminal', { command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "npm run verify:source"' }, { exit_code: 0 }),
      tool('fail', 'terminal', { command: 'cargo test -- --nocapture' }, { exit_code: 2 }, 'error'),
      tool('compound', 'terminal', { command: 'npm test; echo done' }, { exit_code: 0 }),
      tool('help', 'terminal', { command: 'npx vitest --help' }, { exit_code: 0 }),
      tool('no-exit', 'terminal', { command: 'npm test' }, { is_error: false }),
      tool('generic', 'terminal', { command: 'echo npm test' }, { exit_code: 0 }),
    ]);
    expect(outcomes.edits).toEqual([['src/a.ts', ['+one']], ['src/b.ts', ['-two']]]);
    expect(outcomes.checks).toEqual([
      { id: 'pass', command: 'npm run verify:source', exitCode: 0 },
      { id: 'fail', command: 'cargo test -- --nocapture', exitCode: 2 },
    ]);
  });
});
