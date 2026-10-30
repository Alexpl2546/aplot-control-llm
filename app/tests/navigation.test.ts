import { describe, expect, it } from 'vitest';
import { isModelView, modelsEntry, modelsTabOf, shortcutTarget, SHORTCUT_VIEWS } from '../src/lib/navigation';
import { useControlStore } from '../src/store/control';
import { benchmarkVerdict } from '../src/features/navigation/PickWizard';
import type { BenchmarkResult } from '../src/types/app';

describe('sidebar with one «Модели» item', () => {
  it('puts every local-model screen under a tab of «Модели»', () => {
    expect(['configuration', 'models', 'profiles', 'performance', 'logs', 'apiDocs'].every(view => isModelView(view as never))).toBe(true);
    expect(isModelView('chat')).toBe(false);
    expect(modelsTabOf('configuration')).toBe('pick');
    expect(modelsTabOf('profiles')).toBe('library');
    expect(modelsTabOf('apiDocs')).toBe('servers');
    expect(modelsTabOf('servers')).toBe('servers');
  });

  it('maps Ctrl+1…5 to the new order and reopens «Модели» where the user left it', () => {
    expect(SHORTCUT_VIEWS.map(shortcutTarget).slice(0, 4)).toEqual(['dashboard', 'agentWorkspace', 'chat', 'knowledge']);
    useControlStore.getState().setView('logs');
    useControlStore.getState().setView('chat');
    expect(modelsEntry()).toBe('logs');
    expect(shortcutTarget('modelsHub')).toBe('logs');
  });

  it('calls a check stable only when every window finished and the targets were met', () => {
    const result = (summary: { completedWindows: number; requestedWindows: number } | null, meetsTargets?: boolean) => ({ samples: [{}], suiteSummary: summary, meetsTargets } as unknown as BenchmarkResult);
    expect(benchmarkVerdict(undefined)).toBeUndefined();
    expect(benchmarkVerdict(result({ completedWindows: 4, requestedWindows: 4 }))).toBe('stable');
    expect(benchmarkVerdict(result({ completedWindows: 3, requestedWindows: 4 }))).toBe('compromise');
    expect(benchmarkVerdict(result({ completedWindows: 4, requestedWindows: 4 }, false))).toBe('compromise');
    expect(benchmarkVerdict(result(null))).toBe('stable');
  });
});
