import { Activity, Boxes, LayoutDashboard, Plug, ScrollText, Server, SlidersHorizontal } from 'lucide-react';
import type { ComponentType, KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useGlider } from '../../components/ui/useGlider';
import { modelsTabOf, serversEntry, type ModelsTab } from '../../lib/navigation';
import { useControlStore } from '../../store/control';
import type { AppView } from '../../types/app';
import { ServerCard } from './ServerCard';
import './modelsHub.css';

type Tab = { view: AppView; icon: ComponentType<{ size?: number }>; label: string; keywords: string };
/** Every screen inside «Модели»; `keywords` is the old sidebar name, so Ctrl+K still finds it. */
export const MODELS_TABS: Tab[] = [
  { view: 'configuration', icon: SlidersHorizontal, label: 'modelsHub.pick', keywords: 'nav.configuration' },
  { view: 'models', icon: Boxes, label: 'modelsHub.library', keywords: 'nav.library' },
  { view: 'servers', icon: LayoutDashboard, label: 'modelsHub.servers', keywords: 'k.servers' },
  { view: 'apiDocs', icon: Plug, label: 'modelsHub.connect', keywords: 'k.nav.api' },
  { view: 'logs', icon: ScrollText, label: 'modelsHub.logs', keywords: 'nav.logs' },
  { view: 'performance', icon: Activity, label: 'modelsHub.metrics', keywords: 'nav.benchmarks' },
];
const TOP: { tab: ModelsTab; icon: ComponentType<{ size?: number }>; label: string; view: () => AppView }[] = [
  { tab: 'pick', icon: SlidersHorizontal, label: 'modelsHub.pick', view: () => 'configuration' },
  { tab: 'library', icon: Boxes, label: 'modelsHub.library', view: () => 'models' },
  { tab: 'servers', icon: Server, label: 'modelsHub.servers', view: serversEntry },
];

/** Left/Right/Home/End move between tabs, as in other tab rows of the app. */
function arrows(event: KeyboardEvent<HTMLElement>, count: number, index: number, go: (next: number) => void) {
  const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  const wrapped = (next + count) % count;
  go(wrapped);
  (event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[wrapped])?.focus();
}

/** «Модели»: one sidebar item with tabs over the screens that used to be five items. */
export function ModelsHub({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const view = useControlStore(state => state.activeView);
  const setView = useControlStore(state => state.setView);
  const tab = modelsTabOf(view) ?? 'pick';
  const topIndex = TOP.findIndex(item => item.tab === tab);
  const top = useGlider<HTMLDivElement>(topIndex);
  return <>
    <header className="modelsHub">
      <div ref={top} className="modelsHubTabs kGlideHost" role="tablist" aria-label={t('nav.models')}>
        <span className="kGlide" aria-hidden="true"/>
        {TOP.map(({ tab: id, icon: Icon, label, view: target }, index) => <button key={id} type="button" role="tab" data-glide aria-selected={index === topIndex} tabIndex={index === topIndex ? 0 : -1}
          onClick={() => setView(target())} onKeyDown={event => arrows(event, TOP.length, index, next => setView(TOP[next].view()))}><Icon size={15}/>{t(label)}</button>)}
      </div>
    </header>
    {tab === 'servers' ? <ServerCard>{children}</ServerCard> : children}
  </>;
}
