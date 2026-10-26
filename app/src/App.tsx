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
const LibraryView = lazy(viewModules.models);
const PerformanceView = lazy(viewModules.performance);
const LogsView = lazy(viewModules.logs);
const ApiDocsView = lazy(viewModules.apiDocs);
const SettingsView = lazy(viewModules.settings);

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
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWebview().setZoom(settings.uiScale).catch(error => console.error("Could not update interface scale", error));
    } else {
      document.documentElement.style.zoom = String(settings.uiScale);
      document.documentElement.style.setProperty("--k-zoom", String(settings.uiScale));
    }
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
    configuration: <ConfigurationView />,
    models: <LibraryView initialTab="models" />,
    profiles: <LibraryView initialTab="profiles" />,
    performance: <PerformanceView />,
    logs: <LogsView />,
    apiDocs: <ApiDocsView />,
    settings: null,
  }[activeView];

  return (
    <div className={`kShell${sidebar.rail ? " isUnpinned" : ""}`} aria-busy={!initialized}>
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
        <main id="main-content" className={`routeStage${activeView === "logs" ? " routeStageLogs" : ""}${["chat", "agentWorkspace"].includes(activeView) ? " routeStageChat" : ""}`} key={activeView} tabIndex={-1}>
        <Suspense fallback={<div className="routeLoading" aria-hidden="true"><span/></div>}>
          {view}
        </Suspense>
        </main>
        <KStatusBar />
      </div>
    </div>
  );
}
