import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { getAgentContext } from '../../services/agent';
import { contextPercent, readContext } from './ioModel';
import { useAgentStore } from './store';
import { WorkspaceDialog } from './WorkspacePanels';

export function AgentContextMeter({taskId,limit,compact=false}:{taskId:string;limit?:number;compact?:boolean}) {
  const {t,i18n}=useTranslation(),thread=useAgentStore(s=>s.threads[taskId]);
  const [open,setOpen]=useState(false),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
  const id=thread?.id;
  useEffect(()=>{
    if(!id)return;
    let active=true,inflight=false;
    const load=async()=>{
      if(inflight)return;inflight=true;
      try {
        const context=readContext(await getAgentContext(id));
        if(active&&context)useAgentStore.getState().update(taskId,s=>s.id===id?{...s,context}:s);
        if(active)setError(false);
      }catch{if(active)setError(true);}finally{inflight=false;}
    };
    void load();const timer=setInterval(()=>void load(),5000);
    return()=>{active=false;clearInterval(timer);};
  },[id,taskId,refresh,thread?.pending]);
  const context=thread?.context,percent=contextPercent(context),maximum=context?.context_max||limit;
  const format=(n:number)=>new Intl.NumberFormat(i18n.language).format(n);
  const known=!!context&&context.context_max>0;
  const value=known?`${format(context.context_used)} / ${format(context.context_max)} · ${(percent??0).toFixed(1)}%`:maximum?`— / ${format(maximum)}`:'—';
  const accessibleValue=`${t('aw.context.title')}: ${value}${!id&&context?' · '+t('aw.context.saved'):''}`;
  return <><button type="button" className={`awContextMeter${compact?' isCompact':''}`} onClick={()=>setOpen(true)} title={accessibleValue} aria-label={accessibleValue}>{compact?<><svg className={`awContextRing${known?'':' isUnknown'}`} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percent??0} 100`}/></svg><b>{known?`${context.context_estimated?'≈ ':''}${Math.round(percent??0)}%`:'—'}</b></>:<><span>{t('aw.context.title')}</span><span className="awContextTrack"><i style={{width:`${percent??0}%`}}/></span><b>{value}</b>{context?.context_estimated&&<small>≈</small>}{!id&&context&&<small>{t('aw.context.saved')}</small>}</>}</button>
    {open&&<WorkspaceDialog title={t('aw.context.title')} onClose={()=>setOpen(false)}><div className="awContextHeading"><strong>{value}</strong><Button type="button" disabled={!id} onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={14}/>{t('aw.context.refresh')}</Button></div>
      <p className="awMuted">{t(!known?maximum?'aw.context.unknown':'aw.context.notStarted':!id?'aw.context.snapshot':context.context_source==='provider_usage'?'aw.context.provider':context.context_source==='provider_usage_plus_estimate'?'aw.context.anchored':'aw.context.estimate')}</p>
      {error&&<p className="awError">{t('aw.context.failed')}</p>}
      {!!context?.categories.length&&<><h4>{t('aw.context.composition')}</h4><p className="awMuted">{t('aw.context.categoryHint')}</p><div className="awContextCategories">{context.categories.map(row=><div key={row.id}><span>{t(`aw.context.category.${row.id}`,{defaultValue:row.label})}</span><b>≈ {format(row.tokens)}</b><i style={{width:`${context.estimated_total>0?Math.min(100,row.tokens/context.estimated_total*100):0}%`}}/></div>)}</div></>}
      {!!context?.context_files.length&&<><h4>{t('aw.context.files')}</h4>{context.context_files.map((file,index)=><div className="awContextFile" key={`${file.path}-${index}`}><b>{file.label}</b><code>{file.path}</code><span>{t(file.loaded?'aw.context.loaded':'aw.context.notLoaded')} · ≈ {format(file.est_tokens)} {t('aw.context.tokens')}</span></div>)}</>}
      <p className="awMuted">{t('aw.context.note')}</p>
    </WorkspaceDialog>}
  </>;
}
