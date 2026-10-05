import { listen } from "@tauri-apps/api/event";
import type { BenchmarkProgress } from "./types/app";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { ModelImportDialog } from "./components/models/ModelImportDialog";
import { WorkspaceChrome } from "./components/WorkspaceChrome";
import { useStudioCopy } from "./components/ui/studioCopy";
import { Sidebar } from "./components/Sidebar";
import { RecoveryBanner } from "./components/runtime/RecoveryBanner";
import { SetupWizard } from "./components/setup/SetupWizard";
import { ToastHost } from "./components/feedback/ToastHost";
import { ErrorBanner } from "./components/feedback/ErrorBanner";
import { installDesktopLifecycle } from "./services/desktop";
import { subscribeLogs, subscribeServerState } from "./services/tauri";
import { useControlStore } from "./store/control";

const ConfigurationView = lazy(() => import("./views/ConfigurationView").then(module => ({ default: module.ConfigurationView })));
const DashboardView = lazy(() => import("./views/DashboardView").then(module => ({ default: module.DashboardView })));
const LibraryView = lazy(() => import("./views/LibraryView").then(module => ({ default: module.LibraryView })));
const PerformanceView = lazy(() => import("./views/PerformanceView").then(module => ({ default: module.PerformanceView })));
const LogsView = lazy(() => import("./views/LogsView").then(module => ({ default: module.LogsView })));
const ApiDocsView = lazy(() => import("./views/ApiDocsView").then(module => ({ default: module.ApiDocsView })));
const SettingsView = lazy(() => import("./views/SettingsView").then(module => ({ default: module.SettingsView })));

export default function App() {
  const [sidebarPinned, setSidebarPinned] = useState(() => { try { return localStorage.getItem("aplot.sidebarPinned") !== "false"; } catch { return true; } });
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const toggleSidebar = () => {
    const pinned = !sidebarPinned;
    setSidebarPinned(pinned);
    try { localStorage.setItem("aplot.sidebarPinned", String(pinned)); } catch { /* Keep the session preference if storage is unavailable. */ }
  };
  const { t, i18n } = useTranslation();
  const studio = useStudioCopy();
  const { activeView, appendLog, setServerState, initialize, refreshRuntime, settings } = useControlStore();
  const trayLabels = useMemo(() => ({
    show: t("tray.show"),
    quit: t("tray.quit"),
    start: t("actions.start"),
    stop: t("actions.stop"),
    status: {
      stopped: t("status.stopped"), starting: t("status.starting"), loading: t("status.loading"), ready: t("status.ready"),
      busy: t("status.busy"), stopping: t("status.stopping"), restarting: t("status.restarting"), crashed: t("status.crashed"),
    },
    initError: t("error.trayInitFailed"),
  }), [i18n.language, t]);
  const trayLabelsRef = useRef(trayLabels);

  useEffect(() => { void initialize(); }, [initialize]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<BenchmarkProgress>("benchmark-progress", ({ payload }) => {
      useControlStore.setState(state => ({
        benchmarkProgress: { ...state.benchmarkProgress, ...payload },
        benchmarkEvents: [...state.benchmarkEvents.slice(-19), { ...payload, timestamp: Date.now() }],
      }));
    }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
    return () => { disposed = true; off?.(); };
  }, []);

  useEffect(() => { trayLabelsRef.current = trayLabels; }, [trayLabels]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.theme]);

  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWebview().setZoom(settings.uiScale).catch(error => console.error("Could not update interface scale", error));
    } else {
      document.documentElement.style.zoom = String(settings.uiScale);
    }
  }, [settings.uiScale]);

  useEffect(() => {
    let offLogs: (() => void) | undefined;
    let offState: (() => void) | undefined;
    void subscribeLogs(appendLog).then(fn => { offLogs = fn; });
    void subscribeServerState(setServerState).then(fn => { offState = fn; });
    return () => { offLogs?.(); offState?.(); };
  }, [appendLog, setServerState]);

  useEffect(() => {
    const id = window.setInterval(() => void refreshRuntime(), Math.max(500, settings.pollIntervalMs));
    return () => window.clearInterval(id);
  }, [refreshRuntime, settings.pollIntervalMs]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void installDesktopLifecycle(
      () => useControlStore.getState().settings,
      () => trayLabelsRef.current,
      () => useControlStore.getState().runtime.state,
      async () => {
        const state = useControlStore.getState();
        if (["stopped", "crashed"].includes(state.runtime.state)) await state.start();
        else await state.stop();
      },
    ).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(error => {
      console.error("Could not initialize Aplot Control LLM system tray", error);
      useControlStore.setState({ error: `${trayLabelsRef.current.initError} ${String(error)}` });
    });
    return () => { cancelled = true; dispose?.(); };
  }, []);

  const view = {
    dashboard: <DashboardView />,
    configuration: <ConfigurationView />,
    models: <LibraryView initialTab="models" />,
    profiles: <LibraryView initialTab="profiles" />,
    performance: <PerformanceView />,
    logs: <LogsView />,
    apiDocs: <ApiDocsView />,
    settings: <SettingsView />,
  }[activeView];

  return (
    <div className={`appShell${sidebarPinned ? "" : " sidebarUnpinned"}`}>
      <a className="skipLink" href="#main-content">{studio.skip}</a>
      <Sidebar pinned={sidebarPinned} expanded={sidebarPinned || sidebarHovered} onTogglePin={toggleSidebar} onHoverChange={setSidebarHovered} />
      <div className="workspace">
        <WorkspaceChrome />
        <ErrorBanner />
        <RecoveryBanner />
        <SetupWizard />
        <ToastHost />
        <ModelImportDialog />
        <main id="main-content" className={`routeStage${activeView === "logs" ? " routeStageLogs" : ""}`} key={activeView} tabIndex={-1}>
        <Suspense fallback={<div className="routeLoading" aria-hidden="true"><span/></div>}>
          {view}
        </Suspense>
        </main>
      </div>
    </div>
  );
}
