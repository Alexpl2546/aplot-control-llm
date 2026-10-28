import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "../../services/tauri";
import { useControlStore } from "../../store/control";
import { chooseModelLocation } from "../../services/modelImport";
import { mergeModelDirectories } from "../../lib/modelDirectories";
import { addAgentPaths } from "../agent/AgentInputTools";
import { useAgentStore } from "../agent/store";

type DropState = { kind: "model"; count: number } | { kind: "other" } | null;
const isModel = (path: string) => /\.gguf$/i.test(path);
const parentOf = (path: string) => path.replace(/[\\/][^\\/]+$/, "");

/** Finds the drop zone under a native drop position (physical pixels) — e.g. an agent composer. */
function zoneAt(x: number, y: number) {
  const ratio = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(x / ratio, y / ratio);
  const zone = element?.closest<HTMLElement>("[data-file-drop]");
  return zone ? { element: zone, target: zone.dataset.fileDrop ?? "" } : undefined;
}

async function importModels(paths: string[]) {
  const control = useControlStore.getState();
  const directories = [...new Set(paths.filter(isModel).map(parentOf))];
  let added = 0;
  for (const directory of directories) {
    const location = await chooseModelLocation(directory);
    if (!location) continue;
    const state = useControlStore.getState();
    await state.updateSettings({ modelDirectories: mergeModelDirectories(state.settings.modelDirectories, location) });
    added += 1;
  }
  if (added) await control.rescanModels();
  return added;
}

/**
 * Whole-window file drop. GGUF files dropped anywhere open the model import flow for their folder;
 * files dropped on an agent composer become attachments. Tauri delivers native paths here because
 * webview drag-drop handling is enabled for the main window.
 */
export function FileDropLayer() {
  const { t } = useTranslation();
  const [state, setState] = useState<DropState>(null);

  useEffect(() => {
    if (!isTauri()) {
      // Browser preview: show the overlay so the interaction can be reviewed; import itself needs the desktop app.
      let depth = 0;
      const enter = (event: DragEvent) => { if (!event.dataTransfer?.types.includes("Files")) return; depth += 1; setState({ kind: "model", count: event.dataTransfer.items.length }); };
      const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setState(null); };
      const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files") && !(event.target as HTMLElement | null)?.closest?.("[data-file-drop]")) event.preventDefault(); };
      const drop = (event: DragEvent) => { depth = 0; setState(null); if ((event.target as HTMLElement | null)?.closest?.("[data-file-drop]")) return; event.preventDefault(); useControlStore.getState().notify("info", t("drop.desktopOnly")); };
      window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave); window.addEventListener("dragover", over); window.addEventListener("drop", drop);
      return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
    }
    let disposed = false, off: (() => void) | undefined, highlighted: HTMLElement | undefined;
    const highlight = (element?: HTMLElement) => {
      if (highlighted === element) return;
      highlighted?.classList.remove("isDropTarget");
      element?.classList.add("isDropTarget");
      highlighted = element;
    };
    void getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { highlight(); setState(null); return; }
      if (payload.type === "enter" || payload.type === "over") {
        const zone = zoneAt(payload.position.x, payload.position.y);
        highlight(zone?.element);
        const paths = payload.type === "enter" ? payload.paths : undefined;
        if (zone) setState(null);
        else if (paths) setState(paths.some(isModel) ? { kind: "model", count: paths.filter(isModel).length } : { kind: "other" });
        else setState(current => current ?? { kind: "other" });
        return;
      }
      if (payload.type === "drop") {
        const zone = zoneAt(payload.position.x, payload.position.y);
        highlight(); setState(null);
        const control = useControlStore.getState();
        if (zone?.target.startsWith("agent:")) {
          const taskId = zone.target.slice("agent:".length);
          void addAgentPaths(taskId, payload.paths).catch(error => useAgentStore.getState().update(taskId, s => ({ ...s, ioError: String(error) })));
          return;
        }
        if (payload.paths.some(isModel)) {
          void importModels(payload.paths).then(added => { if (added) control.notify("success", t("drop.modelsAdded")); }).catch(error => control.notify("error", String(error)));
          return;
        }
        control.notify("info", t("drop.onlyModels"));
      }
    }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
    return () => { disposed = true; off?.(); highlight(); };
  }, [t]);

  if (!state) return null;
  return <div className={`kDropOverlay${state.kind === "other" ? " isOther" : ""}`} aria-hidden="true">
    <div className="kDropCard"><FileDown size={30}/>
      <b>{state.kind === "model" ? t("drop.modelTitle", { count: state.count }) : t("drop.otherTitle")}</b>
      <span>{state.kind === "model" ? t("drop.modelHint") : t("drop.otherHint")}</span>
    </div>
  </div>;
}
