import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAgentContext } from '../../services/agent';
import { contextPercent, readContext } from './ioModel';
import { useAgentStore } from './store';

export function AgentContextMeter({ taskId, limit }: { taskId: string; limit?: number }) {
  const { t, i18n } = useTranslation();
  const thread = useAgentStore(state => state.threads[taskId]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const titleId = useId();
  const id = thread?.id;
  const { refs, floatingStyles, context: floatingContext } = useFloating<HTMLButtonElement>({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    strategy: 'fixed',
    middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10 })],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(floatingContext);
  const dismiss = useDismiss(floatingContext);
  const role = useRole(floatingContext, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    let inflight = false;
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const context = readContext(await getAgentContext(id));
        if (active && context) useAgentStore.getState().update(taskId, state => state.id === id ? { ...state, context } : state);
        if (active) setError(false);
      } catch {
        if (active) setError(true);
      } finally {
        inflight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [id, taskId, refresh, thread?.pending]);

  const context = thread?.context;
  const percent = contextPercent(context);
  const maximum = context?.context_max || limit;
  const format = new Intl.NumberFormat(i18n.language);
  const percentage = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 });
  const amount = format.format(context?.context_used ?? 0);
  const used = context ? `${context.context_estimated ? '≈ ' : ''}${amount}` : '—';
  const value = maximum ? `${used} / ${format.format(maximum)}` : used;
  const source = !context ? 'aw.context.waiting' : !id ? 'aw.context.snapshot'
    : context.context_source === 'provider_usage' ? 'aw.context.provider'
      : context.context_source === 'provider_usage_plus_estimate' ? 'aw.context.anchored' : 'aw.context.estimate';
  const categories = context?.categories.filter(row => row.tokens > 0) ?? [];

  return <>
    <button {...getReferenceProps()} ref={refs.setReference} type="button" className="awContextMeter isCompact"
      title={t('aw.context.title')} aria-label={`${t('aw.context.title')}: ${value}`}>
      <svg className={`awContextRing${percent === undefined ? ' isUnknown' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/>
        <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percent ?? 0} 100`}/>
      </svg>
      <b>{percent === undefined ? '—' : `${context?.context_estimated ? '≈ ' : ''}${percentage.format(percent / 100)}`}</b>
    </button>
    {open && <FloatingPortal><FloatingFocusManager context={floatingContext} modal={false} initialFocus={-1}>
      <section {...getFloatingProps()} ref={refs.setFloating} className="awContextPopover" style={floatingStyles} aria-labelledby={titleId}>
        <header>
          <h3 id={titleId}>{t('aw.context.title')}</h3>
          {id && <button type="button" className="kIconBtn" title={t('aw.context.refresh')} aria-label={t('aw.context.refresh')} onClick={() => setRefresh(current => current + 1)}>
            <RefreshCw size={14}/>
          </button>}
        </header>
        <div className="awContextValue"><strong>{value}</strong><span>{t('aw.context.tokens')}</span></div>
        <p className="awContextSource">{t(source)}</p>
        {id && error && <p className="awError" role="status">{t('aw.context.failed')}</p>}
        {categories.length > 0 ? <section className="awContextBreakdown">
          <h4>{t('aw.context.composition')}</h4>
          <dl className="awContextCategories">{categories.map(row => <div key={row.id} data-category={row.id}>
            <dt>{t(`aw.context.category.${row.id}`, { defaultValue: row.label })}</dt>
            <dd>≈ {format.format(row.tokens)}</dd>
          </div>)}</dl>
          <div className="awContextCompositionBar" aria-hidden="true">{categories.map(row =>
            <span key={row.id} data-category={row.id} style={{ flexGrow: row.tokens }}/>)}</div>
          <p className="awContextSource">{t('aw.context.categoryHint')}</p>
        </section> : context && <p className="awContextSource awContextBreakdown">{t('aw.context.breakdownUnavailable')}</p>}
        {!!context?.context_files.length && <details className="awContextBreakdown">
          <summary>{t('aw.context.files')} <span>· {format.format(context.context_files.length)}</span></summary>
          {context.context_files.map((file, index) => <div className="awContextFile" key={`${file.path}-${index}`}>
            <b>{file.label}</b><code>{file.path}</code>
            <span>{t(file.loaded ? 'aw.context.loaded' : 'aw.context.notLoaded')} · ≈ {format.format(file.est_tokens)} {t('aw.context.tokens')}</span>
          </div>)}
        </details>}
      </section>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}
