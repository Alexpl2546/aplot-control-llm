import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FilePlus2, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { useControlStore } from '../../store/control';
import type { RunInfo } from '../../types/runtime';
import { CloudProfileSelect } from '../openai/CloudProfileSelect';
import { cloudSelection, connectionOptions, useOpenAi } from '../openai/store';
import { openSettingsSection } from '../../services/settingsWindow';
import { agentOptions,AgentIcon } from './AgentIdentity';
import { bindRun,type AgentPreset } from './workspaceModel';
import { deleteAgentPreset,flushWorkspace,initializeWorkspace,saveAgentPreset,useWorkspaceStore } from './workspace';
import { BUILTIN_AGENTS, presetFromTemplate } from './builtin/builtinAgents';
import './agentPresets.css';

const usePresetEditor = create<{ requestedId?: string }>(() => ({}));
export function openAgentPresets(){openSettingsSection('agents');}
export function openAgentPreset(id: string){usePresetEditor.setState({requestedId:id});openAgentPresets();}

const shortModel=(value:string)=>value.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.gguf$/i,'')??value;

/** What an agent currently runs on: runtime icon + model name (+ whether its server is up). */
export function presetModel(preset:AgentPreset|undefined,runs:readonly {info:RunInfo}[],t:TFunction){
  if(!preset)return {runtime:undefined,label:'',live:false,missing:true};
  if(preset.runtime==='hermes'){
    const run=preset.binding?runs.find(r=>r.info.runId===preset.binding!.runId):undefined;
    const model=run?.info.modelId||preset.binding?.modelId||preset.binding?.name||'';
    return {runtime:'hermes',label:model?shortModel(model):t('presets.modelUnset'),live:!!run&&['ready','busy'].includes(run.info.state),missing:!model};
  }
  return {runtime:preset.runtime,label:preset.model||t('presets.modelUnset'),live:!!preset.model,missing:!preset.model};
}

/** Compact "runtime icon · model" line used in lists, cards and the drawer. */
export function PresetModelBadge({preset}:{preset?:AgentPreset}){
  const {t}=useTranslation(),runs=useControlStore(s=>s.runs);
  const model=presetModel(preset,runs,t);
  if(!preset)return null;
  return <span className={`presetModel${model.missing?' isMissing':''}${model.live?' isLive':''}`} title={model.label}><AgentIcon runtime={model.runtime} size={13}/><span>{model.label}</span></span>;
}

/** Ready-made agents to start from; "blank" is always first. */
export function TemplatePicker({onPick}:{onPick:(preset:AgentPreset)=>void}){
  const {t}=useTranslation();
  return <div className="templatePicker">
    <p className="oaHelp">{t('presets.templateHint')}</p>
    <div className="templateGrid">
      <button type="button" className="templateCard isBlank" onClick={()=>onPick({id:crypto.randomUUID(),name:'',runtime:'hermes',accessMode:'manual',instructions:''})}>
        <i aria-hidden="true"><FilePlus2 size={16}/></i><b>{t('presets.blank')}</b><small>{t('presets.blankHint')}</small></button>
      {BUILTIN_AGENTS.map(agent=><button type="button" key={agent.id} className="templateCard" style={{['--c' as string]:agent.color}} onClick={()=>onPick(presetFromTemplate(agent,t))}>
        <i aria-hidden="true" className="templateDot"/><b>{t(`builtin.${agent.id}.name`)}</b><small>{t(`builtin.${agent.id}.role`)}</small></button>)}
    </div>
  </div>;
}

/** Markdown instructions with an edit / preview switch. */
function InstructionsEditor({value,onChange,rows}:{value:string;onChange:(value:string)=>void;rows:number}){
  const {t}=useTranslation();
  const [preview,setPreview]=useState(false);
  return <div className="mdEditor">
    <div className="mdEditorBar"><span>{t('presets.instructions')} <code>AGENT.md</code></span>
      <div role="tablist" aria-label={t('presets.instructions')}>
        <button type="button" role="tab" aria-selected={!preview} onClick={()=>setPreview(false)}>{t('presets.edit')}</button>
        <button type="button" role="tab" aria-selected={preview} onClick={()=>setPreview(true)}>{t('presets.preview')}</button>
      </div></div>
    {preview?<div className="mdPreview ohMarkdown">{value.trim()?<ReactMarkdown>{value}</ReactMarkdown>:<p className="oaHelp">{t('presets.instructionsPlaceholder')}</p>}</div>
      :<textarea aria-label={t('presets.instructions')} rows={rows} maxLength={16000} value={value} spellCheck={false} placeholder={t('presets.instructionsPlaceholder')} onChange={e=>onChange(e.target.value)}/>}
    <small className="oaHelp mdCount">{value.length.toLocaleString()} / 16 000</small>
  </div>;
}

