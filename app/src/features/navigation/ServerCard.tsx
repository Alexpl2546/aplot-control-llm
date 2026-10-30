import { Activity, Check, Copy, LayoutDashboard, MessageSquare, Play, Plug, Plus, RotateCw, ScrollText, Square } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { useGlider } from '../../components/ui/useGlider';
import { LiveSparkline } from '../../components/runtime/LiveSparkline';
import { ENGINE_NAMES } from '../../lib/engineModels';
import { duration } from '../../lib/format';
import { useControlStore } from '../../store/control';
import type { AppView } from '../../types/app';
import { isActive, isTransition, isWorking, portOf, runColor } from '../launches/presentation';
import { stopRunWithUndo } from '../launches/stopWithUndo';
import { useLaunchUi } from '../launches/ui';
import { useRunStats } from '../live/runStats';

/** Tabs of a server card; each is one of the old sidebar screens. */
export const SERVER_CARD_TABS: { view: AppView; icon: ComponentType<{ size?: number }>; label: string }[] = [
  { view: 'servers', icon: LayoutDashboard, label: 'modelsHub.overview' },
  { view: 'apiDocs', icon: Plug, label: 'modelsHub.connect' },
  { view: 'logs', icon: ScrollText, label: 'modelsHub.logs' },
  { view: 'performance', icon: Activity, label: 'modelsHub.metrics' },
];

