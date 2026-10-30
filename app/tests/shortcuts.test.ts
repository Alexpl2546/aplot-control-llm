import { beforeEach, describe, expect, it } from 'vitest';
import { actionFor, comboLabel, comboOf, useShortcuts } from '../src/lib/shortcuts';

const press = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

describe('keyboard shortcuts', () => {
  beforeEach(() => useShortcuts.getState().reset());

  it('reads the physical key, so the Russian layout gives the same combo', () => {
    expect(comboOf(press('KeyK', { ctrlKey: true }))).toBe('Ctrl+K');
    expect(comboOf(press('Numpad3', { ctrlKey: true }))).toBe('Ctrl+3');
    expect(comboOf(press('ControlLeft', { ctrlKey: true }))).toBeUndefined();
    expect(actionFor('Ctrl+Comma')).toBe('settings');
    expect(comboLabel('Ctrl+Comma')).toBe('Ctrl ,');
  });

  it('moves a combo to its new action instead of letting it do two things', () => {
    useShortcuts.getState().assign('mini', 'Ctrl+K');
    expect(actionFor('Ctrl+K')).toBe('mini');
    expect(useShortcuts.getState().map.palette).toBe('');
  });
});
