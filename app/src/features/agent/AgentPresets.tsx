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
import { ReasoningSelect, reasoningFor, reasoningLevels } from '../reasoning/reasoning';
import { taskReasoningKey, useReasoningProfile } from '../reasoning/profiles';
import { openSettingsSection } from '../../services/settingsWindow';
import { agentOptions,AgentIcon } from './AgentIdentity';
import { bindRun,type AgentPreset } from './workspaceModel';
import { deleteAgentPreset,flushWorkspace,initializeWorkspace,saveAgentPreset,useWorkspaceStore } from './workspace';
import { BUILTIN_AGENTS, presetFromTemplate } from './builtin/builtinAgents';
import { AgentAvatar } from './AgentAvatar';
import { AGENT_AVATARS, bundledAvatar, presetAvatar } from './agentAvatars';
export { AgentAvatar } from './AgentAvatar';
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
        <AgentAvatar avatar={presetAvatar({templateId: agent.id})} color={agent.color} size={40} animationEnabled={false}/><b>{t(`builtin.${agent.id}.name`)}</b><small>{t(`builtin.${agent.id}.role`)}</small></button>)}
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
  const [avatarBusy, setAvatarBusy] = useState(false);
  useEffect(()=>{if(autoFocus)requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select();});},[autoFocus]);
  const exists=ws.presets.some(p=>p.id===draft.id);
  const patch=(p:Partial<AgentPreset>)=>{setSaved(false);setError('');setDraft(s=>({...s,...p}));};
  const selection=cloudSelection(cloud,draft.runtime==='claude'?'claude':'openai',undefined,draft.connectionProfileId);
  const hasProfiles=connectionOptions(cloud,draft.runtime==='claude'?'claude':'openai').length>0;
  const reasoningProvider=draft.runtime==='codex'?'chatgpt':draft.runtime==='claude'?'claude':'local';
  const reasoningProfile=useReasoningProfile(taskReasoningKey({runtime:draft.runtime,connectionId:selection.status.connectionId,cloudModel:draft.model||selection.models[0]?.model,binding:draft.binding},runId=>runs.find(run=>run.info.runId===runId)?.config?.modelPath));
  if(remove)return <div className="presetDelete"><p>{t('presets.deleteConfirm',{name:draft.name})}</p><p className="oaHelp">{t('presets.deleteTemplateHint')}</p><div className="oaActions"><Button onClick={()=>setRemove(false)}>{t('aw.cancel')}</Button><Button className="awDangerButton" onClick={()=>{deleteAgentPreset(draft.id);setRemove(false);void flushWorkspace();onDeleted?.();}}><Trash2 size={14}/>{t('profiles.action.delete')}</Button></div></div>;
  return <form className={`presetForm${compact?' isCompact':''}`} onSubmit={async e=>{e.preventDefault();if(saving||avatarBusy)return;setError('');setSaved(false);setSaving(true);try{const p={...draft,reasoning:reasoningFor(reasoningProvider,draft.reasoning,reasoningProfile),connectionProfileId:draft.runtime==='hermes'?undefined:selection.profile?.id??draft.connectionProfileId,model:draft.runtime==='hermes'?undefined:draft.model||selection.models[0]?.model};if(p.runtime==='hermes'&&p.binding?.runId.startsWith('profile:')&&!ws.presets.some(saved=>saved.id===p.id&&saved.binding?.runId===p.binding?.runId))await useControlStore.getState().saveServer(p.binding.runId.slice(8));saveAgentPreset(p);await flushWorkspace();if(useWorkspaceStore.getState().saveError)throw new Error(t('presets.saveFailed'));const next={...p,name:p.name.trim()};setDraft(next);setSaved(true);onSaved?.(next);}catch(e){setError(String(e));}finally{setSaving(false);}}}>
    <div className="oaPresetSave"><Button type="submit" disabled={!draft.name.trim()||draft.name.length>20||saving||avatarBusy} className="primary">{t(saving?'presets.saving':exists?'aw.save':'presets.create')}</Button>{onCancel&&<Button type="button" onClick={onCancel}>{t('aw.cancel')}</Button>}<span role="status">{saved?t('presets.saved'):''}</span></div>
    <fieldset className="oaPresetFields" disabled={saving}>
    <section className="presetProfileSection" aria-label={t('presets.identity')}><h3>{t('presets.identity')}</h3>
    <div className="presetIdentity"><AgentAvatarPicker value={presetAvatar(draft)} color={draft.color} animated={draft.avatarAnimated !== false} onChange={avatar=>patch({avatar: avatar ?? ''})} onAnimatedChange={avatarAnimated=>patch({avatarAnimated})} onBusyChange={setAvatarBusy}/>
    <label>{t('presets.title')}<input aria-label={t('presets.title')} value={draft.title??''} maxLength={40} placeholder={t('presets.titlePlaceholder')} onChange={e=>patch({title:e.target.value||undefined})}/></label></div>
    <label>{t('presets.name')}<input aria-label={t('presets.name')} ref={nameInput} value={draft.name} maxLength={20} onChange={e=>patch({name:e.target.value})} required/><small className="oaHelp">{t('presets.nameLimit',{count:draft.name.length})}</small></label>
    <label>{t('presets.description')}<textarea aria-label={t('presets.description')} value={draft.description ?? ''} maxLength={240} rows={3} onChange={event => patch({description: event.target.value})}/><small className="oaHelp">{t('presets.descriptionHint')}</small></label>
    <label>{t('presets.color')}<span className="presetColorControl"><input type="color" aria-label={t('presets.color')} value={/^#[0-9a-f]{6}$/i.test(draft.color ?? '') ? draft.color : '#c8f27c'} onChange={event => patch({color: event.target.value})}/><code>{draft.color ?? '#c8f27c'}</code></span></label>
    </section>
    <section className="presetProfileSection" aria-label={t('presets.execution')}><h3>{t('presets.execution')}</h3>
    <div className={compact?'presetPair':'presetPair isWide'}>
      <div className="oaPresetField"><span>{t('aw.composer.agent')}</span><ChoiceSelect label={t('aw.composer.agent')} value={draft.runtime} options={agentOptions()} onChange={runtime=>patch({runtime:runtime as AgentPreset['runtime'],connectionProfileId:undefined,model:undefined,binding:undefined,reasoning:undefined})}/>{!compact&&<p className="oaHelp">{t('presets.runtimeHelp')}</p>}</div>
      <div className="oaPresetField"><span>{t('aw.io.access')}</span><ChoiceSelect label={t('aw.io.access')} value={draft.accessMode} options={(['restricted','manual','full'] as const).map(value=>({value,label:t(`aw.io.access.${value}`)}))} onChange={value=>patch({accessMode:value as AgentPreset['accessMode']})}/></div>
    </div>
    {draft.runtime==='hermes'?<><div className="oaPresetField"><span>{t('aw.modelServer')}</span><ChoiceSelect disabled={!runs.length} placeholder={t('presets.noServers')} label={t('aw.modelServer')} value={draft.binding?.runId??''} options={runs.map(r=>({value:r.info.runId,label:r.info.name,description:shortModel(r.info.modelId||'')}))} onChange={id=>{const r=runs.find(r=>r.info.runId===id);if(r)patch({binding:bindRun(r.info,r.config?.profileName)});}}/>{!runs.length&&<p className="oaHelp">{t('aw.composer.noServers')}</p>}</div><label className="oaCheck"><input type="checkbox" checked={!!draft.autoStartServer} onChange={e=>patch({autoStartServer:e.target.checked})}/>{t('presets.autoStartServer')}</label></>:<><div className="oaPresetField"><span>{t('profiles.selection')}</span><CloudProfileSelect disabled={!hasProfiles} provider={draft.runtime==='claude'?'claude':'openai'} profileId={draft.connectionProfileId} onChange={id=>patch({connectionProfileId:id,model:undefined})}/>{!hasProfiles&&<p className="oaHelp">{t('presets.noConnections')}</p>}</div><div className="oaPresetField"><span>{t('openai.model')}</span><ChoiceSelect disabled={!selection.models.length} placeholder={t('presets.noModels')} variant="model" label={t('openai.model')} value={draft.model??selection.models[0]?.model??''} options={selection.models.map(m=>({value:m.model,label:m.displayName,description:m.model,keywords:m.defaultReasoningEffort}))} onChange={model=>patch({model})}/>{!selection.models.length&&<p className="oaHelp">{t('presets.modelsHelp')}</p>}</div>{!hasProfiles&&<Button type="button" onClick={()=>openSettingsSection('connections')}>{t('openai.connections')}</Button>}</>}
    {reasoningLevels(reasoningProvider,reasoningProfile).length>0&&<div className="oaPresetField"><span>{t('presets.reasoningDefault')}</span><ReasoningSelect provider={reasoningProvider} profile={reasoningProfile} value={draft.reasoning} onChange={reasoning=>patch({reasoning})}/></div>}
    </section>
    <section className="presetProfileSection" aria-label={t('presets.projects')}>
    <fieldset className="oaPresetProjects"><legend>{t('presets.projects')}</legend>{ws.projects.length?ws.projects.map(project=><label className="oaCheck" key={project.id}><input type="checkbox" checked={draft.projectIds?.includes(project.id)??false} onChange={event=>{const projectIds=new Set(draft.projectIds??[]);if(event.target.checked)projectIds.add(project.id);else projectIds.delete(project.id);patch({projectIds:[...projectIds]});}}/>{project.name}</label>):<p className="oaHelp">{t('presets.noProjects')}</p>}</fieldset>
    </section>
    <section className="presetProfileSection" aria-label={t('presets.instructions')}>
    <InstructionsEditor value={draft.instructions} rows={compact?12:10} onChange={instructions=>patch({instructions})}/>
    {!compact&&<p className="oaHelp">{t('presets.snapshotHint')}</p>}
    </section>
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
  return <div className="settingsAgents"><p>{t('presets.hint')}</p>{!ws.ready?<p>{t('aw.loading')}</p>:<div className="oaPresetLayout"><aside><Button className={picking?'primary':''} onClick={()=>{setDraft(undefined);setPicking(true);}}><Plus size={15}/>{t('presets.add')}</Button>{ws.presets.map(p=><button type="button" className={draft?.id===p.id?'isSelected':''} key={p.id} style={p.color?{['--c' as string]:p.color}:undefined} onClick={()=>{setDraft({...p});setPicking(false);}}><AgentAvatar avatar={presetAvatar(p)} color={p.color} animationEnabled={false}/><span className="presetRowText"><span title={p.name}>{p.name}</span>{p.title && <small>{p.title}</small>}<PresetModelBadge preset={p}/></span></button>)}{!ws.presets.length&&<p className="oaHelp">{t('presets.empty')}</p>}</aside><div>
    {picking?<TemplatePicker onPick={preset=>{setPicking(false);setDraft(preset);}}/>
      :!draft?<p>{t('presets.select')}</p>
      :<AgentPresetForm key={draft.id} initial={draft} autoFocus onSaved={setDraft} onDeleted={()=>setDraft(undefined)}/>}
  </div></div>}</div>;
}

