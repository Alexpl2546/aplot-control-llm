import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { ArrowUpCircle, Download, FolderOpen, Layers, RefreshCw } from "lucide-react";
import { Button, Panel } from "../components/ui/Primitives";
import { formatBytes } from "../components/config/ComponentInstall";
import { revealItem } from "../services/desktop";
import { strataEngineStatus, subscribeStrataEngineUpdate, updateStrataEngine, type StrataEngineFamily, type StrataEngineInfo } from "../services/tauri";
import { useControlStore } from "../store/control";

const NAMES: Record<StrataEngineFamily, string> = { qwen: "Qwen", deepseek: "DeepSeek" };
const tag = (version: string) => /^\d/.test(version) ? `v${version}` : version;

/** Qwen and DeepSeek are separate engines inside one Strata folder, each with its own version and updates. */
export function StrataEngines({ rootPath }: { rootPath: string }) {
  const { t, i18n } = useTranslation();
  const busy = useControlStore(state => state.busy);
  const notify = useControlStore(state => state.notify);
  const [engines, setEngines] = useState<StrataEngineInfo[]>([]);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<StrataEngineFamily | null>(null);
  const [progress, setProgress] = useState("");

  // Installed versions come from disk at once; the signed feed is read right after.
  const load = useCallback(async (root: string) => {
    if (!root) { setEngines([]); return; }
    try { setEngines(await strataEngineStatus(root, false)); } catch { setEngines([]); return; }
    setChecking(true);
    try { setEngines(await strataEngineStatus(root, true)); } catch { /* installed versions stay visible */ }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void load(rootPath.trim()); }, [rootPath, load]);

  const update = async (family: StrataEngineFamily) => {
    if (updating || busy) return;
    setUpdating(family); setProgress("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await subscribeStrataEngineUpdate(event => {
        if (event.family !== family) return;
        setProgress(`${event.message}${typeof event.percent === "number" ? ` · ${Math.round(event.percent)}%` : ""}`);
      });
      const result = await updateStrataEngine(rootPath.trim(), family);
      const engine = NAMES[family];
      if (result.status === "installed") notify("success", t("engine.installed", { engine, version: result.currentVersion ?? "" }));
      else if (result.status === "updated") notify("success", result.currentVersion ? t("settings.strataEngineUpdated", { engine, version: result.currentVersion }) : result.message);
      else if (result.status === "upToDate") notify("success", result.currentVersion ? t("settings.strataEngineUpToDate", { engine, version: result.currentVersion }) : result.message);
      else notify("error", result.status === "notInstalled" ? t("settings.strataEngineNotInstalled", { engine }) : result.message);
    } catch (error) { notify("error", String(error)); }
    finally { unlisten?.(); setUpdating(null); setProgress(""); void load(rootPath.trim()); }
  };

  if (!rootPath.trim()) return null;
  return <Panel className="settingsSection engineBlock">
    <h3><Layers size={15}/>{t("engine.strataEngines")}{checking && <span className="engineHeadNote"><RefreshCw size={12} className="componentSpin"/>{t("engine.checking")}</span>}</h3>
    <div className="strataEngines">{(["qwen", "deepseek"] as const).map(family => {
      const info = engines.find(item => item.family === family);
      const installed = !!info?.installedVersion;
      const running = updating === family;
      return <div key={family} className={clsx("strataEngine", !installed && "isAbsent")}>
        <span className={`strataEngineMark is-${family}`} aria-hidden="true">{NAMES[family][0]}</span>
        <div className="strataEngineText">
          <div className="oaCardName"><strong>{NAMES[family]}</strong>
            {installed ? <span className="componentTag isVersion">{tag(info!.installedVersion!)}</span> : <span className="componentStatus is-absent"><i aria-hidden="true"/>{t("components.status.absent")}</span>}
            {info?.updateAvailable && info.availableVersion && <span className="componentStatus is-update"><ArrowUpCircle size={11}/>{t("engine.updateTo", { version: tag(info.availableVersion) })}</span>}
            {installed && info?.checked && !info.updateAvailable && <span className="componentStatus is-installed"><i aria-hidden="true"/>{t("engine.upToDate")}</span>}
          </div>
          <p>{installed ? <code title={info!.path ?? ""}>{info!.path}</code> : t(family === "qwen" ? "engine.qwenMissing" : "engine.deepseekInstallHint")}</p>
          {running && <p className="engineNote" role="status" aria-live="polite">{progress || t("settings.strataUpdatingEngine", { engine: NAMES[family] })}</p>}
        </div>
        <div className="oaCardActions">
          {!installed && family === "deepseek" && <Button className="primary" disabled={busy || !!updating} onClick={() => void update(family)}>
            <Download size={14} className={running ? "componentSpin" : undefined}/>{t(running ? "engine.installing" : "engine.install")}
          </Button>}
          {installed && <Button className={info?.updateAvailable ? "primary" : undefined} disabled={busy || !!updating}
            title={info?.downloadBytes ? t("components.update.download", { size: formatBytes(info.downloadBytes, i18n.resolvedLanguage) }) : undefined}
            onClick={() => void update(family)}>
            <RefreshCw size={14} className={running ? "componentSpin" : undefined}/>{t(running ? "components.update.running" : info?.updateAvailable ? "components.update.action" : "engine.checkUpdate")}
          </Button>}
          {installed && info?.path && <Button className="kIconBtn" title={t("components.showFolder")} aria-label={t("components.showFolder")} onClick={() => void revealItem(info.path!).catch(error => notify("error", String(error)))}><FolderOpen size={14}/></Button>}
        </div>
      </div>;
    })}</div>
  </Panel>;
}
