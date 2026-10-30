import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Feather, Maximize2, Play, RotateCw, Square, X } from "lucide-react";
import i18n from "../../lib/i18n";
import { actionFor, comboOf } from "../../lib/shortcuts";
import { isTauri } from "../../services/tauri";
import { portOf, runColor } from "../launches/presentation";
import type { MiniCommand, MiniState } from "./miniWindow";

const send = (command: MiniCommand) => void emitTo("main", "mini://command", command).catch(console.error);

const SAMPLE: MiniState = { theme: "dark", language: "ru", selectedRunId: "profile:example-balanced", lightMode: false, runs: [
  { runId: "profile:example-balanced", name: "Example model — Balanced", index: 0, state: "busy", tps: 47.8, managed: true, endpoint: "http://127.0.0.1:8080/v1", model: "example-balanced", vramGiB: 9.4 },
  { runId: "profile:example-long", name: "Example model — Long context", index: 1, state: "ready", tps: 0, managed: true, endpoint: "http://127.0.0.1:8081/v1", model: "example-long", vramGiB: 4.7 },
], profiles: [{ id: "example-balanced", name: "Example model — Balanced", running: true }, { id: "example-fast", name: "Example model — Fast", running: false }] };

/**
 * The control panel (Ctrl+Shift+M, and the only window in light mode): every server with its model, speed and
 * memory, start/stop/restart, the API address to copy, and a saved profile to launch.
 */
export function MiniApp() {
  const { t } = useTranslation();
  const [state, setState] = useState<MiniState>();
  const [copied, setCopied] = useState<string>();
  const [profileId, setProfileId] = useState("");
  // The mini window opens focused, so the shortcut that opened it has to close it from here.
  useEffect(() => {
    if (!isTauri()) return;
    const close = (event: KeyboardEvent) => {
      if (actionFor(comboOf(event)) === "mini") { event.preventDefault(); void getCurrentWindow().close(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  useEffect(() => {
    if (!isTauri()) { setState({ ...SAMPLE, theme: document.documentElement.dataset.theme ?? "dark", language: i18n.language }); return; } // Browser preview.
    let off: (() => void) | undefined, disposed = false;
    void listen<MiniState>("mini://state", ({ payload }) => {
      setState(payload);
      document.documentElement.dataset.theme = payload.theme;
      if (i18n.language !== payload.language) void i18n.changeLanguage(payload.language);
    }).then(unlisten => { if (disposed) unlisten(); else { off = unlisten; send({ action: "ready" }); } });
    return () => { disposed = true; off?.(); };
  }, []);
  const copy = async (runId: string, endpoint: string) => {
    try { await navigator.clipboard.writeText(endpoint); setCopied(runId); setTimeout(() => setCopied(undefined), 1500); } catch { /* clipboard is optional */ }
  };
  const runs = state?.runs ?? [];
  const launchable = (state?.profiles ?? []).filter(profile => !profile.running);
  const chosen = launchable.find(profile => profile.id === profileId) ?? launchable[0];
  return <div className={`miniShell${state?.lightMode ? " isLight" : ""}`} data-tauri-drag-region>
    <header data-tauri-drag-region><b data-tauri-drag-region>Aplot{state?.lightMode && <span className="miniBadge">{t("mini.lightMode")}</span>}</b>
      <button type="button" aria-pressed={state?.lightMode ?? false} aria-label={t(state?.lightMode ? "mini.lightOff" : "mini.lightOn")} title={t(state?.lightMode ? "mini.lightOff" : "mini.lightOn")} onClick={() => send({ action: "lightMode", on: !state?.lightMode })}><Feather size={13}/></button>
      <button type="button" aria-label={t("mini.openMain")} title={t("mini.openMain")} onClick={() => send({ action: "focus" })}><Maximize2 size={13}/></button>
      <button type="button" aria-label={t("actions.close")} title={t("actions.close")} onClick={() => void getCurrentWindow().close()}><X size={13}/></button></header>
    {!state && <p className="miniEmpty">{t("mini.connecting")}</p>}
    {state && !runs.length && <p className="miniEmpty">{t("mini.noServers")}</p>}
    <div className="miniRuns">{runs.map(run => {
      const live = ["ready", "busy"].includes(run.state), stopped = ["stopped", "crashed"].includes(run.state);
      const port = portOf(run.endpoint);
      const details = [run.model, run.vramGiB !== undefined ? `VRAM ${run.vramGiB.toFixed(1)} ${t("k.unit.gb")}` : "", port ? `:${port}` : ""].filter(Boolean).join(" · ");
      return <div key={run.runId} className="miniRun" style={{ ["--c" as string]: runColor(run.runId) }}>
        <span className={`kLed is-${run.state}`} aria-hidden="true"/>
        <button type="button" className="miniName" onClick={() => send({ action: "select", runId: run.runId })}><span><i>S{run.index + 1}</i>{run.name}</span>{details && <small>{details}</small>}</button>
        <b className="kMono" title={t(`status.${run.state}`)}>{live ? (run.tps > 0 ? run.tps.toFixed(1) : "—") : t(`status.${run.state}`)}</b>
        {!stopped && <button type="button" className="miniAct" aria-label={t("mini.copyAddress")} title={`${t("mini.copyAddress")} · ${run.endpoint}`} onClick={() => void copy(run.runId, run.endpoint)}>{copied === run.runId ? <Check size={13}/> : <Copy size={12}/>}</button>}
        {run.managed && !stopped && <button type="button" className="miniAct" aria-label={t("actions.restart")} title={t("actions.restart")} onClick={() => send({ action: "restart", runId: run.runId })}><RotateCw size={12}/></button>}
        {run.managed && <button type="button" className="miniAct" aria-label={t(stopped ? "actions.start" : "actions.stop")} title={t(stopped ? "actions.start" : "actions.stop")}
          onClick={() => send({ action: stopped ? "start" : "stop", runId: run.runId })}>{stopped ? <Play size={13}/> : <Square size={12}/>}</button>}
      </div>;
    })}</div>
    {chosen && <form className="miniLaunch" onSubmit={event => { event.preventDefault(); send({ action: "launch", profileId: chosen.id }); }}>
      <select aria-label={t("mini.profile")} value={chosen.id} onChange={event => setProfileId(event.target.value)}>{launchable.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>
      <button type="submit" className="miniAct isPrimary" aria-label={t("mini.launch")} title={t("mini.launch")}><Play size={13}/></button>
    </form>}
  </div>;
}
