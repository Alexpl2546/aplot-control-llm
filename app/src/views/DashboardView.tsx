import { ArrowRight, Bot, FolderOpen, Server, Settings2, AlertCircle, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../store/control';
import { Button } from '../components/ui/Primitives';
import { ENGINE_NAMES } from '../lib/engineModels';
import { useLaunchUi } from '../features/launches/ui';
import { useAgentStore } from '../features/agent/store';
import { selectProject, selectTask, taskStatus, useWorkspaceStore } from '../features/agent/workspace';
import { AgentNetworkHome } from '../features/agent-network/AgentNetworkHome';

export function DashboardView() {
  const {t,i18n}=useTranslation(),control=useControlStore(),ws=useWorkspaceStore(),threads=useAgentStore(s=>s.threads);
  const live=control.runs.filter(r=>['ready','busy'].includes(r.info.state));
  const selected=live.find(r=>r.info.runId===control.selectedRunId)??live[0];
  const recent=ws.tasks.filter(task=>!task.archived&&!task.deletedAt).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,5);
  const agents=ws.tasks.filter(task=>!task.deletedAt&&threads[task.id]?.id&&!threads[task.id].ended);
  const quickServer=()=>useLaunchUi.getState().setQuickAdd(true);
  const workspace=(mode:'chat'|'agent')=>{if(mode==='chat'&&selected)control.selectRun(selected.info.runId);control.setView(mode==='agent'?'agentWorkspace':'chat');};
  const attention=control.runs.filter(r=>r.info.state==='crashed');
  return <div className="deskHome page">
    <header className="deskHomeHeading"><h1>{t('desk.home.title')}</h1></header>
    <AgentNetworkHome />
    <div className="deskHomeColumns">
      <section className="deskHomePanel deskRecent"><header><h2>{t('desk.home.continue')}</h2><button type="button" onClick={()=>workspace('agent')}>{t('desk.home.allTasks')}<ArrowRight size={14}/></button></header>
        {recent.map(task=><button type="button" className="deskRecentTask" key={task.id} onClick={()=>{selectTask(task.id);workspace('agent');}}><Bot size={18}/><span><b>{task.title}</b><small>{ws.projects.find(p=>p.id===task.projectId)?.name} · {new Date(task.updatedAt).toLocaleDateString(i18n.language,{day:'numeric',month:'short'})}</small></span><span className={`awTaskState is-${taskStatus(threads[task.id])}`}><i/>{t(`aw.status.${taskStatus(threads[task.id])}`)}</span><ArrowRight size={15}/></button>)}
        {!recent.length&&<div className="deskHomeEmpty"><FolderOpen size={25}/><b>{t('desk.home.noTasks')}</b><p>{t('desk.home.noTasksHint')}</p><Button onClick={()=>workspace('agent')}>{t('aw.openFolder')}</Button></div>}
      </section>
      <div className="deskHomeAside"><section className="deskHomePanel"><header><h2>{t('desk.home.connection')}</h2><span className="deskCount">{live.length}</span></header>
        {selected?<><div className="deskConnection"><span className={`kLed is-${selected.info.state}`}/><div><b>{selected.info.name}</b><span>{ENGINE_NAMES[selected.info.engine]} · {t(`status.${selected.info.state}`)}</span><code>{selected.info.endpoint}</code></div></div><div className="deskHomeInline"><Button onClick={()=>{control.selectRun(selected.info.runId);control.setView('configuration');}}><Settings2 size={15}/>{t('desk.server.configure')}</Button><Button onClick={()=>{control.selectRun(selected.info.runId);control.setView('apiDocs');}}><Plug size={15}/>{t('desk.home.connectClient')}</Button></div></>:<div className="deskHomeEmpty"><Server size={25}/><b>{t('desk.home.noServer')}</b><p>{t('desk.home.noServerHint')}</p><Button className="primary" onClick={quickServer}><ArrowRight size={15}/>{t('desk.server.new')}</Button></div>}
      </section><section className="deskHomePanel"><header><h2>{t('desk.home.projects')}</h2></header>{ws.projects.slice(-3).reverse().map(project=><button type="button" className="deskProjectLink" key={project.id} onClick={()=>{selectProject(project.id);workspace('agent');}}><FolderOpen size={17}/><span><b>{project.name}</b><small title={project.path}>{project.path}</small></span><ArrowRight size={14}/></button>)}{!ws.projects.length&&<p className="deskEmpty">{t('desk.home.noProjects')}</p>}</section></div>
    </div>
    {(attention.length>0||agents.some(task=>threads[task.id].requests.length>0)||!!ws.saveError)&&<section className="deskHomeAttention"><AlertCircle size={19}/><div><b>{t('desk.home.attention')}</b>{attention.map(run=><button type="button" key={run.info.runId} onClick={()=>{control.selectRun(run.info.runId);control.setView('logs');}}>{run.info.name} · {t('status.crashed')}</button>)}{agents.filter(task=>threads[task.id].requests.length).map(task=><button type="button" key={task.id} onClick={()=>{selectTask(task.id);workspace('agent');}}>{task.title} · {t('aw.status.waiting')}</button>)}{ws.saveError&&<p>{t(`aw.error.${ws.saveError}`)}</p>}</div></section>}
  </div>;
}
