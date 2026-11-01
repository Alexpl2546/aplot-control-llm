import { useTranslation } from 'react-i18next';
import { selectTask, taskStatus, useWorkspaceStore } from './workspace';
import { useAgentStore } from './store';
import './appTools.css';

/** App delegations remain navigable after the native tool call has finished. */
export function DelegatedTasks({taskId}:{taskId:string}){
  const {t}=useTranslation();
  const tasks=useWorkspaceStore(state=>state.tasks);
  const threads=useAgentStore(state=>state.threads);
  const current=tasks.find(task=>task.id===taskId);
  const parent=tasks.find(task=>task.id===current?.parentTaskId&&!task.deletedAt);
  const children=tasks.filter(task=>task.parentTaskId===taskId&&!task.deletedAt);
  if(!parent&&!children.length)return null;
  return <nav className="agentDelegations" aria-label={t('orchestrator.delegations')}>
    {parent&&<button type="button" className="uiButton" onClick={()=>selectTask(parent.id)}>{t('orchestrator.parentTask')}: {parent.agentName||parent.title}</button>}
    {children.map(task=><button type="button" className="uiButton" key={task.id} onClick={()=>selectTask(task.id)}>
      <span>{task.agentName||task.title}</span><span>{t(`aw.status.${taskStatus(threads[task.id])}`)}</span>
    </button>)}
  </nav>;
}