/** Square picture scaled to 128 px and kept inline: the preset stays one small JSON record. */
async function avatarDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('avatar-file');
  const bitmap = await createImageBitmap(file);
  try {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const scale = size / Math.max(bitmap.width, bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    canvas.getContext('2d')!.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
    return canvas.toDataURL('image/webp', .86);
  } finally {
    bitmap.close();
  }
}

function AgentAvatarPicker({ value, color, animated, onChange, onAnimatedChange, onBusyChange }: { value?: string; color?: string; animated: boolean; onChange: (avatar?: string) => void; onAnimatedChange: (enabled: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useTranslation(), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState(''), [uploading, setUploading] = useState(false);
  const selection = useRef(0);
  const latestChange = useRef(onChange);
  latestChange.current = onChange;
  useEffect(() => () => { selection.current++; }, []);
  const choose = (avatar?: string) => { selection.current++; setError(''); setUploading(false); onBusyChange(false); onChange(avatar); };
  return <div className="agentAvatarPicker">
    <div className="agentAvatarControls"><AgentAvatar avatar={value} color={color} size={88} animate animationEnabled={animated}/>
      <Button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{t('presets.avatarGallery')}</Button>
      <Button type="button" disabled={uploading} onClick={() => input.current?.click()}>{t('presets.avatarChoose')}</Button>
      {value && <Button type="button" onClick={() => choose(undefined)}>{t('presets.avatarRemove')}</Button>}
    </div>
    {open && <div className="agentAvatarGallery" role="group" aria-label={t('presets.avatarGallery')}>
      {AGENT_AVATARS.map(avatar => {
        const labelKey = 'template' in avatar && avatar.template !== 'orchestrator' ? `builtin.${avatar.template}.name` : `avatars.${avatar.id}`;
        const label = t(labelKey);
        return <button key={avatar.id} type="button" className="agentAvatarOption" aria-pressed={bundledAvatar(value)?.id === avatar.id} onClick={() => choose(`builtin:${avatar.id}`)}>
          <AgentAvatar avatar={`builtin:${avatar.id}`} size={68} animationEnabled={false}/><span>{label}</span>
        </button>;
      })}
    </div>}
    {bundledAvatar(value) && <label className="oaCheck"><input type="checkbox" checked={animated} onChange={event => onAnimatedChange(event.target.checked)}/>{t('presets.avatarAnimation')}</label>}
    <input ref={input} aria-label={t('presets.avatarChoose')} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      const request = ++selection.current;
      setError(''); setUploading(true); onBusyChange(true);
      try { const avatar = await avatarDataUrl(file); if (request === selection.current) latestChange.current(avatar); }
      catch { if (request === selection.current) setError(t('presets.avatarError')); }
      finally { if (request === selection.current) { setUploading(false); onBusyChange(false); } }
    }}/>
    {error && <p role="alert" className="awError">{error}</p>}
  </div>;
}
