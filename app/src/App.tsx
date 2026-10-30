import { WorkspaceDialog } from './features/agent/WorkspacePanels';
import { DefaultContextMenu } from './components/ui/DefaultContextMenu';
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { BenchmarkProgress } from "./types/app";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { ModelImportDialog } from "./components/models/ModelImportDialog";
import { WorkspaceChrome } from "./components/WorkspaceChrome";
import { useStudioCopy } from "./components/ui/studioCopy";
import { KSidebar } from "./components/shell/KSidebar";
import { KTopbar } from "./components/shell/KTopbar";
import { KStatusBar } from "./components/shell/KStatusBar";
import { AmbientField } from "./components/shell/AmbientField";
import { CommandPalette } from "./components/shell/CommandPalette";
import { FileDropLayer } from "./features/drop/FileDropLayer";
import { startRunStats } from "./features/live/runStats";
import { startStrataRouter } from "./features/live/strataRouter";
import { startPresence } from "./features/away/AwayDigest";
import { startTemplateSeeding } from "./features/agent/builtin/builtinAgents";
import { enterLightMode, leaveLightMode, lightModeSettled, startMiniBridge } from "./features/mini/miniWindow";
import { resolveDensity, useUiPrefs } from "./lib/uiPrefs";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";

import { AUTO_UI_SCALE, effectiveUiScale } from "./lib/uiScale";
import { useSidebarState } from "./components/shell/useSidebarState";
import { RecoveryBanner } from "./components/runtime/RecoveryBanner";
import { SetupWizard } from "./components/setup/SetupWizard";
import { ToastHost } from "./components/feedback/ToastHost";
import { AppUpdatePrompt } from "./components/feedback/AppUpdatePrompt";
import { ErrorBanner } from "./components/feedback/ErrorBanner";
import { installDesktopLifecycle } from "./services/desktop";
import { startRunMonitor } from "./features/launches/monitor";
import { useControlStore } from "./store/control";
import { isTauri } from "./services/tauri";
import { demoUrlView } from "./lib/demoUrl";
import { isModelView } from "./lib/navigation";
import { ModelsHub } from "./features/navigation/ModelsHub";
import { ServerOverview } from "./features/navigation/ServerCard";
import { flushWorkspace, initializeWorkspace, useWorkspaceStore } from "./features/agent/workspace";
import { startActivityMonitor } from './features/activity/store';
import { startModelDownloadMonitor } from "./features/modelDownloads/store";
import { viewModules, warmViewModules } from './lib/viewModules';
import { flushChatHistory, initializeChatHistory } from './features/chat/history';
import { startAcquisitionMonitor } from './features/modelDownloads/acquisition';
import { useChatStore } from './features/chat/store';

const ConfigurationView = lazy(viewModules.configuration);
const DashboardView = lazy(viewModules.dashboard);
const AgentWorkspaceView = lazy(viewModules.agentWorkspace);
const ChatView = lazy(viewModules.chat);
const KnowledgeView = lazy(viewModules.knowledge);
const LibraryView = lazy(viewModules.models);
const MetricsView = lazy(viewModules.performance);
const LogsView = lazy(viewModules.logs);
const ApiDocsView = lazy(viewModules.apiDocs);
const SettingsView = lazy(viewModules.settings);

const NAV_NOTE = "aplot.navigation.modelsHub";

