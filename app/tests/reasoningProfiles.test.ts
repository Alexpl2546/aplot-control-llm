import { describe, expect, it } from 'vitest';
import { reasoningFor, reasoningLevels } from '../src/features/reasoning/reasoning';
import { cloudReasoningKey, localReasoningKey, taskReasoningKey, type ReasoningProfile } from '../src/features/reasoning/profiles';

const sol: ReasoningProfile = { control: 'effort', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id })), default: 'low', canDisable: false, wire: 'codex-effort' };
const qwen: ReasoningProfile = { control: 'toggle', levels: [], canDisable: true, wire: 'enable_thinking' };

describe('per-model reasoning levels', () => {
  it('offers the model\'s own levels, ultra included, and falls back to auto for others', () => {
    expect(reasoningLevels('chatgpt', sol)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(reasoningFor('chatgpt', 'ultra', sol)).toBe('ultra');
    expect(reasoningFor('chatgpt', 'none', sol)).toBe('');
    expect(reasoningLevels('chatgpt')).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
  });

  it('gives a thinking switch only on and off, and hides the menu without thinking', () => {
    expect(reasoningLevels('local', qwen)).toEqual(['', 'none']);
    expect(reasoningFor('local', 'high', qwen)).toBe('');
    expect(reasoningLevels('local', { ...qwen, control: 'none', canDisable: false })).toEqual([]);
  });

  it('spells keys the way the backend stores them', () => {
    expect(localReasoningKey('\\\\?\\C:/Models/Qwen.GGUF')).toBe('local:c:\\models\\qwen.gguf');
    expect(cloudReasoningKey('codex', 'c1', 'gpt-6.1-sol')).toBe('codex:c1:gpt-6.1-sol');
    expect(taskReasoningKey({ runtime: 'claude', connectionId: 'k', cloudModel: 'claude-opus-5-5' }, () => undefined)).toBe('claude:k:claude-opus-5-5');
    expect(taskReasoningKey({ runtime: 'hermes', binding: { runId: 'r' } }, () => 'C:/m/a.gguf')).toBe('local:c:\\m\\a.gguf');
  });
});