/**
 * The single agent editor: used in Settings → Agents and inline in the Orbit side panel.
 * `compact` stacks everything in one narrow column.
 */
export function AgentPresetForm({initial,compact=false,onSaved,onDeleted,onCancel,autoFocus=false}:{initial:AgentPreset;compact?:boolean;onSaved?:(preset:AgentPreset)=>void;onDeleted?:()=>void;onCancel?:()=>void;autoFocus?:boolean}){
  const {t}=useTranslation(),ws=useWorkspaceStore(),cloud=useOpenAi(),runs=useControlStore(s=>s.runs);
  const [draft,setDraft]=useState<AgentPreset>(initial),[remove,setRemove]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const nameInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(autoFocus)requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select();});},[autoFocus]);
  const exists=ws.presets.some(p=>p.id===draft.id);
  const patch=(p:Partial<AgentPreset>)=>{setSaved(false);setError('');setDraft(s=>({...s,...p}));};
  const selection=cloudSelection(cloud,draft.runtime==='claude'?'claude':'openai',undefined,draft.connectionProfileId);
  const hasProfiles=connectionOptions(cloud,draft.runtime==='claude'?'claude':'openai').length>0;
  if(remove)return <div className="presetDelete"><p>{t('presets.deleteConfirm',{name:draft.name})}</p><p className="oaHelp">{t('presets.deleteTemplateHint')}</p><div className="oaActions"><Button onClick={()=>setRemove(false)}>{t('aw.cancel')}</Button><Button className="awDangerButton" onClick={()=>{deleteAgentPreset(draft.id);setRemove(false);void flushWorkspace();onDeleted?.();}}><Trash2 size={14}/>{t('profiles.action.delete')}</Button></div></div>;
  return <form className={`presetForm${compact?' isCompact':''}`} onSubmit={async e=>{e.preventDefault();if(saving)return;setError('');setSaved(false);setSaving(true);try{const p={...draft,connectionProfileId:draft.runtime==='hermes'?undefined:selection.profile?.id??draft.connectionProfileId,model:draft.runtime==='hermes'?undefined:draft.model||selection.models[0]?.model};if(p.runtime==='hermes'&&p.binding?.runId.startsWith('profile:')&&!ws.presets.some(saved=>saved.id===p.id&&saved.binding?.runId===p.binding?.runId))await useControlStore.getState().saveServer(p.binding.runId.slice(8));saveAgentPreset(p);await flushWorkspace();if(useWorkspaceStore.getState().saveError)throw new Error(t('presets.saveFailed'));const next={...p,name:p.name.trim()};setDraft(next);setSaved(true);onSaved?.(next);}catch(e){setError(String(e));}finally{setSaving(false);}}}>
    <div className="oaPresetSave"><Button type="submit" disabled={!draft.name.trim()||draft.name.length>20||saving} className="primary">{t(saving?'presets.saving':exists?'aw.save':'presets.create')}</Button>{onCancel&&<Button type="button" onClick={onCancel}>{t('aw.cancel')}</Button>}<span role="status">{saved?t('presets.saved'):''}</span></div>
    <fieldset className="oaPresetFields" disabled={saving}>
    <label>{t('presets.name')}<input aria-label={t('presets.name')} ref={nameInput} value={draft.name} maxLength={20} onChange={e=>patch({name:e.target.value})} required/><small className="oaHelp">{t('presets.nameLimit',{count:draft.name.length})}</small></label>
    <div className={compact?'presetPair':'presetPair isWide'}>
      <div className="oaPresetField"><span>{t('aw.composer.agent')}</span><ChoiceSelect label={t('aw.composer.agent')} value={draft.runtime} options={agentOptions()} onChange={runtime=>patch({runtime:runtime as AgentPreset['runtime'],connectionProfileId:undefined,model:undefined,binding:undefined})}/>{!compact&&<p className="oaHelp">{t('presets.runtimeHelp')}</p>}</div>
      <div className="oaPresetField"><span>{t('aw.io.access')}</span><ChoiceSelect label={t('aw.io.access')} value={draft.accessMode} options={(['restricted','manual','full'] as const).map(value=>({value,label:t(`aw.io.access.${value}`)}))} onChange={value=>patch({accessMode:value as AgentPreset['accessMode']})}/></div>
    </div>
    {draft.runtime==='hermes'?<><div className="oaPresetField"><span>{t('aw.modelServer')}</span><ChoiceSelect disabled={!runs.length} placeholder={t('presets.noServers')} label={t('aw.modelServer')} value={draft.binding?.runId??''} options={runs.map(r=>({value:r.info.runId,label:r.info.name,description:shortModel(r.info.modelId||'')}))} onChange={id=>{const r=runs.find(r=>r.info.runId===id);if(r)patch({binding:bindRun(r.info,r.config?.profileName)});}}/>{!runs.length&&<p className="oaHelp">{t('aw.composer.noServers')}</p>}</div><label className="oaCheck"><input type="checkbox" checked={!!draft.autoStartServer} onChange={e=>patch({autoStartServer:e.target.checked})}/>{t('presets.autoStartServer')}</label></>:<><div className="oaPresetField"><span>{t('profiles.selection')}</span><CloudProfileSelect disabled={!hasProfiles} provider={draft.runtime==='claude'?'claude':'openai'} profileId={draft.connectionProfileId} onChange={id=>patch({connectionProfileId:id,model:undefined})}/>{!hasProfiles&&<p className="oaHelp">{t('presets.noConnections')}</p>}</div><div className="oaPresetField"><span>{t('openai.model')}</span><ChoiceSelect disabled={!selection.models.length} placeholder={t('presets.noModels')} variant="model" label={t('openai.model')} value={draft.model??selection.models[0]?.model??''} options={selection.models.map(m=>({value:m.model,label:m.displayName,description:m.model,keywords:m.defaultReasoningEffort}))} onChange={model=>patch({model})}/>{!selection.models.length&&<p className="oaHelp">{t('presets.modelsHelp')}</p>}</div>{!hasProfiles&&<Button type="button" onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button>}</>}
    <fieldset className="oaPresetProjects"><legend>{t('presets.projects')}</legend>{ws.projects.length?ws.projects.map(project=><label className="oaCheck" key={project.id}><input type="checkbox" checked={draft.projectIds?.includes(project.id)??false} onChange={event=>{const projectIds=new Set(draft.projectIds??[]);if(event.target.checked)projectIds.add(project.id);else projectIds.delete(project.id);patch({projectIds:[...projectIds]});}}/>{project.name}</label>):<p className="oaHelp">{t('presets.noProjects')}</p>}</fieldset>
    <InstructionsEditor value={draft.instructions} rows={compact?12:10} onChange={instructions=>patch({instructions})}/>
    {!compact&&<p className="oaHelp">{t('presets.snapshotHint')}</p>}
    {exists&&<div className="oaActions"><Button type="button" onClick={()=>setRemove(true)}><Trash2 size={14}/>{t('profiles.action.delete')}</Button></div>}
    </fieldset>
    {error&&<p role="alert" className="awError">{error}</p>}
  </form>;
}

