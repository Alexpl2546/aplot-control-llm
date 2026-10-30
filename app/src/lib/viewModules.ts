import type { AppView } from '../types/app';

/** Hover, idle preloading and React.lazy share the same request, including retries. */
export function cachedModule<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= load().catch(error => { pending = undefined; throw error; });
}

export const viewModules = {
  dashboard: cachedModule(() => import('../views/DashboardView').then(module => ({ default: module.DashboardView }))),
  chat: cachedModule(() => import('../views/ChatView').then(module => ({ default: module.ChatView }))),
  agentWorkspace: cachedModule(() => import('../features/agent/AgentChat').then(module => ({ default: module.AgentChat }))),
  knowledge: cachedModule(() => import('../features/knowledge/KnowledgeView').then(module => ({ default: module.KnowledgeView }))),
  configuration: cachedModule(() => import('../views/ConfigurationView').then(module => ({ default: module.ConfigurationView }))),
  models: cachedModule(() => import('../views/LibraryView').then(module => ({ default: module.LibraryView }))),
  performance: cachedModule(() => import('../features/performance/MonitoringView').then(module => ({ default: module.MonitoringView }))),
  logs: cachedModule(() => import('../views/LogsView').then(module => ({ default: module.LogsView }))),
  apiDocs: cachedModule(() => import('../views/ApiDocsView').then(module => ({ default: module.ApiDocsView }))),
  settings: cachedModule(() => import('../views/SettingsView').then(module => ({ default: module.SettingsView }))),
};

export function prefetchView(view: AppView): void {
  void viewModules[view === 'profiles' ? 'models' : view === 'servers' ? 'logs' : view]().catch(() => { /* Navigation can retry a failed preload. */ });
}

/** Warm one route at a time between input/paint work, after initialization. */
export function warmViewModules(): () => void {
  const remaining = Object.keys(viewModules) as (keyof typeof viewModules)[];
  let cancelled = false;
  let idle = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    if (cancelled) return;
    const view = remaining.shift();
    if (!view) return;
    void viewModules[view]().catch(() => {}).finally(schedule);
  };
  const schedule = () => {
    if (cancelled || !remaining.length) return;
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(step, { timeout: 1500 });
    else timer = setTimeout(step, 150);
  };
  schedule();
  return () => { cancelled = true; clearTimeout(timer); if (idle) window.cancelIdleCallback?.(idle); };
}
