import type { AgentEntry } from './store';
import { toolPath } from './workspaceModel';

type JsonObject = Record<string, unknown>;

export interface FileReceipt {
  id: string;
  name: string;
  version: number;
}

const EDIT_TOOLS = new Set(['apply_patch', 'edit_file', 'patch', 'write_file']);
const FILE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 100_000) return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function fileReceipt(value: unknown): FileReceipt | undefined {
  const file = object(value);
  if (!file || typeof file.id !== 'string' || !FILE_ID.test(file.id) || typeof file.name !== 'string' || !file.name.trim()
    || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)
    || typeof file.version !== 'number' || !Number.isSafeInteger(file.version) || file.version < 1) return undefined;
  return { id: file.id, name: file.name, version: file.version };
}

function aplotReceipt(entry: AgentEntry, result: JsonObject): JsonObject | undefined {
  if (entry.status !== 'success' && entry.status !== 'unknown') return undefined;
  if (entry.name?.startsWith('mcp__aplot__')) {
    if (result.is_error !== false) return undefined;
  } else if ('output' in result) {
    // A same-named tool from a different MCP server is not an Aplot receipt.
    if (object(entry.args)?.server !== 'aplot' || result.status !== 'completed') return undefined;
  } else {
    // The private Hermes bridge returns the Aplot tool response directly.
    return result.error ? undefined : result;
  }

  const output = json(result.output);
  const envelope = object(output);
  if (envelope?.isError === true) return undefined;
  if (entry.name?.startsWith('mcp__aplot__') && envelope && !('content' in envelope)) {
    return envelope.error ? undefined : envelope;
  }
  const content = envelope?.content ?? output;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = object(content[0]);
  if (block?.type !== 'text') return undefined;
  const receipt = object(json(block.text));
  return receipt?.error ? undefined : receipt;
}

// A check needs a recognizable, standalone command and a recorded exit code.
// Reject compound shell commands because the exit code may describe a different step.
const SHELL_WRAPPER = /^(?:"[^"\r\n]*[\\/](?:pwsh|powershell)(?:\.exe)?"|(?:pwsh|powershell)(?:\.exe)?|(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh))(?:[ \t]+(?:-NoProfile|-NoLogo|-NonInteractive))*[ \t]+(?:-Command|-l?c)[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+))$/i;
const CHECK_PREFIXES = [
  /^(?:npm|pnpm|yarn) (?:run )?(?:test|typecheck|lint|check|verify)(?::[\w-]+)*(?: |$)/,
  /^(?:(?:npx|pnpm exec) )?(?:vitest|jest|eslint)(?: |$)/,
  /^(?:python3? -m )?pytest(?: |$)/,
  /^cargo (?:test|check|clippy)(?: |$)/,
  /^go (?:test|vet)(?: |$)/,
  /^dotnet test(?: |$)/,
  /^git diff (?:--(?:cached|staged) )?--check(?: |$)/,
];
const NON_CHECK_FLAGS = /(?:^| )(?:-h|--help|--version|--listTests|--dry-run|--if-present)(?: |$)/;

function checkCommand(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  const command = value.trim();
  const shell = SHELL_WRAPPER.exec(command);
  const invocation = (shell?.[1] ?? shell?.[2] ?? shell?.[3] ?? command).trim();
  if (!/^[\w./:\\=@%+,-]+(?:[ \t]+[\w./:\\=@%+,-]+)*$/.test(invocation)) return undefined;
  const normalized = invocation.replace(/[ \t]+/g, ' ');
  if (NON_CHECK_FLAGS.test(normalized)) return undefined;
  return CHECK_PREFIXES.some(prefix => prefix.test(normalized)) ? invocation : undefined;
}

export function collectTurnResults(entries: readonly AgentEntry[]) {
  const saved = new Map<string, FileReceipt>();
  const documents = new Map<string, FileReceipt>();
  const edits = new Map<string, string[]>();
  const checks: { id: string; command: string; exitCode: number }[] = [];

  const addEdit = (path: string, diff: unknown) => {
    if (!path.trim()) return;
    const previews = edits.get(path) ?? [];
    if (typeof diff === 'string' && diff.trim() && !previews.includes(diff)) previews.push(diff);
    edits.set(path, previews);
  };

  for (const entry of entries) {
    if (entry.kind !== 'tool' || !entry.name) continue;
    const name = entry.name.replace(/^mcp__aplot__/, '');
    const aplotTool = name === 'aplot_save_artifact' || name === 'aplot_create_document';
    if (!aplotTool && name !== 'image_generation' && name !== 'terminal' && !EDIT_TOOLS.has(name)) continue;
    const result = object(json(entry.result));
    const args = object(entry.args);

    if (name === 'image_generation' && entry.status === 'success') {
      const receipt = fileReceipt(result?.artifact);
      if (receipt) saved.set(receipt.id, receipt);
    } else if (aplotTool && result) {
      const receipt = aplotReceipt(entry, result);
      if (name === 'aplot_save_artifact') {
        const file = fileReceipt(receipt);
        if (file) saved.set(file.id, file);
      } else if (receipt?.created === true) {
        const file = fileReceipt(receipt.file);
        if (file) documents.set(file.id, file);
      }
    } else if (EDIT_TOOLS.has(name) && entry.status === 'success') {
      const changes = Array.isArray(args?.changes) ? args.changes : [];
      if (changes.length) {
        for (const value of changes) {
          const change = object(value);
          if (typeof change?.path === 'string') addEdit(change.path, change.diff);
        }
      } else {
        addEdit(toolPath(entry.args, result), entry.diff);
      }
    } else if (name === 'terminal') {
      const code = result?.exit_code;
      if (typeof code !== 'number' || !Number.isSafeInteger(code) || entry.status !== (code === 0 ? 'success' : 'error')) continue;
      const command = checkCommand(args?.command);
      if (command) checks.push({ id: entry.id, command, exitCode: code });
    }
  }

  return { saved: [...saved.values()], documents: [...documents.values()], edits: [...edits], checks };
}