export default function App() {
  const { t, i18n } = useTranslation();
  const studio = useStudioCopy();
  const activeView = useControlStore(state => state.activeView);
  const appendLog = useControlStore(state => state.appendLog);
  const setServerState = useControlStore(state => state.setServerState);
  const initialize = useControlStore(state => state.initialize);
  const refreshRuntime = useControlStore(state => state.refreshRuntime);
  const settings = useControlStore(state => state.settings);
  const settingsOpen = useControlStore(state => state.settingsOpen);
  const initialized = useControlStore(state => state.initialized);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const sidebar = useSidebarState();
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
    lightOn: t("mini.lightOn"),
    lightOff: t("mini.lightOff"),
  }), [i18n.language, t]);
  const trayLabelsRef = useRef(trayLabels);

  useEffect(() => {
    const view = isTauri() ? undefined : demoUrlView();
    if (view) useControlStore.getState().setView(view);
    void initialize();
  }, [initialize]);
  useEffect(() => { void initializeWorkspace(); }, []);
  useEffect(() => { void initializeChatHistory(); }, []);
  useEffect(() => { if (initialized) return warmViewModules(); }, [initialized]);
  useEffect(()=>startActivityMonitor(),[]);
  useEffect(() => startModelDownloadMonitor(), []);
  useEffect(() => startRunStats(), []);
  useEffect(() => startStrataRouter(), []);
  useEffect(() => startPresence(), []);
  useEffect(() => startTemplateSeeding(), []);
  useEffect(() => startMiniBridge(), []);
  const lightMode = useUiPrefs(state => state.lightMode);
  useEffect(() => {
    // Light mode survives restarts: the app comes back as the panel. Showing the main window by any route ends it.
    if (!isTauri()) return;
    if (useUiPrefs.getState().lightMode) void enterLightMode();
    let off: (() => void) | undefined, disposed = false;
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (focused && useUiPrefs.getState().lightMode && lightModeSettled()) void leaveLightMode(); })
      .then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
    return () => { disposed = true; off?.(); };
  }, []);
  useEffect(() => {
    // Once after the update that gathered the model screens: say where they went. New installs never knew the old menu.
    if (!initialized) return;
    try { if (localStorage.getItem(NAV_NOTE)) return; localStorage.setItem(NAV_NOTE, "1"); } catch { return; }
    const state = useControlStore.getState();
    if (state.settings.setupCompleted) state.notifyAction("info", t("modelsHub.moved"), { label: t("modelsHub.open"), run: () => state.setView("configuration") }, 12000);
  }, [initialized, t]);
  const density = useUiPrefs(state => state.density);
  const mica = useUiPrefs(state => state.mica);
  useEffect(() => {
    // "Auto" density: compact on laptop-sized windows, comfortable on large monitors.
    const apply = () => { document.documentElement.dataset.density = resolveDensity(density, window.innerWidth, window.innerHeight); };
    apply();
    if (density !== "auto") return;
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [density]);
  useEffect(() => {
    // Windows 11 Mica behind a transparent page; any failure (e.g. Windows 10) falls back to the opaque look.
    const root = document.documentElement;
    if (!isTauri()) { root.dataset.mica = mica ? "on" : "off"; return; }
    const win = getCurrentWindow();
    if (mica) void win.setEffects({ effects: [Effect.Mica] }).then(() => { root.dataset.mica = "on"; }).catch(error => {
      root.dataset.mica = "off"; useUiPrefs.getState().setMica(false);
      useControlStore.getState().notify("warning", `${t("mica.unavailable")} ${String(error)}`);
    });
    else { root.dataset.mica = "off"; void win.clearEffects().catch(() => undefined); }
  }, [mica]);
  useEffect(() => startAcquisitionMonitor(), []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void listen('app://before-shutdown', () => {
      void Promise.all([flushWorkspace(), flushChatHistory()]).then(() => invoke('workspace_shutdown_flushed', { saved: !useWorkspaceStore.getState().saveError && !useChatStore.getState().historyError })).catch(console.error);
    }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
    return () => { disposed = true; off?.(); };
  }, []);

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

  useEffect(() => { document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language; }, [i18n.language]);

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
    // Zoom actually applied to the page; window.innerWidth * applied gives the window size at 100%.
    let applied = Number(document.documentElement.dataset.uiZoom) || 1;
    let timer: number | undefined;
    const apply = () => {
      const factor = "__TAURI_INTERNALS__" in window ? applied : 1; // CSS zoom in the browser preview leaves innerWidth unscaled
      const next = effectiveUiScale(settings.uiScale, window.innerWidth * factor, window.innerHeight * factor);
      if (Math.abs(next - applied) < 0.001 && document.documentElement.dataset.uiZoom) return;
      applied = next;
      document.documentElement.dataset.uiZoom = String(next);
      if ("__TAURI_INTERNALS__" in window) {
        void getCurrentWebview().setZoom(next).catch(error => console.error("Could not update interface scale", error));
      } else {
        document.documentElement.style.zoom = String(next);
        document.documentElement.style.setProperty("--k-zoom", String(next));
      }
    };
    apply();
    if (settings.uiScale !== AUTO_UI_SCALE) return;
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(apply, 180); };
    window.addEventListener("resize", onResize);
    return () => { window.clearTimeout(timer); window.removeEventListener("resize", onResize); };
  }, [settings.uiScale]);

  useEffect(() => startRunMonitor({
    intervalMs: settings.pollIntervalMs,
    refresh: refreshRuntime,
    onLog: appendLog,
    onState: setServerState,
    onRunLog: event => useControlStore.getState().appendRunLog(event),
    onRunState: event => useControlStore.getState().setManagedRunState(event),
  }), [appendLog, refreshRuntime, setServerState, settings.pollIntervalMs]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void installDesktopLifecycle(
      () => useControlStore.getState().settings,
      () => trayLabelsRef.current,
      () => useControlStore.getState().runtime.state,
      async () => {
        const state = useControlStore.getState();
        const selected = state.selectedRunId;
        if (selected && !["stopped", "crashed"].includes(state.runtime.state)) await state.stopManagedRun(selected);
        else await state.startManagedRun(selected);
      },
      { active: () => useUiPrefs.getState().lightMode, toggle: () => void (useUiPrefs.getState().lightMode ? leaveLightMode() : enterLightMode()) },
    ).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(error => {
      console.error("Could not initialize Aplot Control LLM system tray", error);
      useControlStore.setState({ error: `${trayLabelsRef.current.initError} ${String(error)}` });
    });
    return () => { cancelled = true; dispose?.(); };
  }, []);

  const view = {
    dashboard: <DashboardView />,
    chat: <ChatView />,
    agentWorkspace: <AgentWorkspaceView />,
    knowledge: <KnowledgeView />,
    configuration: <ConfigurationView />,
    models: <LibraryView initialTab="models" />,
    profiles: <LibraryView initialTab="profiles" />,
    performance: <div className="page serverMetrics"><MetricsView /></div>,
    servers: <ServerOverview />,
    logs: <LogsView embedded />,
    apiDocs: <ApiDocsView embedded key={selectedRunId ?? ""} />,
    settings: null,
  }[activeView];
  const models = isModelView(activeView);

  // Hidden and asleep: nothing to lay out or paint, while the stores, tray and panel bridge keep running.
  if (lightMode && isTauri()) return <div className="kDormant" aria-hidden="true"/>;

  return (
    <div className={`kShell${sidebar.rail ? " isUnpinned" : ""}`} aria-busy={!initialized}>
      <AmbientField />
      <a className="skipLink" href="#main-content">{studio.skip}</a>
      <KSidebar pinned={sidebar.pinned} expanded={sidebar.expanded} onTogglePin={sidebar.togglePin} onHoverChange={sidebar.setHovered} onFocusChange={sidebar.setFocused} />
      <div className="workspace kWorkspace">
        <KTopbar />
        <WorkspaceChrome />
        <ErrorBanner />
        <RecoveryBanner />
        <SetupWizard />
        <ToastHost /><AppUpdatePrompt enabled={initialized && settings.setupCompleted}/><DefaultContextMenu />{settingsOpen&&<WorkspaceDialog title={t('nav.settings')} wide onClose={()=>useControlStore.setState({settingsOpen:false})}><div className="settingsModal"><Suspense fallback={<p>{t('aw.loading')}</p>}><SettingsView/></Suspense></div></WorkspaceDialog>}
        <ModelImportDialog />
        <CommandPalette />
        <FileDropLayer />
        <main id="main-content" className={`routeStage${activeView === "dashboard" ? " routeStageHome" : ""}${activeView === "logs" ? " routeStageLogs" : ""}${["chat", "agentWorkspace"].includes(activeView) ? " routeStageChat" : ""}${models ? " routeStageModels" : ""}`} key={models ? "models" : activeView} tabIndex={-1}>
        <Suspense fallback={<div className="routeLoading" aria-hidden="true"><span/></div>}>
          {models ? <ModelsHub><Suspense fallback={<div className="routeLoading" aria-hidden="true"><span/></div>}>{view}</Suspense></ModelsHub> : view}
        </Suspense>
        </main>
        <KStatusBar />
      </div>
    </div>
  );
}
