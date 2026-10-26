import { AlertCircle, Bot, ChevronRight, Layers, Search, Server } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { useAgentStore } from '../agent/store';
import { selectTask, taskStatus, useWorkspaceStore } from '../agent/workspace';
import { ENGINE_NAMES } from '../../lib/engineModels';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { useActivityStore } from './store';
import type { ActivityEvent } from './model';

export function ActivityFeed() {
  const {t,i18n}=useTranslation(),events=useActivityStore(s=>s.events),failed=useActivityStore(s=>s.error);
  const control=useControlStore(),ws=useWorkspaceStore(),threads=useAgentStore(s=>s.threads);
  const [search,setSearch]=useState(''),[category,setCategory]=useState('all'),[issues,setIssues]=useState(false);
  const agents=ws.tasks.filter(task=>!task.deletedAt&&threads[task.id]?.id&&!threads[task.id].ended);
  const title=(event:ActivityEvent)=>event.kind==='server.state'?t(`desk.event.server.${event.data.state}`):event.kind==='agent.tool'?t('desk.event.agent.tool',{tool:event.data.tool}):t(`desk.event.${event.kind}`);
  const description=(event:ActivityEvent)=>{
    const d=event.data;
    if(event.kind==='server.state')return [ENGINE_NAMES[d.engine as keyof typeof ENGINE_NAMES]??d.engine,d.profile,typeof d.context==='number'&&d.context>0?`${Math.round(d.context/1024)}K`:null].filter(Boolean).join(' · ');
    if(event.kind==='agent.tool')return [t(`aw.tool.${d.outcome}`),d.path].filter(Boolean).join(' · ');
    if(event.kind==='agent.completed')return t(`desk.outcome.${d.outcome}`);
    if(event.kind==='agent.approval')return t(`desk.approval.${d.choice}`);
    if(event.kind==='agent.access')return t(`aw.io.access.${d.mode}`)+(d.effective===false?` · ${t('desk.nextSession')}`:'');
    if(event.kind==='server.issue')return String(d.message??'');
    return '';
  };
  const filtered=events.filter(e=>(!issues||e.level!=='info')&&(category==='all'||e.kind.startsWith(category))&&`${e.name} ${title(e)} ${description(e)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const openEvent=(event:ActivityEvent)=>{if(event.taskId&&ws.tasks.some(t=>t.id===event.taskId)){selectTask(event.taskId);control.setView('agentWorkspace');}else if(event.runId&&control.runs.some(r=>r.info.runId===event.runId)){control.selectRun(event.runId);control.setView('configuration');}else control.setView('profiles');};
  return <div className="deskActivity">
    <section className="deskProcessPanel"><header><h3>{t('desk.logs.now')}</h3><span>{t('desk.logs.observed')}</span></header><div className="deskProcessRows">
      {control.runs.map((run,index)=><button type="button" key={run.info.runId} onClick={()=>{control.selectRun(run.info.runId);control.setView('configuration');}}><Server size={16}/><span><b>{run.info.name}</b><small>S{index+1} · {ENGINE_NAMES[run.info.engine]}</small></span><span className={`deskProcessState is-${run.info.state}`}><i/>{t(`status.${run.info.state}`)}</span></button>)}
      {agents.map(task=><button type="button" key={task.id} onClick={()=>{selectTask(task.id);control.setView('agentWorkspace');}}><Bot size={16}/><span><b>{task.title}</b><small>Hermes · {ws.projects.find(p=>p.id===task.projectId)?.name}</small></span><span className="deskProcessState"><i/>{t(`aw.status.${taskStatus(threads[task.id])}`)}</span></button>)}
      {!control.runs.length&&!agents.length&&<p className="deskEmpty">{t('desk.logs.noProcesses')}</p>}
    </div></section>
    <section className="deskEventPanel"><div className="deskEventToolbar"><h3>{t('desk.logs.history')}</h3><ChoiceSelect label={t('desk.logs.source')} value={category} onChange={setCategory} options={['all','server','agent','profile'].map(value=>({value,label:t(`desk.logs.category.${value}`)}))}/><button type="button" className={issues?'isOn':''} aria-pressed={issues} onClick={()=>setIssues(v=>!v)}><AlertCircle size={14}/>{t('desk.logs.issues')}</button><label className="search"><Search size={15}/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} aria-label={t('desk.logs.search')} placeholder={t('desk.logs.search')}/></label></div>
      {failed&&<p className="awNotice" role="status">{t('desk.logs.saveError')}</p>}
      <div className="deskEventRows" role="log" aria-live="off">{filtered.map(event=><article key={event.id} className={`deskEvent is-${event.level}`}><div className="deskEventIcon">{event.kind.startsWith('agent')?<Bot size={17}/>:event.kind.startsWith('profile')?<Layers size={17}/>:event.level==='info'?<Server size={17}/>:<AlertCircle size={17}/>}</div><div className="deskEventMain"><div><b>{title(event)}</b><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleString(i18n.language,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></div><span>{event.name}</span>{description(event)&&<p>{description(event)}</p>}<details><summary>{t('desk.logs.details')}</summary><dl>{Object.entries(event.data).map(([key,value])=><div key={key}><dt>{t(`desk.field.${key}`,{defaultValue:key})}</dt><dd>{String(value)}</dd></div>)}</dl></details></div><button type="button" className="kIconBtn" aria-label={t('desk.logs.open')} onClick={()=>openEvent(event)}><ChevronRight size={16}/></button></article>)}{!filtered.length&&<p className="deskEmpty">{t(events.length?'logs.noMatches':'desk.logs.empty')}</p>}</div>
    </section>
  </div>;
}
