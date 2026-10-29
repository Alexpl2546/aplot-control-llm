import { LaunchFit } from '../resources/LaunchFit';
import { profileSelectOption } from '../../components/ui/selectOptions';
import { AplotTaskSelect } from '../../components/ui/AplotSelect';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braces, FileText, ChartNoAxesCombined, Palette, Ellipsis, Lightbulb, Layers3, BrainCircuit, AlignLeft, Zap, Scale, Target, LockKeyhole, LockKeyholeOpen, ChevronRight, Copy, RotateCcw, ArrowUpRight } from 'lucide-react';
import { useControlStore } from '../../store/control';
import { ENGINE_NAMES } from '../../lib/engineModels';
import { Button, Select } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { ResourcePlanPanel } from '../resources/ResourcePlanPanel';
import { createRunStartRequest } from '../../services/tauri';
import { restoreEngineOptions, captureEngineOptions } from '../launches/profiles';
import type { StartRunRequest } from '../../types/runtime';
import { PRESETS, CATEGORY_DEFAULTS, presetDraft, validDraft } from './presets';
import { comparableSpeed, contextIndex, planTask, sameTask, taskCandidates } from './planner';
import { useTaskDrafts } from './deskStore';
import { CONTEXT_STEPS, type TaskCategory, type TaskDraft, type TaskPlan, type TaskPreset } from './types';
import { SemanticSlider } from './SemanticSlider';
import { useGlider } from '../../components/ui/useGlider';
import { TaskApplicationError } from './application';

const CATEGORIES = [ ['coding', Braces], ['documents', FileText], ['analysis', ChartNoAxesCombined], ['design', Palette], ['other', Ellipsis] ] as const;
const PRIORITIES = [['fast', Zap], ['balanced', Scale], ['careful', Target]] as const;
const contextText = (context: number) => `${context / 1024}K`;
const candidateName = (plan: TaskPlan['candidate']) => plan?.profile.config.engineModel?.split(' · ')[0] || plan?.profile.config.modelAlias || plan?.profile.name.split(' · ')[0] || '';

function TaskResources({ plan }: { plan: TaskPlan }) {
  const { t } = useTranslation();
  const settings = useControlStore(s => s.settings);
  const capabilities = useControlStore(s => s.capabilities);
  const [request, setRequest] = useState<StartRunRequest | null>(null);
  const [error, setError] = useState('');
  const prepare = async () => {
    if (!plan.config || !plan.candidate) return;
    setRequest(null); setError('');
    try {
      const base = plan.candidate.profile.config;
      // Strata's immutable source JSON still holds its original context until explicit Apply.
      const config = plan.candidate.engine === 'strata' ? base : plan.config;
      const restored = restoreEngineOptions(base, settings);
      const captured = captureEngineOptions(config, restored);
      setRequest(await createRunStartRequest({ config: captured, settings: restored, profiles: [{ ...plan.candidate.profile, config: captured }], capabilities, runId: `task-preview:${plan.candidate.id}`, preview: true }));
    } catch { setError(t('smart.errors.preview')); }
  };
  return <div className="taskResources"><p>{t('smart.resourceNote')}</p>
    {plan.candidate?.engine === 'strata' && <p>{t('smart.sourceContext', { context: contextText(plan.candidate.maxContext) })}</p>}
    {!request && <Button onClick={() => void prepare()}>{t('smart.prepareResource')}</Button>}
    {error && <p role="alert">{error}</p>}
    {request && <ResourcePlanPanel request={request}/>}</div>;
}

