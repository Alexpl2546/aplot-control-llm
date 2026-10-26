import type { TaskCategory, TaskDraft, TaskPreset } from './types';

export const PRESETS: Record<TaskPreset, { category: TaskCategory; freedom: number; depth: number; detail: number; context: number; output: number[] }> = {
  coding: { category: 'coding', freedom: 20, depth: 3, detail: 3, context: 32768, output: [1024, 2048, 4096, 6144, 8192] },
  quickFix: { category: 'coding', freedom: 10, depth: 1, detail: 2, context: 16384, output: [512, 1024, 2048, 4096, 6144] },
  agent: { category: 'coding', freedom: 20, depth: 4, detail: 4, context: 32768, output: [2048, 4096, 8192, 12288, 16384] },
  documents: { category: 'documents', freedom: 15, depth: 3, detail: 3, context: 32768, output: [512, 1024, 2048, 4096, 8192] },
  json: { category: 'documents', freedom: 0, depth: 1, detail: 2, context: 16384, output: [512, 1024, 2048, 4096, 8192] },
  translation: { category: 'documents', freedom: 20, depth: 2, detail: 3, context: 16384, output: [1024, 2048, 4096, 8192, 12288] },
  analysis: { category: 'analysis', freedom: 25, depth: 4, detail: 4, context: 32768, output: [1024, 2048, 4096, 6144, 8192] },
  design: { category: 'design', freedom: 80, depth: 3, detail: 3, context: 16384, output: [512, 1024, 2048, 4096, 8192] },
  designRefine: { category: 'design', freedom: 35, depth: 3, detail: 4, context: 32768, output: [1024, 2048, 4096, 6144, 8192] },
  chat: { category: 'other', freedom: 60, depth: 2, detail: 2, context: 16384, output: [256, 512, 1024, 2048, 4096] },
  creative: { category: 'other', freedom: 75, depth: 3, detail: 4, context: 32768, output: [1024, 2048, 4096, 6144, 8192] },
};
export const CATEGORY_DEFAULTS: Record<TaskCategory, TaskPreset> = { coding: 'coding', documents: 'documents', analysis: 'analysis', design: 'design', other: 'chat' };
export function presetDraft(preset: TaskPreset, pins: Pick<TaskDraft, 'pinnedProfileId' | 'pinnedTemperature'> = {}): TaskDraft {
  const { freedom, depth, detail, context } = PRESETS[preset];
  return { preset, freedom, depth, detail, context, priority: 'balanced', ...pins };
}
export function validDraft(value: unknown): value is TaskDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as TaskDraft;
  return Object.hasOwn(PRESETS, d.preset) && Number.isInteger(d.freedom) && d.freedom >= 0 && d.freedom <= 100
    && Number.isInteger(d.depth) && d.depth >= 1 && d.depth <= 5 && Number.isInteger(d.detail) && d.detail >= 1 && d.detail <= 5
    && (d.context === 'auto' || [8192, 16384, 32768, 65536, 131072].includes(d.context))
    && ['fast', 'balanced', 'careful'].includes(d.priority)
    && (d.pinnedProfileId === undefined || typeof d.pinnedProfileId === 'string')
    && (d.pinnedTemperature === undefined || (Number.isFinite(d.pinnedTemperature) && d.pinnedTemperature >= 0 && d.pinnedTemperature <= 2));
}
