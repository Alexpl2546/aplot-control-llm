import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Bot, Check, FolderOpen, Plus, Settings2, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Primitives';
import { useControlStore } from '../../store/control';
import { cloudSelection, useOpenAi } from '../openai/store';
import { AgentIcon, agentName } from './AgentIdentity';
import { PresetModelBadge, openAgentPreset } from './AgentPresets';
import { bindRun, type AgentPreset, type AgentProject } from './workspaceModel';
import { createTask, editTask, useWorkspaceStore } from './workspace';
import { useAgentStore } from './store';

const LAST_AGENT = 'aplot.lastTaskAgent';
const readLast = () => { try { return localStorage.getItem(LAST_AGENT) ?? ''; } catch { return ''; } };

/**
 * Starting a task is one step: pick who does it, say what to do, press Enter.
 * The text becomes the task title (first line) and its first message.
 */
export function TaskStarter({ project, onCreated, onCancel }: { project: AgentProject; onCreated: (taskId: string, send: boolean) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const presets = useWorkspaceStore(state => state.presets);
  const runs = useControlStore(state => state.runs), globalId = useControlStore(state => state.selectedRunId);
  const cloud = useOpenAi();
  const [presetId, setPresetId] = useState(() => { const last = readLast(); return presets.some(preset => preset.id === last) ? last : presets[0]?.id ?? ''; });
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (presetId && !presets.some(preset => preset.id === presetId)) setPresetId(presets[0]?.id ?? ''); }, [presets, presetId]);
  const preset = presets.find(item => item.id === presetId);
  const fallback = runs.find(run => run.info.runId === globalId && ['ready', 'busy'].includes(run.info.state)) ?? runs.find(run => ['ready', 'busy'].includes(run.info.state));
  const recent = useWorkspaceStore(state => state.tasks.filter(task => task.projectId === project.id && !task.deletedAt && !task.archived).length);

  const create = () => {
    const body = text.trim();
    if (!body) return;
    const title = body.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 80);
    const runtime: AgentPreset['runtime'] = preset?.runtime ?? 'hermes';
    const binding = runtime === 'hermes' ? preset?.binding ?? (fallback ? bindRun(fallback.info, fallback.config?.profileName) : undefined) : undefined;
    const id = createTask(project.id, title, binding);
    const selection = runtime === 'hermes' ? undefined : cloudSelection(cloud, runtime === 'claude' ? 'claude' : 'openai', undefined, preset?.connectionProfileId);
    editTask(id, {
      runtime, presetId: preset?.id, agentName: preset?.name, accessMode: preset?.accessMode ?? 'manual', instructions: preset?.instructions ?? '', autoStartServer: preset?.autoStartServer, binding,
      cloudModel: selection ? preset?.model || selection.models[0]?.model : undefined,
      connectionId: selection?.status.connectionId, connectionProfileId: selection?.profile?.id,
    });
    useAgentStore.getState().update(id, state => ({ ...state, draft: body }));
    try { localStorage.setItem(LAST_AGENT, preset?.id ?? ''); } catch { /* optional */ }
    onCreated(id, true);
  };

  const examples = useMemo(() => ['review', 'fix', 'document'].map(key => t(`aw.example.${key}`)), [t]);
  const card = (item: AgentPreset | undefined) => {
    const selected = (item?.id ?? '') === presetId;
    return <button type="button" role="radio" aria-checked={selected} key={item?.id ?? 'custom'} className={`awAgentCard${selected ? ' isOn' : ''}`}
      style={item?.color ? { ['--c' as string]: item.color } : undefined} onClick={() => setPresetId(item?.id ?? '')}>
      {item ? <i className="presetDot" aria-hidden="true"/> : <span className="awAgentCardIcon"><AgentIcon runtime="hermes" size={14}/></span>}
      <span className="awAgentCardText"><b>{item?.name ?? t('aw.starter.noTemplate')}</b>{item ? <PresetModelBadge preset={item}/> : <small>{fallback ? `Hermes · ${fallback.info.name}` : t('aw.starter.noServer')}</small>}</span>
      {selected && <Check size={14} className="awAgentCardCheck"/>}
    </button>;
  };

  return <div className="awStarter">
    <div className="awStarterHead">
      <span className="awStarterProject"><FolderOpen size={14}/>{project.name}</span>
      <h2>{t('aw.starter.title')}</h2>
      <p>{t('aw.starter.hint')}</p>
    </div>
    <form className="awStarterBox" onSubmit={event => { event.preventDefault(); create(); }}>
      <textarea ref={input} rows={4} value={text} maxLength={100000} aria-label={t('aw.starter.placeholder')} placeholder={t('aw.starter.placeholder')}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); create(); } if (event.key === 'Escape' && onCancel) onCancel(); }}/>
      <div className="awStarterBar">
        <span className="awStarterWho">{preset ? <><i className="presetDot" style={preset.color ? { ['--c' as string]: preset.color } : undefined} aria-hidden="true"/>{preset.name}</> : <><AgentIcon runtime="hermes" size={13}/>{agentName('hermes')}</>}</span>
        <span className="awStarterKeys">{t('aw.starter.keys')}</span>
        {onCancel && <Button type="button" onClick={onCancel}>{t('aw.cancel')}</Button>}
        <button type="submit" className="awComposerSubmit" disabled={!text.trim()} aria-label={t('aw.starter.create')} title={t('aw.starter.create')}><ArrowUp size={20}/></button>
      </div>
    </form>
    {!text && <div className="awStarterExamples">{examples.map(example => <button type="button" key={example} onClick={() => { setText(example); input.current?.focus(); }}><Sparkles size={13}/>{example}</button>)}</div>}
    <section className="awStarterAgents" aria-label={t('aw.starter.who')}>
      <header><h3>{t('aw.starter.who')}</h3><button type="button" className="awTextAction" onClick={() => openAgentPreset('')}><Plus size={13}/>{t('presets.add')}</button></header>
      <div role="radiogroup" aria-label={t('aw.starter.who')} className="awAgentGrid">
        {card(undefined)}
        {presets.map(card)}
      </div>
      {preset && <button type="button" className="awTextAction awStarterEdit" onClick={() => openAgentPreset(preset.id)}><Settings2 size={13}/>{t('aw.starter.editAgent', { name: preset.name })}</button>}
    </section>
    {recent === 0 && <p className="awStarterFoot"><Bot size={14}/>{t('aw.starter.firstHint')}</p>}
  </div>;
}

/** No project yet: what the workspace is and the three steps to start. */
export function WorkspaceWelcome({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const steps: [string, string][] = [['aw.welcome.step1', 'aw.welcome.step1Hint'], ['aw.welcome.step2', 'aw.welcome.step2Hint'], ['aw.welcome.step3', 'aw.welcome.step3Hint']];
  return <div className="awHero">
    <div className="awHeroOrb" aria-hidden="true"><i/><i/><i/><b/></div>
    <h2>{t('aw.welcome')}</h2>
    <p>{t('aw.welcome.lead')}</p>
    <ol className="awHeroSteps">{steps.map(([title, hint], index) => <li key={title}><span className="kMono">{index + 1}</span><b>{t(title)}</b><small>{t(hint)}</small></li>)}</ol>
    <Button className="primary" onClick={onOpen}><FolderOpen size={16}/>{t('aw.openFolder')}</Button>
  </div>;
}
