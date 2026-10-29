import { Brain } from 'lucide-react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import type { ReasoningProfile } from './profiles';

/** '' keeps the model's own default; 'none' turns thinking off where the model allows it; other ids are the model's own (`low`…`max`, `ultra`). */
export type ReasoningLevel = string;
export type ReasoningProvider = 'local' | 'chatgpt' | 'claude';

/** Used only while a model's own list is unknown. */
const LEVELS: Record<ReasoningProvider, ReasoningLevel[]> = {
  local: ['', 'none', 'low', 'medium', 'high'],
  chatgpt: ['', 'low', 'medium', 'high', 'xhigh'],
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** The levels to offer: the model's own list when known, else the provider's usual one. */
export function reasoningLevels(provider: ReasoningProvider, profile?: ReasoningProfile): ReasoningLevel[] {
  if (!profile) return LEVELS[provider];
  if (profile.control === 'none') return [];
  return ['', ...(profile.canDisable ? ['none'] : []), ...(profile.control === 'effort' ? profile.levels.map(level => level.id) : [])];
}
/** A level the model cannot take falls back to its default, so the request is never refused for it. */
export function reasoningFor(provider: ReasoningProvider, level: ReasoningLevel | undefined, profile?: ReasoningProfile): ReasoningLevel { return level && reasoningLevels(provider, profile).includes(level) ? level : ''; }

const STORAGE = 'aplot.chatReasoning';
function read(): Partial<Record<ReasoningProvider, ReasoningLevel>> {
  try { return JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Record<ReasoningProvider, ReasoningLevel>>; } catch { return {}; }
}
/** The chat remembers one level per provider on this device. */
export const useChatReasoning = create<{ levels: Partial<Record<ReasoningProvider, ReasoningLevel>>; set: (provider: ReasoningProvider, level: ReasoningLevel) => void }>(set => ({
  levels: read(),
  set: (provider, level) => set(state => {
    const levels = { ...state.levels, [provider]: level };
    try { localStorage.setItem(STORAGE, JSON.stringify(levels)); } catch { /* optional */ }
    return { levels };
  }),
}));

export function ReasoningSelect({ provider, profile, value, onChange, disabled, className, hint }: { provider: ReasoningProvider; profile?: ReasoningProfile; value: ReasoningLevel | undefined; onChange: (level: ReasoningLevel) => void; disabled?: boolean; className?: string; hint?: string }) {
  const { t } = useTranslation();
  const levels = reasoningLevels(provider, profile);
  const current = reasoningFor(provider, value, profile);
  if (!levels.length) return null;
  const name = (id: string) => profile?.levels.find(level => level.id === id)?.label ?? t(`reasoning.level.${id}`, { defaultValue: id.charAt(0).toUpperCase() + id.slice(1) });
  // "Auto" names what the model does on its own, when it says so.
  const auto = profile?.default ? t('reasoning.autoWith', { level: name(profile.default).toLocaleLowerCase() }) : profile?.control === 'toggle' ? t('reasoning.autoThinks') : t('reasoning.level.auto');
  // The brain icon sits inside the trigger, next to the level, like a model's icon in a model list.
  return <span className={`reasoningSelect${className ? ` ${className}` : ''}`} title={hint ?? t('reasoning.hint')}>
    <ChoiceSelect label={t('reasoning.label')} value={current} disabled={disabled} options={levels.map(level => ({ value: level, label: level ? level === 'none' ? t('reasoning.level.none') : name(level) : auto, icon: <Brain size={14} aria-hidden="true"/> }))} onChange={level => onChange(level as ReasoningLevel)}/>
  </span>;
}
