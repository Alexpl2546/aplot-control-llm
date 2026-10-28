import { AlertTriangle, Bell, Trash2, Bot, Check, CheckCheck, CircleAlert, CircleCheck, Hand, Info, Play, RotateCw, ScrollText, Server, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useControlStore } from '../../store/control';
import type { AppNotice } from '../../types/app';
import { useActivityStore } from '../../features/activity/store';
import type { ActivityEvent } from '../../features/activity/model';
import { useAgentStore } from '../../features/agent/store';
import { selectTask, useWorkspaceStore } from '../../features/agent/workspace';
import { runColor } from '../../features/launches/presentation';
import './NotificationCenter.css';

/**
 * Notification centre: "what needs me" first (crashed servers, agents waiting for a decision,
 * save problems), then a short feed of meaningful events — servers going up/down, agent runs
 * finishing, errors — each with the one action that resolves it. Routine toasts ("saved", "copied")
 * stay toasts; they are not kept here. Unread = newer than the last time the panel was opened.
 */

type Filter = 'all' | 'servers' | 'agents' | 'errors';
interface FeedItem {
  id: string; time: number; tone: 'error' | 'warn' | 'success' | 'info';
  group: 'servers' | 'agents' | 'app'; icon: LucideIcon; title: string; detail?: string; color?: string;
  action?: { label: string; run: () => void };
}

const SEEN_KEY = 'aplot.notifications.seen';
// First launch starts "read" from now, so years of stored activity do not light the badge up.
const readSeen = () => { try { const value = Number(localStorage.getItem(SEEN_KEY)); if (value) return value; const now = Date.now(); localStorage.setItem(SEEN_KEY, String(now)); return now; } catch { return Date.now(); } };
const writeSeen = (time: number) => { try { localStorage.setItem(SEEN_KEY, String(time)); } catch { /* session only */ } };
/** Toasts worth keeping in the feed: problems only. Undo toasts expire in seconds, so they never belong here. */
const keepNotice = (notice: AppNotice) => (notice.kind === 'error' || notice.kind === 'warning') && !notice.action;
const CLEARED_KEY = 'aplot.notifications.cleared';
const readCleared = () => { try { return Number(localStorage.getItem(CLEARED_KEY)) || 0; } catch { return 0; } };

function relative(time: number, now: number, language: string) {
  const seconds = Math.round((time - now) / 1000), format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  if (Math.abs(seconds) < 45) return format.format(0, 'second');
  if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(time);
}

function feedFromEvent(event: ActivityEvent, t: TFunction, go: { logs: (runId?: string) => void; task: (taskId: string) => void }): FeedItem | undefined {
  const base = { id: event.id, time: event.time };
  if (event.kind === 'server.state') {
    const state = String(event.data.state ?? '');
    if (!['ready', 'crashed', 'stopped'].includes(state)) return undefined;
    return { ...base, group: 'servers', icon: Server, color: event.runId ? runColor(event.runId) : undefined,
      tone: state === 'crashed' ? 'error' : state === 'ready' ? 'success' : 'info',
      title: t(`notifications.server.${state}`, { name: event.name }),
      detail: [event.data.profile, event.data.context ? `${Math.round(Number(event.data.context) / 1024)}K ctx` : ''].filter(Boolean).join(' · ') || undefined,
      action: state === 'crashed' ? { label: t('notifications.openLogs'), run: () => go.logs(event.runId) } : undefined };
  }
  if (event.kind === 'server.issue' && event.level === 'error') return { ...base, group: 'servers', icon: CircleAlert, tone: 'error', color: event.runId ? runColor(event.runId) : undefined,
    title: t('notifications.server.error', { name: event.name }), detail: String(event.data.message ?? '').slice(0, 220),
    action: { label: t('notifications.openLogs'), run: () => go.logs(event.runId) } };
  if (event.kind === 'agent.completed') {
    const outcome = String(event.data.outcome ?? 'success');
    return { ...base, group: 'agents', icon: outcome === 'error' ? CircleAlert : outcome === 'interrupted' ? Hand : CircleCheck,
      tone: outcome === 'error' ? 'error' : outcome === 'interrupted' ? 'warn' : 'success',
      title: t(`notifications.agent.${outcome}`, { defaultValue: t('notifications.agent.success'), name: event.name }),
      action: event.taskId ? { label: t('notifications.openTask'), run: () => go.task(event.taskId!) } : undefined };
  }
  if (event.kind === 'agent.started') return { ...base, group: 'agents', icon: Play, tone: 'info', title: t('notifications.agent.started', { name: event.name }),
    action: event.taskId ? { label: t('notifications.openTask'), run: () => go.task(event.taskId!) } : undefined };
  if (event.kind === 'agent.approval') return { ...base, group: 'agents', icon: Hand, tone: 'warn', title: t('notifications.agent.approval', { name: event.name }),
    action: event.taskId ? { label: t('notifications.decide'), run: () => go.task(event.taskId!) } : undefined };
  return undefined;
}