export function AgentPresetsSettingsContent(){
  const {t}=useTranslation(),ws=useWorkspaceStore();
  const [draft,setDraft]=useState<AgentPreset>(),[picking,setPicking]=useState(false);
  const requestedId=usePresetEditor(s=>s.requestedId);
  useEffect(()=>{void initializeWorkspace();},[]);
  useEffect(()=>{
    if(requestedId===undefined||!ws.ready)return;
    const preset=ws.presets.find(p=>p.id===requestedId);
    if(preset){setDraft({...preset});setPicking(false);}else if(requestedId===''){setDraft(undefined);setPicking(true);}
    usePresetEditor.setState({requestedId:undefined});
  },[requestedId,ws.ready,ws.presets]);
  return <div className="settingsAgents"><p>{t('presets.hint')}</p>{!ws.ready?<p>{t('aw.loading')}</p>:<div className="oaPresetLayout"><aside><Button className={picking?'primary':''} onClick={()=>{setDraft(undefined);setPicking(true);}}><Plus size={15}/>{t('presets.add')}</Button>{ws.presets.map(p=><button type="button" className={draft?.id===p.id?'isSelected':''} key={p.id} style={p.color?{['--c' as string]:p.color}:undefined} onClick={()=>{setDraft({...p});setPicking(false);}}><i className="presetDot" aria-hidden="true"/><span className="presetRowText"><span title={p.name}>{p.name}</span><PresetModelBadge preset={p}/></span></button>)}{!ws.presets.length&&<p className="oaHelp">{t('presets.empty')}</p>}</aside><div>
    {picking?<TemplatePicker onPick={preset=>{setPicking(false);setDraft(preset);}}/>
      :!draft?<p>{t('presets.select')}</p>
      :<AgentPresetForm key={draft.id} initial={draft} autoFocus onSaved={setDraft} onDeleted={()=>setDraft(undefined)}/>}
  </div></div>}</div>;
}
