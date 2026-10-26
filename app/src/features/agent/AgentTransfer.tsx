import { openSettingsSection } from '../../services/settingsWindow';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { CloudProfileSelect } from '../openai/CloudProfileSelect';
import { agentOptions } from './AgentIdentity';
import { cloudSelection,useOpenAi } from '../openai/store';
import { WorkspaceDialog } from './WorkspacePanels';
import { useAgentStore } from './store';
import { createTask,editTask } from './workspace';
import { bindRun,type AgentTask } from './workspaceModel';
import { useControlStore } from '../../store/control';
import { handoffContext } from './handoff';

export function AgentTransfer({task,onClose}:{task:AgentTask;onClose:()=>void}){
  const {t}=useTranslation(),cloud=useOpenAi(),runs=useControlStore(s=>s.runs);
  const [runtime,setRuntime]=useState<'hermes'|'codex'|'claude'>(task.runtime==='codex'?'claude':'codex');
  const [profileId,setProfileId]=useState('');
  const [model,setModel]=useState(''),[runId,setRunId]=useState(runs.find(r=>r.info.state==='ready')?.info.runId??'');
  const [context,setContext]=useState(()=>handoffContext(task.title,useAgentStore.getState().threads[task.id]?.entries??[]));
  const selection=cloudSelection(cloud,runtime==='claude'?'claude':'openai',undefined,profileId),models=selection.models,status=selection.status;
  const selectedModel=models.some(m=>m.model===model)?model:models[0]?.model??'';
  const run=runs.find(r=>r.info.runId===runId);
  const ready=runtime==='hermes'?!!run&&['ready','busy'].includes(run.info.state)&&run.info.contextTokens>=64000:status.connected&&!!selectedModel&&(runtime==='claude'?cloud.claude.installed:cloud.installed);
  return <WorkspaceDialog title={t('connections.transfer')} onClose={onClose}><p>{t('connections.transferHint')}</p>
    <ChoiceSelect label={t('aw.composer.agent')} value={runtime} options={agentOptions()} onChange={v=>{setRuntime(v as typeof runtime);setModel('');setProfileId('');}}/>
    {runtime!=='hermes'&&<CloudProfileSelect provider={runtime==='claude'?'claude':'openai'} profileId={profileId} onChange={id=>{setProfileId(id);setModel('');}}/>}
    {runtime==='hermes'?<ChoiceSelect label={t('aw.modelServer')} value={runId} options={runs.map(r=>({value:r.info.runId,label:r.info.name}))} onChange={setRunId}/>:<ChoiceSelect label={t('openai.model')} value={selectedModel} options={models.map(m=>({value:m.model,label:m.displayName}))} onChange={setModel}/>}
    {runtime!=='hermes'&&!ready&&<Button onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button>}
    <label>{t('connections.transferContext')}<textarea rows={12} maxLength={24000} value={context} onChange={e=>setContext(e.target.value)}/></label>
    <div className="awDialogActions"><Button onClick={onClose}>{t('aw.cancel')}</Button><Button className="primary" disabled={!ready||!context.trim()} onClick={()=>{
      const id=createTask(task.projectId,`${task.title} · ${runtime==='claude'?'Claude':runtime==='codex'?'Codex':'Hermes'}`,runtime==='hermes'&&run?bindRun(run.info,run.config?.profileName):undefined);
      editTask(id,{runtime,cloudModel:runtime==='hermes'?undefined:selectedModel,connectionId:runtime==='hermes'?undefined:status.connectionId,connectionProfileId:runtime==='hermes'?undefined:selection.profile?.id,accessMode:task.accessMode??'manual'});
      useAgentStore.getState().update(id,s=>({...s,draft:context}));onClose();
    }}>{t('connections.transferCreate')}</Button></div>
  </WorkspaceDialog>;
}
