import { create } from 'zustand';

/** Everything a keyboard shortcut can do; the order is the order in Settings. */
export const SHORTCUT_ACTIONS = ['palette', 'newServer', 'settings', 'mini', 'nav1', 'nav2', 'nav3', 'nav4', 'nav5'] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  palette: 'Ctrl+K', newServer: 'Ctrl+N', settings: 'Ctrl+Comma', mini: 'Ctrl+Shift+M',
  nav1: 'Ctrl+1', nav2: 'Ctrl+2', nav3: 'Ctrl+3', nav4: 'Ctrl+4', nav5: 'Ctrl+5',
};

/**
 * The combo of a key press, by physical key (`event.code`): Ctrl+K stays Ctrl+K in the Russian layout,
 * where `event.key` is «л». Returns undefined for a lone modifier.
 */
export function comboOf(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | undefined {
  const code = event.code;
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || !code) return undefined;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^(Digit|Numpad)[0-9]$/.test(code) ? code.slice(-1) : code;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', key].filter(Boolean).join('+');
}

/** How a combo reads on screen: «Ctrl ,», «Ctrl Shift M». */
export const comboLabel = (combo?: string) => combo ? combo.replace('Comma', ',').replace('Period', '.').replace('Slash', '/').split('+').join(' ') : '';

const KEY = 'aplot.shortcuts';
function read(): Record<ShortcutAction, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<ShortcutAction, string>>;
    return Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action, typeof stored[action] === 'string' ? stored[action] : DEFAULT_SHORTCUTS[action]])) as Record<ShortcutAction, string>;
  } catch { return { ...DEFAULT_SHORTCUTS }; }
}

interface Shortcuts {
  map: Record<ShortcutAction, string>;
  /** Assigns `combo`; an action that had it loses it (empty), so one combo never does two things. */
  assign: (action: ShortcutAction, combo: string) => void;
  reset: () => void;
}
export const useShortcuts = create<Shortcuts>((set, get) => ({
  map: read(),
  assign: (action, combo) => {
    const map = { ...get().map };
    for (const other of SHORTCUT_ACTIONS) if (other !== action && map[other] === combo) map[other] = '';
    map[action] = combo;
    set({ map });
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* kept for this session */ }
  },
  reset: () => { set({ map: { ...DEFAULT_SHORTCUTS } }); try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } },
}));

export const actionFor = (combo: string | undefined) => combo ? SHORTCUT_ACTIONS.find(action => useShortcuts.getState().map[action] === combo) : undefined;
export const shortcutLabel = (action: ShortcutAction) => comboLabel(useShortcuts.getState().map[action]);
