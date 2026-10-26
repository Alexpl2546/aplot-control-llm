import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { useControlStore } from '../../store/control';
import { CloudProfileSelect } from '../openai/CloudProfileSelect';
import { cloudSelection, connectionOptions, useOpenAi } from '../openai/store';
import { openSettingsSection } from '../../services/settingsWindow';
import { agentOptions,AgentIcon } from './AgentIdentity';
import { bindRun,type AgentPreset } from './workspaceModel';
import { deleteAgentPreset,flushWorkspace,initializeWorkspace,saveAgentPreset,useWorkspaceStore } from './workspace';

const usePresetEditor = create<{ requestedId?: string }>(() => ({}));
export function openAgentPresets(){openSettingsSection('agents');}
export function openAgentPreset(id: string){usePresetEditor.setState({requestedId:id});openAgentPresets();}
export function AgentPresetsSettingsContent(){
  const {t}=useTranslation(),ws=useWorkspaceStore(),cloud=useOpenAi(),runs=useControlStore(s=>s.runs);
  const [draft,setDraft]=useState<AgentPreset>(),[remove,setRemove]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const nameInput=useRef<HTMLInputElement>(null);
  const requestedId=usePresetEditor(s=>s.requestedId);
  useEffect(()=>{void initializeWorkspace();},[]);
  useEffect(()=>{
    if(!requestedId||!ws.ready)return;
    const preset=ws.presets.find(p=>p.id===requestedId);
    if(preset){setDraft({...preset});setRemove(false);setError('');setSaved(false);requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select();});}
    usePresetEditor.setState({requestedId:undefined});
  },[requestedId,ws.ready,ws.presets]);
  const patch=(p:Partial<AgentPreset>)=>{setSaved(false);setError('');setDraft(s=>s?{...s,...p}:s);};
  const selection=cloudSelection(cloud,draft?.runtime==='claude'?'claude':'openai',undefined,draft?.connectionProfileId);
  const hasProfiles=connectionOptions(cloud,draft?.runtime==='claude'?'claude':'openai').length>0;
  return <div className="settingsAgents"><p>{t('presets.hint')}</p>{!ws.ready?<p>{t('aw.loading')}</p>:<div className="oaPresetLayout"><aside><Button disabled={saving} onClick={()=>{setDraft({id:crypto.randomUUID(),name:'',runtime:'hermes',accessMode:'manual',instructions:''});setRemove(false);setSaved(false);setError('');}}><Plus size={15}/>{t('presets.add')}</Button>{ws.presets.map(p=><button type="button" disabled={saving} className={draft?.id===p.id?'isSelected':''} key={p.id} onClick={()=>{setDraft({...p});setRemove(false);setSaved(false);setError('');}}><AgentIcon runtime={p.runtime}/><span title={p.name}>{p.name}</span></button>)}</aside><div>
    {!draft?<p>{t('presets.select')}</p>:remove?<><p>{t('presets.deleteConfirm',{name:draft.name})}</p><div className="oaActions"><Button onClick={()=>setRemove(false)}>{t('aw.cancel')}</Button><Button className="awDangerButton" onClick={()=>{deleteAgentPreset(draft.id);setDraft(undefined);setRemove(false);void flushWorkspace();}}>{t('profiles.action.delete')}</Button></div></>:<form onSubmit={async e=>{e.preventDefault();if(saving)return;setError('');setSaved(false);setSaving(true);try{const p={...draft,connectionProfileId:draft.runtime==='hermes'?undefined:selection.profile?.id??draft.connectionProfileId,model:draft.runtime==='hermes'?undefined:draft.model||selection.models[0]?.model};if(p.runtime==='hermes'&&p.binding?.runId.startsWith('profile:')&&!ws.presets.some(saved=>saved.id===p.id&&saved.binding?.runId===p.binding?.runId))await useControlStore.getState().saveServer(p.binding.runId.slice(8));saveAgentPreset(p);await flushWorkspace();if(useWorkspaceStore.getState().saveError)throw new Error(t('presets.saveFailed'));setDraft({...p,name:p.name.trim()});setSaved(true);}catch(e){setError(String(e));}finally{setSaving(false);}}}>
      <div className="oaPresetSave"><Button type="submit" disabled={!draft.name.trim()||draft.name.length>20||saving} className="primary">{t(saving?'presets.saving':'aw.save')}</Button><span role="status">{saved?t('presets.saved'):''}</span></div>
      <fieldset className="oaPresetFields" disabled={saving}>
      <label>{t('presets.name')}<input aria-label={t('presets.name')} ref={nameInput} value={draft.name} maxLength={20} onChange={e=>patch({name:e.target.value})} required aria-describedby="agent-name-limit"/><small id="agent-name-limit" className="oaHelp">{t('presets.nameLimit',{count:draft.name.length})}</small></label>
      <div className="oaPresetField"><span>{t('aw.composer.agent')}</span><ChoiceSelect label={t('aw.composer.agent')} value={draft.runtime} options={agentOptions()} onChange={runtime=>patch({runtime:runtime as AgentPreset['runtime'],connectionProfileId:undefined,model:undefined,binding:undefined})}/><p className="oaHelp">{t('presets.runtimeHelp')}</p></div>
      {draft.runtime==='hermes'?<><div className="oaPresetField"><span>{t('aw.modelServer')}</span><ChoiceSelect disabled={!runs.length} placeholder={t('presets.noServers')} label={t('aw.modelServer')} value={draft.binding?.runId??''} options={runs.map(r=>({value:r.info.runId,label:r.info.name}))} onChange={id=>{const r=runs.find(r=>r.info.runId===id);if(r)patch({binding:bindRun(r.info,r.config?.profileName)});}}/>{!runs.length&&<p className="oaHelp">{t('aw.composer.noServers')}</p>}</div><label className="oaCheck"><input type="checkbox" checked={!!draft.autoStartServer} onChange={e=>patch({autoStartServer:e.target.checked})}/>{t('presets.autoStartServer')}</label></>:<><div className="oaPresetField"><span>{t('profiles.selection')}</span><CloudProfileSelect disabled={!hasProfiles} provider={draft.runtime==='claude'?'claude':'openai'} profileId={draft.connectionProfileId} onChange={id=>patch({connectionProfileId:id,model:undefined})}/>{!hasProfiles&&<p className="oaHelp">{t('presets.noConnections')}</p>}</div><div className="oaPresetField"><span>{t('openai.model')}</span><ChoiceSelect disabled={!selection.models.length} placeholder={t('presets.noModels')} variant="model" label={t('openai.model')} value={draft.model??selection.models[0]?.model??''} options={selection.models.map(m=>({value:m.model,label:m.displayName,description:m.model,keywords:m.defaultReasoningEffort}))} onChange={model=>patch({model})}/>{!selection.models.length&&<p className="oaHelp">{t('presets.modelsHelp')}</p>}</div><Button type="button" onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button></>}
      <div className="oaPresetField"><span>{t('aw.io.access')}</span><ChoiceSelect label={t('aw.io.access')} value={draft.accessMode} options={(['restricted','manual','full'] as const).map(value=>({value,label:t(`aw.io.access.${value}`)}))} onChange={value=>patch({accessMode:value as AgentPreset['accessMode']})}/></div>
      <fieldset className="oaPresetProjects"><legend>{t('presets.projects')}</legend>{ws.projects.length?ws.projects.map(project=><label className="oaCheck" key={project.id}><input type="checkbox" checked={draft.projectIds?.includes(project.id)??false} onChange={event=>{const projectIds=new Set(draft.projectIds??[]);if(event.target.checked)projectIds.add(project.id);else projectIds.delete(project.id);patch({projectIds:[...projectIds]});}}/>{project.name}</label>):<p className="oaHelp">{t('presets.noProjects')}</p>}</fieldset>
      <label>{t('presets.instructions')}<textarea rows={8} maxLength={16000} value={draft.instructions} placeholder={t('presets.instructionsPlaceholder')} onChange={e=>patch({instructions:e.target.value})}/></label>
      <p className="oaHelp">{t('presets.snapshotHint')}</p><div className="oaActions">{ws.presets.some(p=>p.id===draft.id)&&<Button type="button" onClick={()=>setRemove(true)}><Trash2 size={14}/>{t('profiles.action.delete')}</Button>}</div></fieldset>
    </form>}{error&&<p role="alert" className="awError">{error}</p>}</div></div>}</div>;
}