const number = (value: number, language: string, digits = 1) => value.toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** «Модели → Серверы»: pick a server, then look at it through the tabs below its header. */
export function ServerCard({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const view = useControlStore(state => state.activeView);
  const setView = useControlStore(state => state.setView);
  const runs = useControlStore(state => state.runs);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const selectRun = useControlStore(state => state.selectRun);
  const busyById = useControlStore(state => state.runBusyById);
  const [copied, setCopied] = useState(false);
  const run = runs.find(item => item.info.runId === selectedRunId);
  const index = SERVER_CARD_TABS.findIndex(tab => tab.view === view);
  const glide = useGlider<HTMLDivElement>(index);
  const busy = run ? Boolean(busyById[run.info.runId]) || isTransition(run.info.state) : false;
  const copy = async () => {
    if (!run) return;
    try { await navigator.clipboard.writeText(run.info.endpoint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard is optional */ }
  };

  return <div className="serverCard">
    <div className="serverStrip" role="listbox" aria-label={t('modelsHub.servers')}>
      {runs.map((item, position) => {
        const selected = item.info.runId === selectedRunId;
        return <button key={item.info.runId} type="button" role="option" aria-selected={selected} className={`serverStripItem${selected ? ' isSelected' : ''}`} style={{ ['--c' as string]: runColor(item.info.runId) }} onClick={() => selectRun(item.info.runId)}>
          <span className={`kLed is-${item.info.state}`} aria-hidden="true"/>
          <span><b>{item.info.name}</b><small>{t('k.serverNumber', { number: position + 1 })} · {ENGINE_NAMES[item.info.engine]} · {t(`status.${item.info.state}`)}</small></span>
        </button>;
      })}
      <button type="button" className="serverStripItem serverStripNew" onClick={() => useLaunchUi.getState().setQuickAdd(true)}><Plus size={15}/><span><b>{t('k.servers.new')}</b><small>Ctrl N</small></span></button>
    </div>

    {!run ? <div className="serverCardEmpty"><p>{t('modelsHub.noServer')}</p><Button className="primary" onClick={() => setView('configuration')}>{t('modelsHub.pickModel')}</Button></div> : <>
      <header className="serverCardHead" style={{ ['--c' as string]: runColor(run.info.runId) }}>
        <div className="serverCardTitle">
          <span className={`kLed is-${run.info.state}`} aria-hidden="true"/>
          <div><h2>{run.info.name}</h2><p>{ENGINE_NAMES[run.info.engine]} · {t(`status.${run.info.state}`)}{run.runtime.modelName ? ` · ${run.runtime.modelName}` : ''}</p></div>
        </div>
        <button type="button" className="serverCardEndpoint" onClick={() => void copy()} title={t('modelsHub.copyAddress')}><code>{run.info.endpoint}</code>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
        <div className="serverCardActions">
          {isActive(run.info.state) && <Button disabled={busy || !run.info.managed} onClick={() => void stopRunWithUndo(run.info.runId)}><Square size={14}/>{t('actions.stop')}</Button>}
          {isActive(run.info.state)
            ? <Button disabled={busy || !run.info.managed} onClick={() => void useControlStore.getState().restartManagedRun(run.info.runId)}><RotateCw size={14}/>{t('actions.restart')}</Button>
            : <Button className="primary" disabled={busy || !run.info.managed} onClick={() => void useControlStore.getState().startManagedRun(run.info.runId)}><Play size={14}/>{t('actions.start')}</Button>}
        </div>
      </header>
      <div ref={glide} className="modelsHubSub serverCardTabs kGlideHost" role="tablist" aria-label={run.info.name}>
        <span className="kGlide" aria-hidden="true"/>
        {SERVER_CARD_TABS.map(({ view: target, icon: Icon, label }, position) => <button key={target} type="button" role="tab" data-glide aria-selected={position === index} tabIndex={position === index ? 0 : -1} onClick={() => setView(target)}
          onKeyDown={event => {
            const next = { ArrowLeft: position - 1, ArrowRight: position + 1, Home: 0, End: SERVER_CARD_TABS.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            const wrapped = (next + SERVER_CARD_TABS.length) % SERVER_CARD_TABS.length;
            setView(SERVER_CARD_TABS[wrapped].view);
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[wrapped]?.focus();
          }}><Icon size={14}/>{t(label)}</button>)}
      </div>
      <div className="serverCardBody">{children}</div>
    </>}
  </div>;
}

/** «Обзор»: what the server runs and how it is doing right now. */
export function ServerOverview() {
  const { t, i18n } = useTranslation();
  const run = useControlStore(state => state.runs.find(item => item.info.runId === state.selectedRunId));
  const setView = useControlStore(state => state.setView);
  const series = useRunStats(state => run ? state.series[`${run.info.runId}#${run.info.generation}`] : undefined);
  if (!run) return null;
  const { runtime, info } = run;
  const working = isWorking(info.state);
  const vram = runtime.processMemory?.vramMiB, ram = runtime.processMemory?.ramMiB;
  const context = runtime.contextTotal || info.contextTokens;
  const tiles: [string, string, string?][] = [
    [t('modelsHub.model'), runtime.modelName || info.modelId || '—'],
    [t('modelsHub.uptime'), working ? duration(runtime.uptimeSeconds) : '—'],
    [t('metrics.generation'), working ? `${number(runtime.generationTps, i18n.language)} ${t('modelsHub.tps')}` : '—'],
    [t('metrics.prompt'), working ? `${number(runtime.promptTps, i18n.language)} ${t('modelsHub.tps')}` : '—'],
    [t('modelsHub.context'), context ? `${runtime.contextUsed ? `${runtime.contextUsed.toLocaleString(i18n.language)} / ` : ''}${context.toLocaleString(i18n.language)}` : '—'],
    [t('modelsHub.memory'), typeof vram === 'number' || typeof ram === 'number' ? [typeof vram === 'number' ? `VRAM ${number(vram / 1024, i18n.language)} ${t('k.unit.gb')}` : '', typeof ram === 'number' ? `RAM ${number(ram / 1024, i18n.language)} ${t('k.unit.gb')}` : ''].filter(Boolean).join(' · ') : '—'],
    [t('modelsHub.requests'), working ? t('modelsHub.requestsValue', { active: runtime.activeRequests, queued: runtime.queuedRequests }) : '—'],
    [t('modelsHub.port'), portOf(info.endpoint) || '—'],
  ];
  const samples = series?.samples ?? [];
  return <div className="serverOverview">
    {info.state === 'crashed' && (info.lastError || runtime.lastError) && <p className="serverOverviewError" role="alert">{info.lastError || runtime.lastError}</p>}
    <dl className="serverOverviewTiles">{tiles.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
    {samples.length > 1 && <div className="serverOverviewChart"><span>{t('modelsHub.speedHistory')}</span><LiveSparkline values={samples.map(sample => sample.tps)} timestamps={samples.map(sample => sample.t)} tone="green" label={t('metrics.generation')} unit={t('modelsHub.tps')}/></div>}
    <div className="serverOverviewActions">
      <Button disabled={!working} onClick={() => setView('chat')}><MessageSquare size={14}/>{t('modelsHub.openChat')}</Button>
      <Button onClick={() => setView('apiDocs')}><Plug size={14}/>{t('modelsHub.connectApp')}</Button>
    </div>
  </div>;
}
