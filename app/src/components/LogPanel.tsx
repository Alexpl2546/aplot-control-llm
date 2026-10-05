import { Download, Pause, Play, Search, Trash2 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import type { LogLine } from "../types/runtime";
import { Button } from "./ui/Primitives";

export function LogPanel() {
  const { t } = useTranslation();
  const { logs, logFilter, logSearch, setLogFilter, setLogSearch, clearLogs } = useControlStore();
  const [pausedSnapshot, setPausedSnapshot] = useState<LogLine[] | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const visibleSource = pausedSnapshot ?? logs;
  const paused = pausedSnapshot !== null;
  const filtered = useMemo(() => visibleSource.filter(line =>
    (logFilter === "ALL" || line.level === logFilter) &&
    (!logSearch || line.message.toLowerCase().includes(logSearch.toLowerCase()))
  ), [visibleSource, logFilter, logSearch]);

  useLayoutEffect(() => {
    if (paused || !rowsRef.current) return;
    const rows = rowsRef.current;
    const scrollToEnd = () => { rows.scrollTop = rows.scrollHeight; };
    scrollToEnd();
    const observer = new ResizeObserver(scrollToEnd);
    observer.observe(rows);
    return () => observer.disconnect();
  }, [filtered, paused]);

  const togglePause = () => setPausedSnapshot(current => current ? null : [...logs]);
  const exportLogs = () => {
    const body = filtered.map(line => `${line.timestamp} ${line.level.padEnd(5)} [${line.source}] ${line.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aplot-control-llm-${Date.now()}.log`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <section className="panel logsPanel">
    <div className="logsToolbar">
      <h3>{t("logs.title")}</h3>
      <div className="filterButtons" role="group" aria-label={t("logs.levelFilter")}>{(["ALL", "INFO", "WARN", "ERROR", "DEBUG"] as const).map(level => (
        <button type="button" className={logFilter === level ? "active" : ""} key={level} aria-pressed={logFilter === level} onClick={() => setLogFilter(level)}>
          {t(`logs.level.${level.toLowerCase()}`)} ({level === "ALL" ? visibleSource.length : visibleSource.filter(line => line.level === level).length})
        </button>
      ))}</div>
      <label className="search"><Search size={14} aria-hidden="true"/><input type="search" aria-label={t("logs.search")} placeholder={t("logs.search")} value={logSearch} onChange={event => setLogSearch(event.target.value)}/></label>
      <Button aria-label={paused ? t("logs.resume") : t("logs.pause")} title={paused ? t("logs.resume") : t("logs.pause")} onClick={togglePause}>{paused ? <Play size={14}/> : <Pause size={14}/>}</Button>
      <Button aria-label={t("logs.export")} title={t("logs.export")} onClick={exportLogs}><Download size={14}/></Button>
      <Button aria-label={t("logs.clear")} title={t("logs.clear")} onClick={clearLogs}><Trash2 size={14}/></Button>
    </div>
    <div className="logRows" ref={rowsRef} role="log" aria-live={paused ? "off" : "polite"}>
      {filtered.length === 0 ? <div className="logsEmpty">{visibleSource.length ? t("logs.noMatches") : t("logs.empty")}</div> : filtered.map((line, index) => (
        <div className="logRow" key={line.id}>
          <span className="logLineNumber">{index + 1}</span>
          <time dateTime={line.timestamp}>{new Date(line.timestamp).toLocaleTimeString([], { hour12: false })}</time>
          <b className={line.level.toLowerCase()}>{line.level}</b>
          <span className="logSource" title={line.source}>{line.source}</span>
          <code title={line.message}>{line.message}</code>
        </div>
      ))}
    </div>
  </section>;
}
