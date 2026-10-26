import type { LaunchConfig } from '../../types/config';
import type { LaunchProfile, ServerEngine } from '../../types/app';

export type TaskCategory = 'coding' | 'documents' | 'analysis' | 'design' | 'other';
export type TaskPreset = 'coding' | 'quickFix' | 'agent' | 'documents' | 'json' | 'translation' | 'analysis' | 'design' | 'designRefine' | 'chat' | 'creative';
export type TaskPriority = 'fast' | 'balanced' | 'careful';
export const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072] as const;
export interface TaskDraft {
  preset: TaskPreset;
  freedom: number;
  context: number | 'auto';
  depth: number;
  detail: number;
  priority: TaskPriority;
  pinnedProfileId?: string;
  pinnedTemperature?: number;
}
export interface TaskSnapshot {
  version: 1;
  sourceProfileId: string;
  draft: TaskDraft;
  request: Record<string, unknown>;
  contextPerRequest: number;
}
export interface TaskCandidate {
  id: string;
  profile: LaunchProfile;
  engine: ServerEngine;
  maxContext: number;
  family: 'qwen36' | 'flash' | 'gptoss' | 'other';
}
export interface TaskPlan {
  candidate?: TaskCandidate;
  alternatives: TaskCandidate[];
  context: number;
  outputTokens: number;
  temperature: number;
  request: Record<string, unknown>;
  config?: LaunchConfig;
  conflict?: 'missingModel' | 'context' | 'budget';
  reasoning: 'modelRecipe' | 'instruction';
  serverDefaults: boolean;
}
