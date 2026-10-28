import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Bot, CircleAlert, CircleCheck, Hourglass, X } from "lucide-react";
import { addActivity, useActivityStore } from "../activity/store";
import { isTauri } from "../../services/tauri";
import { useAgentStore } from "../agent/store";
import { selectTask, useWorkspaceStore } from "../agent/workspace";
import { useControlStore } from "../../store/control";

const KEY = "aplot.lastSeenAt";
const AWAY_MS = 15 * 60 * 1000;

function readLastSeen() { try { const value = Number(localStorage.getItem(KEY)); return Number.isFinite(value) && value > 0 ? value : undefined; } catch { return undefined; } }
function writeLastSeen(time = Date.now()) { try { localStorage.setItem(KEY, String(time)); } catch { /* best effort */ } }

/** `since` is set when the person comes back after at least 15 minutes away (or starts the app later). */
export const useAway = create<{ since?: number; dismiss: () => void }>(set => ({ since: undefined, dismiss: () => set({ since: undefined }) }));

let demoSeeded = false;

/** Tracks presence: a heartbeat while the window is visible, and an "away since" mark on return. */
export function startPresence() {
  if (!isTauri() && new URLSearchParams(window.location.search).get("away") === "demo" && !demoSeeded) {
    demoSeeded = true;
    // Browser demo only: a sample digest so the panel can be reviewed without real history.
    useAway.setState({ since: Date.now() - 3 * 3600_000 });
    addActivity({ kind: "server.state", level: "error", name: "Example model — Long context", data: { state: "crashed" } });
    addActivity({ kind: "agent.completed", level: "info", name: "Переработка интерфейса", data: { outcome: "success" } });
    addActivity({ kind: "agent.completed", level: "warn", name: "Бенчмарк IQ3_S", data: { outcome: "error" } });
  }
  const startedWith = readLastSeen();
  if (startedWith && Date.now() - startedWith > AWAY_MS) useAway.setState({ since: startedWith });
  writeLastSeen();
  let hiddenAt: number | undefined;
  const beat = window.setInterval(() => { if (!document.hidden) writeLastSeen(); }, 60_000);
  const visibility = () => {
    if (document.hidden) { hiddenAt = Date.now(); writeLastSeen(hiddenAt); return; }
    if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) useAway.setState({ since: hiddenAt });
    hiddenAt = undefined; writeLastSeen();
  };
  document.addEventListener("visibilitychange", visibility);
  return () => { window.clearInterval(beat); document.removeEventListener("visibilitychange", visibility); writeLastSeen(); };
}

const duration = (ms: number, language: string) => {
  const minutes = Math.round(ms / 60000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always" });
  return minutes < 90 ? format.format(-minutes, "minute") : minutes < 60 * 36 ? format.format(-Math.round(minutes / 60), "hour") : format.format(-Math.round(minutes / 1440), "day");
};

/** "While you were away": what crashed, what agents finished and what still waits for a decision. */
export function AwayDigest() {
  const { t, i18n } = useTranslation();
  const since = useAway(state => state.since);
  const dismiss = useAway(state => state.dismiss);
  const events = useActivityStore(state => state.events);
  const threads = useAgentStore(state => state.threads);
  const tasks = useWorkspaceStore(state => state.tasks);
  useEffect(() => { if (since) writeLastSeen(); }, [since]);

  const digest = useMemo(() => {
    if (!since) return undefined;
    const recent = events.filter(event => event.time > since);
    const crashes = recent.filter(event => event.kind === "server.state" && event.data.state === "crashed");
    const errors = recent.filter(event => event.kind === "server.issue" && event.level === "error");
    const finished = recent.filter(event => event.kind === "agent.completed");
    const waiting = tasks.filter(task => !task.deletedAt && (threads[task.id]?.requests.length ?? 0) > 0);
    return { crashes, errors, finished, waiting, total: crashes.length + errors.length + finished.length + waiting.length };
  }, [since, events, threads, tasks]);

  if (!since || !digest || !digest.total) return null;
  const control = useControlStore.getState();
  const openTask = (id?: string) => { if (id) selectTask(id); control.setView("agentWorkspace"); };
  return <section className="awayDigest deskHomePanel" aria-labelledby="away-title">
    <header><h2 id="away-title">{t("away.title")}</h2><span className="kMuted">{t("away.since", { when: duration(Date.now() - since, i18n.language) })}</span>
      <button type="button" className="kIconBtn" aria-label={t("away.dismiss")} title={t("away.dismiss")} onClick={dismiss}><X size={14}/></button></header>
    <ul>
      {digest.crashes.slice(0, 3).map(event => <li key={event.id} className="isDanger"><CircleAlert size={15}/><button type="button" onClick={() => { if (event.runId) control.selectRun(event.runId); control.setView("logs"); }}>{t("away.crashed", { name: event.name })}</button><time>{new Date(event.time).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}</time></li>)}
      {digest.errors.length > 0 && <li className="isWarn"><CircleAlert size={15}/><button type="button" onClick={() => control.setView("logs")}>{t("away.errors", { count: digest.errors.length })}</button></li>}
      {digest.waiting.slice(0, 3).map(task => <li key={task.id} className="isWarn"><Hourglass size={15}/><button type="button" onClick={() => openTask(task.id)}>{t("away.waiting", { name: task.title })}</button></li>)}
      {digest.finished.slice(0, 4).map(event => <li key={event.id} className={event.data.outcome === "error" ? "isDanger" : "isOk"}>{event.data.outcome === "error" ? <Bot size={15}/> : <CircleCheck size={15}/>}<button type="button" onClick={() => openTask(event.taskId)}>{t(event.data.outcome === "error" ? "away.failed" : "away.finished", { name: event.name })}</button><time>{new Date(event.time).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}</time></li>)}
    </ul>
  </section>;
}
