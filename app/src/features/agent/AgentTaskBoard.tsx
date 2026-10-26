import { useTranslation } from 'react-i18next';
import { WorkspaceDialog } from './WorkspacePanels';
import { selectTask,taskStatus,useWorkspaceStore } from './workspace';
import { useAgentStore } from './store';
export function AgentTaskBoard({onClose}:{onClose:()=>void}){
  const {t}=useTranslation(),ws=useWorkspaceStore(),threads=useAgentStore(s=>s.threads);
  const columns=['ready','running','waiting','completed'] as const;
  return <WorkspaceDialog title={t('connections.board')} wide onClose={onClose}><div className="awBoard">{columns.map(column=><section key={column}><h4>{t(`connections.board.${column}`)}</h4>{ws.tasks.filter(task=>task.projectId===ws.selectedProjectId&&!task.archived&&!task.deletedAt&&boardColumn(taskStatus(threads[task.id]))===column).map(task=><button type="button" key={task.id} onClick={()=>{selectTask(task.id);onClose();}}><b>{task.title}</b><span>{task.runtime==='claude'?'Claude':task.runtime==='codex'?'Codex':'Hermes'} · {t(`aw.status.${taskStatus(threads[task.id])}`)}</span></button>)}</section>)}</div></WorkspaceDialog>;
}
export function boardColumn(status:string){return status==='running'||status==='recording'?'running':status==='waiting'||status==='attention'?'waiting':status==='completed'?'completed':'ready';}
