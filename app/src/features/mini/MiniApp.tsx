import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Play, Square, X } from "lucide-react";
import i18n from "../../lib/i18n";
import { isTauri } from "../../services/tauri";
import { runColor } from "../launches/presentation";
import type { MiniCommand, MiniState } from "./miniWindow";

const send = (command: MiniCommand) => void emitTo("main", "mini://command", command).catch(console.error);

/** The always-on-top capsule: running servers, their speed and start/stop, while you work elsewhere. */
export function MiniApp() {
  const { t } = useTranslation();
  const [state, setState] = useState<MiniState>();
  // The mini window opens focused, so the shortcut that opened it has to close it from here.
  useEffect(() => {
    if (!isTauri()) return;
    const close = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === "KeyM" || event.key.toLowerCase() === "m")) { event.preventDefault(); void getCurrentWindow().close(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  useEffect(() => {
    if (!isTauri()) { // Browser preview of the capsule with sample servers.
      setState({ theme: document.documentElement.dataset.theme ?? "dark", language: i18n.language, selectedRunId: "a", runs: [
        { runId: "profile:example-balanced", name: "Example model — Balanced", index: 0, state: "busy", tps: 47.8, managed: true },
        { runId: "profile:example-long", name: "Example model — Long context", index: 1, state: "ready", tps: 0, managed: true },
      ] });
      return;
    }
    let off: (() => void) | undefined, disposed = false;
    void listen<MiniState>("mini://state", ({ payload }) => {
      setState(payload);
      document.documentElement.dataset.theme = payload.theme;
      if (i18n.language !== payload.language) void i18n.changeLanguage(payload.language);
    }).then(unlisten => { if (disposed) unlisten(); else { off = unlisten; send({ action: "ready" }); } });
    return () => { disposed = true; off?.(); };
  }, []);
  const runs = (state?.runs ?? []).filter(run => run.state !== "stopped" || run.runId === state?.selectedRunId).slice(0, 3);
  return <div className="miniShell" data-tauri-drag-region>
    <header data-tauri-drag-region><b data-tauri-drag-region>Aplot</b>
      <button type="button" aria-label={t("mini.openMain")} title={t("mini.openMain")} onClick={() => send({ action: "focus" })}><Maximize2 size={13}/></button>
      <button type="button" aria-label={t("actions.close")} title={t("actions.close")} onClick={() => void getCurrentWindow().close()}><X size={13}/></button></header>
    {!state && <p className="miniEmpty">{t("mini.connecting")}</p>}
    {state && !runs.length && <p className="miniEmpty">{t("mini.noServers")}</p>}
    {runs.map(run => {
      const live = ["ready", "busy"].includes(run.state), stopped = ["stopped", "crashed"].includes(run.state);
      return <div key={run.runId} className="miniRun" style={{ ["--c" as string]: runColor(run.runId) }}>
        <span className={`kLed is-${run.state}`} aria-hidden="true"/>
        <button type="button" className="miniName" onClick={() => send({ action: "select", runId: run.runId })}><i>S{run.index + 1}</i>{run.name}</button>
        <b className="kMono">{live && run.tps > 0 ? run.tps.toFixed(1) : t(`status.${run.state}`)}</b>
        {run.managed && <button type="button" className="miniAct" aria-label={t(stopped ? "actions.start" : "actions.stop")} title={t(stopped ? "actions.start" : "actions.stop")}
          onClick={() => send({ action: stopped ? "start" : "stop", runId: run.runId })}>{stopped ? <Play size={13}/> : <Square size={12}/>}</button>}
      </div>;
    })}
  </div>;
}
