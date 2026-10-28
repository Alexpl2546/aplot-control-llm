import { Brain } from 'lucide-react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';

/** '' keeps the model's own default; 'none' turns thinking off where the model allows it. */
export type ReasoningLevel = '' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningProvider = 'local' | 'chatgpt' | 'claude';

const LEVELS: Record<ReasoningProvider, ReasoningLevel[]> = {
  local: ['', 'none', 'low', 'medium', 'high'],
  chatgpt: ['', 'low', 'medium', 'high', 'xhigh'],
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export function reasoningLevels(provider: ReasoningProvider) { return LEVELS[provider]; }
/** A level the provider cannot take falls back to the model default. */
export function reasoningFor(provider: ReasoningProvider, level: ReasoningLevel | undefined): ReasoningLevel { return level && LEVELS[provider].includes(level) ? level : ''; }

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

export function ReasoningSelect({ provider, value, onChange, disabled, className, hint }: { provider: ReasoningProvider; value: ReasoningLevel | undefined; onChange: (level: ReasoningLevel) => void; disabled?: boolean; className?: string; hint?: string }) {
  const { t } = useTranslation();
  const current = reasoningFor(provider, value);
  // The brain icon sits inside the trigger, next to the level, like a model's icon in a model list.
  return <span className={`reasoningSelect${className ? ` ${className}` : ''}`} title={hint ?? t('reasoning.hint')}>
    <ChoiceSelect label={t('reasoning.label')} value={current} disabled={disabled} options={LEVELS[provider].map(level => ({ value: level, label: t(`reasoning.level.${level || 'auto'}`), icon: <Brain size={14} aria-hidden="true"/> }))} onChange={level => onChange(level as ReasoningLevel)}/>
  </span>;
}
