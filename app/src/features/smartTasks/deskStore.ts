import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { TaskDraft } from './types';
import { validDraft } from './presets';

interface DeskState {
  drafts: Record<string, TaskDraft>;
  edit: (key: string, draft: TaskDraft) => void;
}
/** Only non-secret intent is persisted, separately for each run/editor. Never stores API credentials. */
export const useTaskDrafts = create<DeskState>()(persist((set) => ({
  drafts: {},
  edit: (key, draft) => {
    if (!validDraft(draft)) return;
    set(state => ({ drafts: Object.fromEntries([...Object.entries(state.drafts).filter(([id]) => id !== key).slice(-29), [key, draft]]) }));
  },
}), {
  name: 'aplot-smart-task-drafts-v1',
  storage: createJSONStorage(() => localStorage),
  partialize: state => ({ drafts: state.drafts }),
  merge: (persisted, current) => {
    const input = (persisted as Partial<DeskState> | undefined)?.drafts;
    return { ...current, drafts: input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, draft]) => validDraft(draft)).slice(-30)) : {} };
  },
}));
