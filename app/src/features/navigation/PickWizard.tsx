import { Bot, CheckCircle2, ChevronRight, MessageSquare, Play, RotateCw, Server, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Button } from '../../components/ui/Primitives';
import { RestartDialog } from '../../components/config/RestartDialog';
import { useControlStore } from '../../store/control';
import type { BenchmarkResult } from '../../types/app';
import { isActive, isWorking } from '../launches/presentation';
import { useLaunchAction } from '../launches/useLaunchAction';
import { launchBlocker } from '../launches/readiness';

const BenchmarkView = lazy(() => import('../../views/PerformanceView').then(module => ({ default: module.BenchmarkView })));

export type PickStep = 'task' | 'check' | 'done';
export const PICK_STEPS: PickStep[] = ['task', 'check', 'done'];
/** Kept outside the screen so Ctrl+K and other screens can open a step directly. */
export const usePickStep = create<{ step: PickStep; setStep: (step: PickStep) => void }>(set => ({ step: 'task', setStep: step => set({ step }) }));

/** «Стабильно» when every planned window finished and the targets were met; otherwise a compromise. */
export function benchmarkVerdict(result: BenchmarkResult | undefined): 'stable' | 'compromise' | undefined {
  if (!result) return undefined;
  const summary = result.suiteSummary;
  const complete = summary ? summary.completedWindows >= summary.requestedWindows && summary.requestedWindows > 0 : result.samples.length > 0;
  return complete && result.meetsTargets !== false ? 'stable' : 'compromise';
}

/** The numbered steps above the wizard; earlier steps stay clickable. */
export function PickSteps({ step, onStep }: { step: PickStep; onStep: (step: PickStep) => void }) {
  const { t } = useTranslation();
  const current = PICK_STEPS.indexOf(step);
  return <ol className="pickSteps" aria-label={t('pickWizard.steps')}>
    {PICK_STEPS.map((id, index) => <li key={id} className={index < current ? 'isDone' : index === current ? 'isCurrent' : ''}>
      <button type="button" aria-current={index === current ? 'step' : undefined} onClick={() => onStep(id)}>
        <span className="pickStepNumber">{index < current ? <CheckCircle2 size={15}/> : index + 1}</span>
        <span><b>{t(`pickWizard.step.${id}`)}</b><small>{t(`pickWizard.stepHint.${id}`)}</small></span>
      </button>
      {index < PICK_STEPS.length - 1 && <ChevronRight size={15} aria-hidden="true"/>}
    </li>)}
  </ol>;
}

/** Step «Проверка»: the benchmark, with a way on once a result is in. */
export function PickCheck({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const profileId = useControlStore(state => state.config.profileId);
  const latest = useControlStore(state => state.benchmarks.find(result => result.profileId === profileId));
  return <>
    <div className="pickNext"><p>{t(latest ? 'pickWizard.checkDone' : 'pickWizard.checkHint')}</p><Button className={latest ? 'primary' : ''} onClick={onNext}>{t(latest ? 'pickWizard.toDone' : 'pickWizard.skipCheck')}<ChevronRight size={14}/></Button></div>
    <Suspense fallback={<div className="routeLoading" aria-hidden="true"><span/></div>}><BenchmarkView/></Suspense>
  </>;
}

/** Step «Готово»: the saved profile, what the check said, and where to go with it. */
export function PickDone({ onBack }: { onBack: (step: PickStep) => void }) {
  const { t, i18n } = useTranslation();
  const state = useControlStore();
  const { config, settings, availableEngines, benchmarks, runs, selectedRunId, setView } = state;
  const { requestLaunch, pendingLaunch, confirming, confirmLaunch, cancelLaunch } = useLaunchAction();
  const run = runs.find(item => item.info.runId === selectedRunId);
  const running = Boolean(run && isActive(run.info.state));
  const ready = Boolean(run && isWorking(run.info.state));
  const latest = benchmarks.find(result => result.profileId === config.profileId);
  const verdict = benchmarkVerdict(latest);
  const blocker = settings.serverEngine && availableEngines.includes(settings.serverEngine) ? launchBlocker(config, settings) : 'engines.none';
  const tile = (label: string, value: ReactNode) => <div><dt>{label}</dt><dd>{value}</dd></div>;
  return <div className="page pickDone">
    <section className="panel pickDoneCard">
      <header><h2>{config.profileName || t('pickWizard.noProfile')}</h2>
        {verdict ? <span className={`pickVerdict is-${verdict}`}>{verdict === 'stable' ? <CheckCircle2 size={14}/> : <TriangleAlert size={14}/>}{t(`pickWizard.verdict.${verdict}`)}</span>
          : <button type="button" className="taskTextButton" onClick={() => onBack('check')}>{t('pickWizard.notChecked')}<ChevronRight size={13}/></button>}
      </header>
      <dl className="serverOverviewTiles">
        {tile(t('modelsHub.context'), config.ctxSize ? config.ctxSize.toLocaleString(i18n.language) : '—')}
        {tile(t('metrics.generation'), latest ? `${latest.averages.generationTps.toFixed(1)} ${t('modelsHub.tps')}` : '—')}
        {tile(t('metrics.prompt'), latest ? `${latest.averages.promptTps.toFixed(1)} ${t('modelsHub.tps')}` : '—')}
        {tile(t('benchmark.vramPeak'), latest ? `${(latest.averages.vramPeakMiB / 1024).toFixed(1)} ${t('k.unit.gb')}` : '—')}
      </dl>
      {verdict === 'compromise' && <p className="pickDoneNote">{t('pickWizard.compromiseHint')}</p>}
      <div className="pickDoneActions">
        <Button className="primary" disabled={Boolean(blocker) || Boolean(run && !run.info.managed)} title={blocker ? t(blocker) : undefined} onClick={() => void requestLaunch(running ? 'restart' : 'start', selectedRunId)}>{running ? <RotateCw size={14}/> : <Play size={14}/>}{t(running ? 'actions.restart' : 'pickWizard.start')}</Button>
        <Button disabled={!ready} onClick={() => setView('chat')}><MessageSquare size={14}/>{t('modelsHub.openChat')}</Button>
        <Button disabled={!ready} onClick={() => setView('agentWorkspace')}><Bot size={14}/>{t('pickWizard.forAgents')}</Button>
        <Button disabled={!run} onClick={() => setView('servers')}><Server size={14}/>{t('pickWizard.openServer')}</Button>
      </div>
    </section>
    <RestartDialog open={!!pendingLaunch} running={pendingLaunch?.action === 'restart'} profileName={pendingLaunch?.profileName ?? ''} pending={confirming} onConfirm={confirmLaunch} onClose={cancelLaunch}/>
  </div>;
}
