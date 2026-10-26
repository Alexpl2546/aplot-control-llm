import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, FolderOpen, HardDrive, X } from "lucide-react";
import { Button, Input } from "../../components/ui/Primitives";
import { pickDirectory } from "../../services/dialog";
import { isTauri } from "../../services/tauri";
import { useModelDownloadStore } from "./store";
import { modelDownloadDestination, prepareModelDownload, resolveModelDownload, startModelDownload } from "./service";
import { filesForSelection, selectionFiles, suggestedVariant, totalBytesForSelection } from "./rules";
import type { DownloadPlan, DownloadVariant, ResolvedDownload } from "./types";

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) { value /= 1024; unit = units[index]; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
};

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

export function DownloadModelDialog({ open, onClose, onQueued, initialSource = '', initialDestination = '' }: { open: boolean; onClose: () => void; onQueued?:()=>void; initialSource?:string; initialDestination?:string }) {
  const { t } = useTranslation();
  const applyTask = useModelDownloadStore(state => state.applyTask);
  const [source, setSource] = useState("");
  const [resolved, setResolved] = useState<ResolvedDownload>();
  const [variantId, setVariantId] = useState("");
  const [mmprojPath, setMmprojPath] = useState("");
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<DownloadPlan>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const variant = resolved?.variants.find(item => item.id === variantId);
  const paths = useMemo(() => selectionFiles(variant, mmprojPath), [variant, mmprojPath]);
  const selectedFiles = resolved ? filesForSelection(resolved, paths) : [];
  const selectedBytes = resolved ? totalBytesForSelection(resolved, paths) : 0;
  const mmprojFiles = resolved?.files.filter(file => file.role === "mmproj") ?? [];

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    setSource(initialSource); setResolved(undefined); setVariantId(""); setMmprojPath(""); setPlan(undefined); setError("");
    setDestination(initialDestination);
    if (!initialDestination) void modelDownloadDestination().then(value => { if (!disposed) setDestination(value); }).catch(cause => { if (!disposed) setError(String(cause)); });
    setWorking(Boolean(initialSource));
    if (initialSource) void resolveModelDownload(initialSource).then(result => {
      if (disposed) return;
      setResolved(result);
      setVariantId(suggestedVariant(result.variants, result.suggestedFile));
    }).catch(cause => { if (!disposed) setError(String(cause)); }).finally(() => { if (!disposed) setWorking(false); });
    return () => { disposed = true; previous?.focus(); };
  }, [open, initialSource, initialDestination]);

  if (!open) return null;

  const resolve = async () => {
    if (!source.trim()) return;
    setWorking(true); setError(""); setPlan(undefined);
    try {
      const result = await resolveModelDownload(source.trim());
      setResolved(result);
      setVariantId(suggestedVariant(result.variants, result.suggestedFile));
      setMmprojPath("");
    } catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };

  const prepare = async () => {
    if (!resolved || !variant || !paths.length || !destination.trim()) return;
    setWorking(true); setError(""); setPlan(undefined);
    try {
      const next = await prepareModelDownload({ source: resolved.source, revision: resolved.revision, files: paths }, destination.trim());
      setPlan(next);
    } catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };

  const enqueue = async () => {
    if (!plan) return;
    setWorking(true); setError("");
    try {
      const task = await startModelDownload(plan.planId, plan);
      applyTask(task);
      onClose();onQueued?.();
    } catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };

  const chooseDestination = async () => {
    const selected = await pickDirectory();
    if (selected) { setDestination(selected); setPlan(undefined); }
  };

  return createPortal(<div className="modalBackdrop modelDownloadBackdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !working) onClose(); }}>
    <section ref={dialogRef} className="modelDownloadDialog" role="dialog" aria-modal="true" aria-labelledby="model-download-title" onKeyDown={event => {
      if (event.key === "Escape" && !working) { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href]"));
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    }}>
      <header className="modelDownloadHeader">
        <div><span className="modelDownloadEyebrow">{t("downloads.sourceLabel")}</span><h2 id="model-download-title">{t("downloads.dialogTitle")}</h2></div>
        <Button aria-label={t("actions.close")} disabled={working} onClick={onClose}><X size={16}/></Button>
      </header>
      <p className="modelDownloadIntro">{t("downloads.dialogHelp")}</p>
      {!isTauri() && <div className="modelDownloadDemo" role="status">{t("downloads.demoMode")}</div>}

      <div className="modelDownloadSource">
        <label htmlFor="model-download-source">{t("downloads.source")}</label>
        <div className="modelDownloadSourceRow">
          <Input id="model-download-source" value={source} disabled={working} placeholder="owner/repository or https://huggingface.co/owner/repository" onChange={event => { setSource(event.target.value); setResolved(undefined); setPlan(undefined); setError(""); }}/>
          <Button className="primary" disabled={working || !source.trim()} onClick={() => void resolve()}>{t(resolved ? "downloads.refreshFiles" : "downloads.resolve")}</Button>
        </div>
      </div>

      {resolved && <div className="modelDownloadResolved">
        <div className="modelDownloadRepository"><div><b>{resolved.repoId}</b><small>{t("downloads.revision")}: <code>{resolved.revision}</code> · {resolved.publisher}</small></div><a href={resolved.repositoryUrl} target="_blank" rel="noreferrer" aria-label={t("downloads.openRepository")}><ExternalLink size={15}/></a></div>
        <fieldset className="modelDownloadVariants">
          <legend>{t("downloads.variant")}</legend>
          {resolved.variants.map((item: DownloadVariant) => <label key={item.id} className={`modelDownloadOption${item.complete ? "" : " isUnavailable"}`}>
            <input type="radio" name="model-download-variant" value={item.id} checked={variantId === item.id} disabled={!item.complete || working} onChange={() => { setVariantId(item.id); setPlan(undefined); }}/>
            <span><b>{item.label}</b><small>{item.files.length} {t("downloads.files")} · {formatBytes(item.totalBytes)}{!item.complete ? ` · ${t("downloads.incomplete")}` : ""}</small></span>
          </label>)}
          {!resolved.variants.length && <p>{t("downloads.noVariants")}</p>}
        </fieldset>

        <fieldset className="modelDownloadVariants modelDownloadMmproj">
          <legend>{t("downloads.mmprojTitle")}</legend>
          <label className="modelDownloadOption"><input type="radio" name="model-download-mmproj" value="" checked={!mmprojPath} disabled={working} onChange={() => { setMmprojPath(""); setPlan(undefined); }}/><span><b>{t("downloads.mmprojNone")}</b><small>{t("downloads.mmprojOptional")}</small></span></label>
          {mmprojFiles.map(file => <label key={file.path} className="modelDownloadOption"><input type="radio" name="model-download-mmproj" value={file.path} checked={mmprojPath === file.path} disabled={working} onChange={() => { setMmprojPath(file.path); setPlan(undefined); }}/><span><b>{fileName(file.path)}</b><small>{formatBytes(file.sizeBytes)} · {file.quantization ?? "GGUF"}</small></span></label>)}
          {mmprojFiles.length === 0 && <small>{t("downloads.mmprojNotFound")}</small>}
        </fieldset>

        <div className="modelDownloadFiles">
          <b>{t("downloads.selectedFiles", { count: selectedFiles.length })} · {formatBytes(selectedBytes)}</b>
          <ul>{selectedFiles.map(file => <li key={file.path}><span>{fileName(file.path)}</span><small>{file.role} · {formatBytes(file.sizeBytes)}</small></li>)}</ul>
        </div>

        <div className="modelDownloadDestination">
          <label htmlFor="model-download-destination">{t("downloads.destination")}</label>
          <div><Input id="model-download-destination" value={destination} disabled={working} onChange={event => { setDestination(event.target.value); setPlan(undefined); }}/><Button aria-label={t("downloads.chooseDestination")} disabled={working || !isTauri()} onClick={() => void chooseDestination()}><FolderOpen size={16}/></Button></div>
        </div>

        {plan && <div className="modelDownloadPlan" role="status">
          <div><HardDrive size={15}/><b>{t("downloads.planReady")}</b><span>{formatBytes(plan.totalBytes)}</span></div>
          <p>{t("downloads.availableSpace")}: {formatBytes(plan.availableBytes)}</p>
          <code>{plan.finalPath}</code>
          {plan.warnings.map((warning, index) => <p className="modelDownloadWarning" key={`${index}:${warning}`}>{warning}</p>)}
          <p>{t("downloads.strataNote")}</p>
        </div>}
      </div>}

      {error && <div className="modelDownloadError" role="alert">{error}</div>}
      <footer className="modelDownloadFooter">
        <Button disabled={working} onClick={onClose}>{t("actions.cancel")}</Button>
        {resolved && !plan && <Button className="primary" disabled={working || !variant?.complete || !paths.length || !destination.trim()} onClick={() => void prepare()}>{t("downloads.prepare")}</Button>}
        {plan && <Button className="primary" disabled={working || plan.availableBytes < plan.totalBytes} onClick={() => void enqueue()}><Download size={15}/>{t("downloads.enqueue")}</Button>}
        {working && <span role="status">{t("downloads.working")}</span>}
      </footer>
    </section>
  </div>, document.body);
}
