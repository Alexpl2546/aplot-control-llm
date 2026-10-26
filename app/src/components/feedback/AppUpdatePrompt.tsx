import { check } from "@tauri-apps/plugin-updater";
import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../services/tauri";
import { Button } from "../ui/Primitives";
import "./AppUpdatePrompt.css";

type AppUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type UpdatePhase = "available" | "downloading" | "installing" | "error";

// Keep one startup check for the lifetime of the webview. React StrictMode mounts
// effects twice in development, and a cached promise prevents duplicate requests.
let startupUpdateCheck: ReturnType<typeof check> | undefined;
function checkForStartupUpdate() {
  startupUpdateCheck ??= check();
  return startupUpdateCheck;
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

export function AppUpdatePrompt({ enabled }: { enabled: boolean }) {
  const { t, i18n } = useTranslation();
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | undefined>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const downloadedRef = useRef(0);
  const contentLengthRef = useRef<number | undefined>(undefined);
  const busy = phase === "downloading" || phase === "installing";

  useEffect(() => {
    if (!enabled || !isTauri() || import.meta.env.DEV) return;
    let active = true;
    void checkForStartupUpdate().then(result => {
      if (active && result) setUpdate(result);
    }).catch(cause => {
      // Update checks are best-effort at startup. A missing network or an
      // unavailable feed should not block the app's regular startup flow.
      console.warn("Could not check for application updates", cause);
    });
    return () => { active = false; };
  }, [enabled]);

  useEffect(() => {
    if (!update) return;
    const element = dialog.current;
    if (!element) return;
    const previouslyFocused = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [update]);

  const dismiss = () => {
    if (busy || !update) return;
    const dismissed = update;
    setUpdate(null);
    void dismissed.close().catch(cause => console.warn("Could not release update metadata", cause));
  };

  const install = async () => {
    if (!update || busy) return;
    downloadedRef.current = 0;
    contentLengthRef.current = undefined;
    setDownloaded(0);
    setContentLength(undefined);
    setError("");
    setPhase("downloading");
    try {
      await update.downloadAndInstall(event => {
        if (event.event === "Started") {
          contentLengthRef.current = event.data.contentLength;
          setContentLength(event.data.contentLength);
        } else if (event.event === "Progress") {
          downloadedRef.current += event.data.chunkLength;
          setDownloaded(downloadedRef.current);
        } else if (event.event === "Finished") {
          if (contentLengthRef.current !== undefined) setDownloaded(contentLengthRef.current);
          setPhase("installing");
        }
      });
      // On Windows the updater launches the NSIS installer and exits the app.
      // Keep the modal in its installing state while that handoff completes.
      setPhase("installing");
    } catch (cause) {
      setError(describeError(cause));
      setPhase("error");
    }
  };

  if (!update) return null;
  const percent = contentLength && contentLength > 0
    ? Math.min(100, Math.round(downloaded / contentLength * 100))
    : undefined;
  const formatBytes = (bytes: number) => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(bytes / (1024 * 1024));

  return (
    <dialog
      ref={dialog}
      className="awDialog appUpdateDialog"
      aria-labelledby="app-update-title"
      aria-describedby="app-update-description"
      aria-busy={busy || undefined}
      onCancel={event => { event.preventDefault(); if (!busy) dismiss(); }}
      onClick={event => { if (event.target === event.currentTarget && !busy) dismiss(); }}
    >
      <header>
        <h3 id="app-update-title">{t("appUpdate.title")}</h3>
        <button type="button" className="kIconBtn" aria-label={t("actions.close")} disabled={busy} onClick={dismiss}>
          <X size={17}/>
        </button>
      </header>
      <div className="appUpdateBody">
        <p id="app-update-description">
          {t("appUpdate.available", { version: update.version, currentVersion: update.currentVersion })}
        </p>
        {update.body && <section className="appUpdateNotes" aria-label={t("appUpdate.releaseNotes")}>
          <h4>{t("appUpdate.releaseNotes")}</h4>
          <p>{update.body}</p>
        </section>}
        {phase === "downloading" && <div className="appUpdateProgress" role="status" aria-live="polite">
          <p>{t("appUpdate.downloading")}{percent !== undefined ? ` ${percent}%` : ""}</p>
          <div
            className={`appUpdateProgressBar${percent === undefined ? " isIndeterminate" : ""}`}
            role="progressbar"
            aria-label={t("appUpdate.downloading")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          ><span style={percent === undefined ? undefined : { width: `${percent}%` }}/></div>
          <small>{contentLength !== undefined
            ? `${formatBytes(downloaded)} / ${formatBytes(contentLength)}`
            : formatBytes(downloaded)}</small>
        </div>}
        {phase === "installing" && <p className="appUpdateStatus" role="status" aria-live="polite">
          <Download size={15}/>{t("appUpdate.installing")}
        </p>}
        {phase === "error" && <div className="appUpdateError" role="alert">
          <p>{t("appUpdate.error")}</p>
          {error && <details><summary>{t("appUpdate.technical")}</summary><pre>{error}</pre></details>}
        </div>}
      </div>
      <div className="awDialogActions">
        {phase === "available" && <>
          <Button type="button" onClick={dismiss}>{t("appUpdate.later")}</Button>
          <Button type="button" className="primary" onClick={() => void install()}>
            <Download size={15}/>{t("appUpdate.install")}
          </Button>
        </>}
        {phase === "error" && <>
          <Button type="button" onClick={dismiss}>{t("appUpdate.later")}</Button>
          <Button type="button" className="primary" onClick={() => void install()}>{t("appUpdate.retry")}</Button>
        </>}
      </div>
    </dialog>
  );
}