export function NotificationCenter() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [seen, setSeen] = useState(readSeen);
  const [cleared, setCleared] = useState(readCleared);
  const [now, setNow] = useState(Date.now());
  const [kept, setKept] = useState<AppNotice[]>(() => useControlStore.getState().notices.filter(keepNotice));
  const [place, setPlace] = useState({ top: 0, right: 0 });
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const runs = useControlStore(state => state.runs);
  const events = useActivityStore(state => state.events);
  const threads = useAgentStore(state => state.threads);
  const tasks = useWorkspaceStore(state => state.tasks);
  const saveError = useWorkspaceStore(state => state.saveError);

  useEffect(() => useControlStore.subscribe((state, previous) => {
    if (state.notices === previous.notices) return;
    const added = state.notices.filter(notice => keepNotice(notice) && !previous.notices.some(item => item.id === notice.id));
    if (added.length) setKept(current => [...added.reverse(), ...current].slice(0, 30));
  }), []);

  const go = useMemo(() => ({
    logs: (runId?: string) => { const control = useControlStore.getState(); if (runId) control.selectRun(runId); useActivityStore.getState().setMode('technical'); control.setView('logs'); setOpen(false); },
    task: (taskId: string) => { selectTask(taskId); useControlStore.getState().setView('agentWorkspace'); setOpen(false); },
  }), []);

  /* What needs the person right now (not time-based, never "read") */
  const attention = useMemo(() => {
    const control = useControlStore.getState();
    const rows: FeedItem[] = runs.filter(run => run.info.state === 'crashed').map(run => ({
      id: `crash:${run.info.runId}`, time: Date.now(), tone: 'error', group: 'servers', icon: AlertTriangle, color: runColor(run.info.runId),
      title: t('notifications.server.crashed', { name: run.info.name }), detail: run.info.lastError?.slice(0, 200),
      action: run.info.managed ? { label: t('notifications.restart'), run: () => void control.restartManagedRun(run.info.runId) } : { label: t('notifications.openLogs'), run: () => go.logs(run.info.runId) },
    }));
    for (const task of tasks) {
      const count = task.deletedAt ? 0 : threads[task.id]?.requests.length ?? 0;
      if (count) rows.push({ id: `wait:${task.id}`, time: task.updatedAt, tone: 'warn', group: 'agents', icon: Hand, title: t('notifications.waiting', { name: task.agentName || task.title }),
        detail: t('notifications.waitingDetail', { count, task: task.title }), action: { label: t('notifications.decide'), run: () => go.task(task.id) } });
    }
    if (saveError) rows.push({ id: 'save', time: Date.now(), tone: 'error', group: 'app', icon: CircleAlert, title: t('notifications.saveError'), detail: t(`aw.error.${saveError}`, { defaultValue: '' }) || undefined });
    return rows;
  }, [runs, tasks, threads, saveError, go, t]);

  const feed = useMemo(() => {
    const rows = events.slice(0, 200).map(event => feedFromEvent(event, t, go)).filter((row): row is FeedItem => !!row);
    for (const notice of kept.filter(item => item.createdAt > cleared)) rows.push({ id: notice.id, time: notice.createdAt, group: 'app', icon: notice.kind === 'error' ? CircleAlert : notice.kind === 'warning' ? AlertTriangle : Info,
      tone: notice.kind === 'error' ? 'error' : notice.kind === 'warning' ? 'warn' : 'info', title: notice.message,
    });
    return rows.filter(row => row.time > cleared).sort((a, b) => b.time - a.time).slice(0, 60);
  }, [events, kept, cleared, go, t]);
  const clearAll = () => { const time = Date.now(); try { localStorage.setItem(CLEARED_KEY, String(time)); } catch { /* session only */ } setCleared(time); setKept([]); markRead(); };

  // The badge counts what is worth a look: problems and finished agent work, not "server is ready".
  const notable = (item: FeedItem) => item.tone === 'error' || item.tone === 'warn' || (item.group === 'agents' && item.tone === 'success');
  const unread = feed.filter(item => item.time > seen && notable(item)).length + attention.length;
  const urgent = attention.some(item => item.tone === 'error') || feed.some(item => item.time > seen && item.tone === 'error');
  const shown = feed.filter(item => filter === 'all' || (filter === 'errors' ? item.tone === 'error' || item.tone === 'warn' : item.group === filter));
  const today = new Date(now).toDateString();
  const sections = [
    { key: 'today', label: t('notifications.today'), rows: shown.filter(item => new Date(item.time).toDateString() === today) },
    { key: 'earlier', label: t('notifications.earlier'), rows: shown.filter(item => new Date(item.time).toDateString() !== today) },
  ].filter(section => section.rows.length);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } return; }
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', close);
    return () => { window.clearInterval(timer); window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const box = button.current?.getBoundingClientRect();
    if (box) setPlace({ top: box.bottom + 8, right: Math.max(8, window.innerWidth - box.right - 6) });
    setNow(Date.now()); setOpen(true);
  };
  const markRead = () => { const time = Date.now(); writeSeen(time); setSeen(time); };
  // Opening shows what is new; closing marks it read so the badge only counts what came after.
  const wasOpen = useRef(false);
  useEffect(() => { if (wasOpen.current && !open) markRead(); wasOpen.current = open; }, [open]);

  const row = (item: FeedItem, isNew: boolean) => <li key={item.id} className={`ncItem is-${item.tone}${isNew ? ' isNew' : ''}`} style={item.color ? { ['--c' as string]: item.color } : undefined}>
    <i className="ncIcon" aria-hidden="true"><item.icon size={15}/></i>
    <div className="ncBody"><b>{item.title}</b>{item.detail && <span>{item.detail}</span>}
      <div className="ncMeta"><time dateTime={new Date(item.time).toISOString()}>{relative(item.time, now, i18n.language)}</time>{item.action && <button type="button" onClick={item.action.run}>{item.action.label}</button>}</div></div>
  </li>;

  const filters: [Filter, string][] = [['all', t('notifications.filter.all')], ['errors', t('notifications.filter.errors')], ['servers', t('notifications.filter.servers')], ['agents', t('notifications.filter.agents')]];

  return <>
    <button ref={button} type="button" className={`kIconBtn kBell${unread ? ' hasUnread' : ''}`} title={t('notifications.title')} aria-label={unread ? t('notifications.titleUnread', { count: unread }) : t('notifications.title')} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      <Bell size={16}/>{unread > 0 && <i className={`kCount${urgent ? '' : ' isCalm'}`}>{Math.min(unread, 99)}</i>}
    </button>
    {open && createPortal(<div ref={panel} className="ncPanel" role="dialog" aria-label={t('notifications.title')} style={{ top: place.top, right: place.right }}>
      <header className="ncHead">
        <h2>{t('notifications.title')}</h2>
        <button type="button" className="kIconBtn" title={t('notifications.markRead')} aria-label={t('notifications.markRead')} disabled={!feed.some(item => item.time > seen)} onClick={markRead}><CheckCheck size={15}/></button>
        <button type="button" className="kIconBtn" title={t('actions.close')} aria-label={t('actions.close')} onClick={() => setOpen(false)}><X size={15}/></button>
      </header>
      <div className="ncScroll">
        {attention.length > 0 && <section className="ncAttention" aria-label={t('notifications.attention')}>
          <h3>{t('notifications.attention')}<span className="kMono">{attention.length}</span></h3>
          <ul>{attention.map(item => row(item, false))}</ul>
        </section>}
        <div className="ncFilters" role="group" aria-label={t('notifications.filterLabel')}>
          {filters.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        {sections.map(section => <section key={section.key} className="ncSection"><h3>{section.label}</h3><ul>{section.rows.map(item => row(item, item.time > seen))}</ul></section>)}
        {!sections.length && <div className="ncEmpty">{attention.length ? <Check size={20}/> : <CircleCheck size={22}/>}<b>{t(attention.length ? 'notifications.feedEmpty' : 'notifications.allClear')}</b><p>{t('notifications.emptyHint')}</p></div>}
      </div>
      <footer className="ncFoot">
        <button type="button" className="ncClear" disabled={!feed.length} onClick={clearAll}><Trash2 size={14}/>{t('notifications.clear')}</button>
        <button type="button" onClick={() => { useActivityStore.getState().setMode('events'); useControlStore.getState().setView('logs'); setOpen(false); }}><ScrollText size={14}/>{t('notifications.allActivity')}</button>
        <button type="button" onClick={() => { useControlStore.getState().setView('dashboard'); setOpen(false); }}><Bot size={14}/>{t('notifications.toOrbit')}</button>
        {runs.some(run => run.info.state === 'crashed' && run.info.managed) && <button type="button" onClick={() => { const control = useControlStore.getState(); runs.filter(run => run.info.state === 'crashed' && run.info.managed).forEach(run => void control.restartManagedRun(run.info.runId)); }}><RotateCw size={14}/>{t('notifications.restartAll')}</button>}
      </footer>
    </div>, document.body)}
  </>;
}
