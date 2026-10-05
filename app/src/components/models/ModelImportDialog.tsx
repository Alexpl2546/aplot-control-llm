import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, FolderOpen, MoveRight } from "lucide-react";
import { Button } from "../ui/Primitives";
import type { ModelImportRequest } from "../../services/modelImport";
import { isTauri, listProfiles } from "../../services/tauri";
import { useControlStore } from "../../store/control";

type ImportProgress = { done: number; total: number; file: string; phase: string };
export function ModelImportDialog() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<ModelImportRequest>();
  const requestRef = useRef<ModelImportRequest | undefined>(undefined);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ImportProgress>();
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [request]);
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ModelImportRequest>).detail;
      if (requestRef.current) { next.resolve(undefined); return; }
      requestRef.current = next; setRequest(next); setError(""); setProgress(undefined);
      if (isTauri()) void invoke<string>("model_library_path").then(setDestination).catch(reason => setError(String(reason)));
    };
    window.addEventListener("aplot-model-import", receive);
    return () => { window.removeEventListener("aplot-model-import", receive); requestRef.current?.resolve(undefined); };
  }, []);
  const finish = (path?: string) => { requestRef.current?.resolve(path); requestRef.current = undefined; setRequest(undefined); };
  const transfer = async (mode: "copy" | "move") => {
    if (!request) return;
    setBusy(true); setError(""); setProgress(undefined);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ImportProgress>("model-import-progress", event => setProgress(event.payload));
      const path = await invoke<string>("import_model_directory", { sourcePath: request.path, mode });
      if (mode === "move") {
        const profiles = await listProfiles();
        const state = useControlStore.getState();
        const old = request.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
        const relocate = <T,>(value: T): T => {
          if (typeof value === "string") {
            const normalized = value.replace(/\\/g, "/");
            const lower = normalized.toLowerCase();
            return (lower === old || lower.startsWith(`${old}/`) ? path + normalized.slice(old.length).replace(/\//g, "\\") : value) as T;
          }
          if (Array.isArray(value)) return value.map(relocate) as T;
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) as T;
          return value;
        };
        const directories = state.settings.modelDirectories.map(relocate);
        await state.updateSettings({ modelDirectories: [...directories, path] });
        useControlStore.setState({ profiles, config: relocate(state.config), savedConfig: relocate(state.savedConfig) });
      }
      finish(path);
    } catch (reason) { setError(String(reason)); }
    finally { unlisten?.(); setBusy(false); }
  };
  if (!request) return null;
  const percent = progress?.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : undefined;
  return <div className="modalBackdrop modelImportBackdrop"><section ref={dialogRef} className="modelImportDialog" role="dialog" aria-modal="true" aria-labelledby="model-import-title" onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); finish(); }
    if (event.key === "Tab") {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
  }}>
    <h2 id="model-import-title">{t("modelImport.title")}</h2>
    <p>{t("modelImport.help")}</p>
    <div className="modelImportPaths"><span>{t("modelImport.source")}</span><code>{request.path}</code><span>{t("modelImport.destination")}</span><code>{destination || t("modelImport.loading")}</code></div>
    {busy ? <div className="modelImportProgress" role="status"><b>{t(progress?.phase === "verify" ? "modelImport.verifying" : "modelImport.copying")}{percent != null ? ` · ${percent}%` : ""}</b><progress max={100} value={percent}/>{progress?.file && <code>{progress.file}</code>}<Button onClick={() => void invoke("cancel_model_import")}>{t("actions.cancel")}</Button></div> : <div className="modelImportChoices">
      <Button onClick={() => finish(request.path)}><FolderOpen size={18}/><span><b>{t("modelImport.keep")}</b><small>{t("modelImport.keepHelp")}</small></span></Button>
      <Button disabled={!destination} onClick={() => void transfer("copy")}><Copy size={18}/><span><b>{t("modelImport.copy")}</b><small>{t("modelImport.copyHelp")}</small></span></Button>
      <Button disabled={!destination} onClick={() => void transfer("move")}><MoveRight size={18}/><span><b>{t("modelImport.move")}</b><small>{t("modelImport.moveHelp")}</small></span></Button>
    </div>}
    {error && <div className="modelImportError" role="alert">{error}</div>}
    {!busy && <footer><Button onClick={() => finish()}>{t("actions.cancel")}</Button></footer>}
  </section></div>;
}