export function SmartTaskDesk() {
  const { t, i18n } = useTranslation();
  const profiles = useControlStore(s => s.profiles);
  const strataModels = useControlStore(s => s.strataModels);
  const benchmarks = useControlStore(s => s.benchmarks);
  const library = useControlStore(s => s.libraryModels);
  const config = useControlStore(s => s.config);
  const runningConfig = useControlStore(s => s.runningConfig);
  const selectedRunId = useControlStore(s => s.selectedRunId);
  const busy = useControlStore(s => s.busy || s.optimizerRunning);
  const applyTaskProfile = useControlStore(s => s.applyTaskProfile);
  const setView = useControlStore(s => s.setView);
  const notify = useControlStore(s => s.notify);
  const key = selectedRunId ?? `editor:${config.profileId}`;
  const stored = useTaskDrafts(s => s.drafts[key]);
  const edit = useTaskDrafts(s => s.edit);
  const savedDraft = config.smartTask?.draft;
  const draft = stored ?? (validDraft(savedDraft) ? savedDraft : presetDraft('coding'));
  const update = (patch: Partial<TaskDraft>) => edit(key, { ...draft, ...patch });
  const candidates = useMemo(() => taskCandidates(profiles, strataModels, library), [profiles, strataModels, library]);
  const plan = useMemo(() => planTask(draft, candidates), [draft, candidates]);
  const category = PRESETS[draft.preset].category;
  const categoryGlide = useGlider<HTMLDivElement>(CATEGORIES.findIndex(([id]) => id === category));
  const priorityGlide = useGlider<HTMLDivElement>(PRIORITIES.findIndex(([id]) => id === draft.priority));
  const speed = useMemo(() => comparableSpeed(plan, benchmarks), [plan, benchmarks]);
  const [allModels, setAllModels] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [temperatureText, setTemperatureText] = useState<string>();
  const invalidTemperature = temperatureText !== undefined && (!temperatureText.trim() || !Number.isFinite(Number(temperatureText)) || Number(temperatureText) < 0 || Number(temperatureText) > 2);
  const commitTemperature = () => {
    if (temperatureText === undefined) return;
    if (invalidTemperature) notify('error', t('smart.invalidTemperature'));
    else update({ pinnedTemperature: Number(temperatureText) });
    setTemperatureText(undefined);
  };
  const saved = sameTask(config.smartTask, plan.config?.smartTask);
  const defaultsRunning = plan.serverDefaults && sameTask(runningConfig?.smartTask, plan.config?.smartTask);
  const status = plan.conflict ? 'unsupported' : defaultsRunning ? 'applied' : saved ? 'client' : runningConfig ? 'restart' : 'draft';
  const changed = ['freedom', 'context', 'depth', 'detail', 'priority'].some(k => draft[k as keyof TaskDraft] !== presetDraft(draft.preset)[k as keyof TaskDraft]) || draft.pinnedTemperature !== undefined;
  const number = (value: number) => value.toLocaleString(i18n.language, { maximumFractionDigits: 2 });
  const resetPreset = (preset: TaskPreset) => edit(key, presetDraft(preset, { pinnedProfileId: draft.pinnedProfileId, pinnedTemperature: draft.pinnedTemperature }));
  const apply = async () => {
    if (!plan.candidate || !plan.config || plan.conflict || saving || busy) return;
    setSaving(true); setError('');
    try {
      await applyTaskProfile(plan.candidate.id, plan.config, `${plan.candidate.profile.name} · ${t(`smart.presets.${draft.preset}`)}`);
      notify('success', t('smart.savedNotice'));
    } catch (reason) {
      setError(reason instanceof TaskApplicationError ? t(`smart.errors.${reason.code}`) : t('smart.errors.save'));
    } finally { setSaving(false); }
  };
  const copyRequest = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(plan.request, null, 2)); notify('success', t('smart.copied')); }
    catch { notify('error', t('smart.errors.copy')); }
  };
  const instructions = `${t(`smart.instructions.depth${draft.depth}`)} ${t(`smart.instructions.detail${draft.detail}`)}${draft.preset === 'json' ? ` ${t('smart.instructions.json')}` : ''}`;
  const copyInstructions = async () => {
    try { await navigator.clipboard.writeText(instructions); notify('success', t('smart.instructionsCopied')); }
    catch { notify('error', t('smart.errors.copy')); }
  };
  const selectCategory = (value: TaskCategory) => resetPreset(CATEGORY_DEFAULTS[value]);
  return <div className="taskDesk">
    <section className="taskControls panel" aria-label={t('smart.configure')}>
      <div className="taskSectionHead"><h3>{t('smart.chooseTask')}</h3><span className="taskPresetState">{changed ? t('smart.modified') : t('smart.preset')}</span></div>
      <div ref={categoryGlide} className="taskCategories kGlideHost" role="group" aria-label={t('smart.chooseTask')}>
        <span className="kGlide" aria-hidden="true"/>
        {CATEGORIES.map(([id, Icon]) => <button type="button" key={id} data-glide className={`taskCategory${category === id ? ' isSelected' : ''}`} aria-pressed={category === id} onClick={() => selectCategory(id)}>
          <Icon size={20}/><b>{t(`smart.categories.${id}.title`)}</b><span>{t(`smart.categories.${id}.description`)}</span>
        </button>)}
      </div>
      <div className="taskPresetBar"><label htmlFor="task-preset">{t('smart.scenario')}</label><AplotTaskSelect id="task-preset" label={t('smart.scenario')} value={draft.preset} onChange={value => resetPreset(value as TaskPreset)} options={(Object.keys(PRESETS) as TaskPreset[]).filter(id => PRESETS[id].category === category).map(id => ({ value: id, label: t(`smart.presets.${id}`), description:t(`smart.presetDescriptions.${id}`),icon:<PresetIcon preset={id}/> }))}/><button type="button" className="taskTextButton" onClick={() => resetPreset(draft.preset)} title={t('smart.reset')}><RotateCcw size={13}/>{t('smart.reset')}</button></div>
      <h3 className="taskBehaviorTitle">{t('smart.behavior')}</h3>
      <div className="taskSliders">
        <SemanticSlider icon={Lightbulb} title={t('smart.freedom')} description={t('smart.freedomHint')} value={draft.freedom} max={100} display={`${draft.freedom} / 100`} marks={[t('smart.marks.predictable'), t('smart.marks.varied'), t('smart.marks.unusual')]} onChange={freedom => update({ freedom })}/>
        <SemanticSlider icon={Layers3} title={t('smart.volume')} description={t('smart.volumeHint')} value={contextIndex(plan.context)} max={4} display={draft.context === 'auto' ? `${t('smart.auto')} · ${contextText(plan.context)}` : contextText(plan.context)} marks={CONTEXT_STEPS.map(contextText)} onChange={index => update({ context: CONTEXT_STEPS[index] })}
          extra={<button type="button" className={`taskAuto${draft.context === 'auto' ? ' isSelected' : ''}`} aria-pressed={draft.context === 'auto'} onClick={() => update({ context: draft.context === 'auto' ? plan.context : 'auto' })}>{t('smart.auto')}</button>}/>
        <SemanticSlider icon={BrainCircuit} title={t('smart.depth')} description={t('smart.depthHint')} min={1} value={draft.depth} max={5} display={`${draft.depth} / 5`} marks={[t('smart.marks.direct'), t('smart.marks.normal'), t('smart.marks.deep')]} onChange={depth => update({ depth })}/>
        <SemanticSlider icon={AlignLeft} title={t('smart.detail')} description={t('smart.detailHint')} min={1} value={draft.detail} max={5} display={`${draft.detail} / 5`} marks={[t('smart.marks.short'), t('smart.marks.detailed'), t('smart.marks.full')]} onChange={detail => update({ detail })}/>
      </div>
      <div className="taskPriority"><h3>{t('smart.priority')}</h3><div ref={priorityGlide} className="kGlideHost" role="group" aria-label={t('smart.priority')}>
        <span className="kGlide" aria-hidden="true"/>
        {PRIORITIES.map(([id, Icon]) => <button key={id} type="button" data-glide aria-pressed={draft.priority === id} className={draft.priority === id ? 'isSelected' : ''} onClick={() => update({ priority: id })}><Icon size={20}/><span><b>{t(`smart.priorities.${id}`)}</b><small>{t(`smart.priorityHints.${id}`)}</small></span></button>)}
      </div></div>
    </section>
    <aside className="taskRecommendation" aria-label={t('smart.recommendation')}>
      <section className="panel taskModelPanel">
        <div className="taskSectionHead"><h3>{t('smart.recommendation')}</h3><button type="button" className={`taskPin${draft.pinnedProfileId ? ' isPinned' : ''}`} disabled={!plan.candidate && !draft.pinnedProfileId} aria-pressed={Boolean(draft.pinnedProfileId)} onClick={() => update({ pinnedProfileId: draft.pinnedProfileId ? undefined : plan.candidate?.id })}>
          {draft.pinnedProfileId ? <LockKeyhole size={13}/> : <LockKeyholeOpen size={13}/>}{t(draft.pinnedProfileId ? 'smart.pinned' : 'smart.auto')}
        </button></div>
        {draft.pinnedProfileId && <label className="taskModelSelect"><span>{t('smart.selectModel')}</span><Select searchable className="uiSelect" value={draft.pinnedProfileId} onChange={e => update({ pinnedProfileId: e.target.value })}>
          {!candidates.some(c => c.id === draft.pinnedProfileId) && <option value={draft.pinnedProfileId}>{t('smart.missingModel')}</option>}
          {candidates.map(c => <option value={c.id} key={c.id} data-description={profileSelectOption(c.profile, c.maxContext).description}>{c.profile.name}</option>)}
        </Select></label>}
        {plan.candidate ? <>
          <div className="taskModelIdentity"><div className="taskModelGlyph"><Braces size={25}/></div><div><h4>{candidateName(plan.candidate)}</h4><span className="taskEngine">{ENGINE_NAMES[plan.candidate.engine]}</span><span className="taskPreliminary">{t(plan.conflict ? 'smart.status.unsupported' : 'smart.preliminary')}</span></div></div>
          <p className="taskModelExplanation">{t(plan.conflict ? `smart.conflicts.${plan.conflict}` : plan.candidate.family === 'qwen36' ? 'smart.whyQwen' : plan.candidate.family === 'flash' ? 'smart.whyFlash' : 'smart.whyGeneric', { context: contextText(plan.context) })}</p>
          <dl className="taskMetrics"><div><dt>{t('smart.contextMetric')}</dt><dd>{contextText(plan.context)}</dd><small>{t('smart.planned')}</small></div><div><dt>{t('smart.speedMetric')}</dt><dd>{speed ? number(speed.averages.generationTps) : '—'}</dd><small>{speed ? t('smart.measuredSpeed') : t('smart.notMeasured')}</small></div><div><dt>{t('smart.memoryMetric')}</dt><dd>{t('smart.estimate')}</dd><small>{t('smart.memoryDetails')}</small></div></dl>
          <details className="taskWhy"><summary>{t('smart.whyModel')}</summary><p>{t('smart.evidenceNote')}</p><p>{t('smart.sourceLimit', { context: contextText(plan.candidate.maxContext) })}</p><p>{t(plan.reasoning === 'modelRecipe' ? 'smart.qwenRecipe' : 'smart.instructionDepth')}</p><p>{t('smart.noInputInspection')}</p></details>
        </> : <div className="taskNoModel"><Layers3 size={25}/><p>{t('smart.noCandidate')}</p><button type="button" className="taskTextButton" onClick={() => setView('models')}>{t('smart.openLibrary')}<ArrowUpRight size={13}/></button></div>}
        {plan.conflict && <p className="taskConflict" role="alert">{t(`smart.conflicts.${plan.conflict}`, { context: contextText(plan.context) })}</p>}
        {plan.config && plan.candidate?.engine !== 'strata' && <LaunchFit config={plan.config} replacesRunId={selectedRunId} compact/>}
        <div className="taskApplyArea"><span className={`taskApplicationStatus is-${status}`} role="status"><i/>{t(`smart.status.${status}`)}</span>
          <p>{t(saved ? 'smart.savedHint' : 'smart.applyHint')}</p>
          {error && <p className="taskConflict" role="alert">{error}</p>}
          <Button className="primary taskApply" disabled={Boolean(plan.conflict) || saved || busy || saving || invalidTemperature} onClick={() => void apply()}>{t(saving ? 'smart.saving' : 'smart.apply')}</Button>
          {saved && <button type="button" className="taskTextButton" onClick={() => setView('dashboard')}>{t('smart.openLaunch')}<ChevronRight size={13}/></button>}
        </div>
      </section>
      <section className="panel taskAlternatives"><div className="taskSectionHead"><h3>{t('smart.alternatives')}</h3>{plan.alternatives.length > 2 && <button type="button" className="taskTextButton" aria-expanded={allModels} onClick={() => setAllModels(!allModels)}>{t(allModels ? 'smart.showLess' : 'smart.showAll')}</button>}</div>
        {plan.alternatives.length ? (allModels ? plan.alternatives : plan.alternatives.slice(0, 2)).map(c => <button type="button" className="taskAlternative" key={c.id} onClick={() => update({ pinnedProfileId: c.id })}><span><b>{candidateName(c)}</b><small>{ENGINE_NAMES[c.engine]} · {contextText(c.maxContext)} · {t('smart.sourceProfile')}</small></span><ChevronRight size={15}/></button>) : <p className="taskMuted">{t('smart.noAlternatives')}</p>}
      </section>
    </aside>
    <details className="taskTechnical panel"><summary>{t('smart.technical')}</summary><div className="taskTechnicalBody">
      <div><h3>{t('smart.requestParameters')}</h3><p>{t('smart.clientNote')}</p>
        <label className="taskTemperatureLock"><input type="checkbox" checked={draft.pinnedTemperature !== undefined} onChange={e => { setTemperatureText(undefined); update({ pinnedTemperature: e.target.checked ? plan.temperature : undefined }); }}/>{t('smart.pinTemperature')}</label>
        <label className="taskTemperature"><span>{t('smart.temperature')}</span><input className="uiInput" type="number" min={0} max={2} step={.05} value={temperatureText ?? String(plan.temperature)} aria-invalid={invalidTemperature || undefined} disabled={draft.pinnedTemperature === undefined} onChange={e => setTemperatureText(e.target.value)} onBlur={commitTemperature} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/></label>
        <p>{t('smart.outputBudget', { count: plan.outputTokens })}</p><p>{t(plan.reasoning === 'modelRecipe' ? 'smart.qwenRecipe' : 'smart.instructionDepth')}</p>
        <pre>{JSON.stringify(plan.request, null, 2)}</pre><Button disabled={!plan.candidate} onClick={() => void copyRequest()}><Copy size={14}/>{t('smart.copyRequest')}</Button>
        <p>{t('smart.clientInstruction')}</p><blockquote className="taskInstruction">{instructions}</blockquote><Button disabled={!plan.candidate} onClick={() => void copyInstructions()}><Copy size={14}/>{t('smart.copyInstruction')}</Button>
      </div>
      <div><h3>{t('smart.launchParameters')}</h3><p>{t('smart.launchNote')}</p>{plan.candidate && <TaskResources key={`${plan.candidate.id}:${plan.context}`} plan={plan}/>}</div>
    </div></details>
  </div>;
}

function PresetIcon({preset}:{preset:TaskPreset}){const Icon=preset==='quickFix'?Zap:preset==='agent'?Braces:preset==='coding'?BrainCircuit:preset==='documents'?FileText:preset==='json'?Braces:preset==='translation'?AlignLeft:preset==='analysis'?ChartNoAxesCombined:preset.startsWith('design')?Palette:preset==='creative'?Lightbulb:Ellipsis;return <Icon size={15}/>;}
