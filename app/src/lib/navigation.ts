import { useControlStore } from '../store/control';
import type { AppView } from '../types/app';

/** The screens about local models, gathered under one sidebar item «Модели». */
export const MODEL_VIEWS: AppView[] = ['configuration', 'models', 'profiles', 'servers', 'apiDocs', 'logs', 'performance'];
export const isModelView = (view: AppView) => MODEL_VIEWS.includes(view);

/** Tabs of «Модели»; «Серверы» is the card of the selected server with its own tabs. */
export type ModelsTab = 'pick' | 'library' | 'servers';
export const modelsTabOf = (view: AppView): ModelsTab | undefined =>
  view === 'configuration' ? 'pick' : view === 'models' || view === 'profiles' ? 'library' : isModelView(view) ? 'servers' : undefined;
export const SERVER_VIEWS: AppView[] = ['servers', 'apiDocs', 'logs', 'performance'];

/** «Модели» reopens where the user left it; the first visit starts with picking a model. */
let lastModelView: AppView = 'configuration';
let lastServerView: AppView = 'servers';
export const modelsEntry = () => lastModelView;
export const serversEntry = () => lastServerView;
useControlStore.subscribe(state => {
  if (isModelView(state.activeView)) lastModelView = state.activeView;
  if (SERVER_VIEWS.includes(state.activeView)) lastServerView = state.activeView;
});

/** Ctrl+1…5 in sidebar order; «Модели» is resolved when pressed. */
export const SHORTCUT_VIEWS: (AppView | 'modelsHub')[] = ['dashboard', 'agentWorkspace', 'chat', 'knowledge', 'modelsHub'];
export const shortcutTarget = (entry: AppView | 'modelsHub') => entry === 'modelsHub' ? modelsEntry() : entry;
