import { ActivityOrb } from '../../components/ui/ActivityOrb';
import { FileText, Image, Mic, Shield, Square, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '../../services/filePicker';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { agentVoice, importAgentFile, inspectAgentFiles, setAgentAccess } from '../../services/agent';
import { isTauri } from '../../services/tauri';
import { useAgentStore } from './store';
import { prepareAgent, finishAgentDictation, cancelAgentDictation } from './generation';
import { editTask, useWorkspaceStore } from './workspace';
import { WorkspaceDialog } from './WorkspacePanels';
import type { AccessMode, AgentAttachment } from './ioModel';
import { addActivity } from '../activity/store';
import { AttachmentMenu } from './AttachmentMenu';

function appendAttachments(taskId:string,items:AgentAttachment[]) {
  const current=useAgentStore.getState().threads[taskId];
  if(!current)return;
  if((current.attachments?.length??0)+items.length>8)throw new Error('attachment-limit');
  useAgentStore.getState().update(taskId,s=>({...s,attachments:[...(s.attachments??[]),...items],ioError:undefined}));
}

/** Native drops arrive as file-system paths (Tauri drag-drop), not browser File objects. */
export async function addAgentPaths(taskId:string,paths:string[]) {
  const thread=useAgentStore.getState().threads[taskId];
  if(!thread||!isTauri()||!paths.length)return;
  if(paths.length+(thread.attachments?.length??0)>8)throw new Error('attachment-limit');
  appendAttachments(taskId,await inspectAgentFiles(paths));
}

export async function addAgentFiles(taskId:string,files:File[]) {
  const thread=useAgentStore.getState().threads[taskId];
  if(!thread||!isTauri())return;
  if(files.length+(thread.attachments?.length??0)>8)throw new Error('attachment-limit');
  const imported:AgentAttachment[]=[];
  for(const file of files)imported.push(await importAgentFile(file));
  appendAttachments(taskId,imported);
}
export function AttachmentChips({items,onRemove}:{items:AgentAttachment[];onRemove?:(id:string)=>void}) {
  const {t,i18n}=useTranslation();
  return <div className="awAttachments">{items.map(item=><span className="awAttachment" key={item.id} title={item.path}>{item.kind==='image'?<Image size={15}/>:<FileText size={15}/>}<span>{item.name}</span><small>{new Intl.NumberFormat(i18n.language,{maximumFractionDigits:1}).format(item.size/1024)} KB</small>{onRemove&&<button type="button" aria-label={t('aw.io.remove',{name:item.name})} onClick={()=>onRemove(item.id)}><X size={13}/></button>}</span>)}</div>;
}
export function AgentInputTools({taskId,ready,target,onPrepare,onNewSession,children,action}:{taskId:string;ready:boolean;target:{runId:string;generation:number;language:string};onPrepare:()=>void;onNewSession:()=>void;children?:ReactNode;action?:ReactNode}) {
  const {t}=useTranslation(),thread=useAgentStore(s=>s.threads[taskId]),task=useWorkspaceStore(s=>s.tasks.find(x=>x.id===taskId));
  const [busy,setBusy]=useState(false),[accessInfo,setAccessInfo]=useState(false);
  const native=isTauri(),voice=thread?.voiceStatus??'idle',recording=voice!=='idle';
  const capturing=['listening','recording'].includes(voice);
  const [levels,setLevels]=useState<number[]>([]),[elapsed,setElapsed]=useState(0);
  useEffect(()=>{
    if(!capturing||!thread?.id){setLevels([]);return;}
    let active=true,inflight=false;
    const sample=async()=>{
      setElapsed(Math.max(0,Math.floor((Date.now()-(thread.voiceStartedAt??Date.now()))/1000)));
      if(inflight)return;inflight=true;
      try{const result=await agentVoice(thread.id!,'level');if(active)setLevels(values=>[...values.slice(-39),Math.min(1,Math.log10(1+Math.max(0,result.rms??0))/4)]);}catch{/* Meter failure does not stop recording. */}finally{inflight=false;}
    };
    void sample();const timer=setInterval(()=>void sample(),150);
    return()=>{active=false;clearInterval(timer);};
  },[capturing,thread?.id,thread?.voiceStartedAt]);
  const otherVoice=useAgentStore(s=>Object.entries(s.threads).some(([id,thread])=>id!==taskId&&!!thread.voiceStatus&&thread.voiceStatus!=='idle'));
  const fail=(error:unknown)=>useAgentStore.getState().update(taskId,s=>({...s,ioError:String(error).slice(0,700)}));
  const attach=async(images=false)=>{
    try {
      const paths=await open({multiple:true,directory:false,...(images?{filters:[{name:t('aw.io.images'),extensions:['png','jpg','jpeg','webp','gif','bmp','tif','tiff']}]}:{})});
      if(!paths)return;
      const list=typeof paths==='string'?[paths]:paths;
      if(list.length+(useAgentStore.getState().threads[taskId]?.attachments?.length??0)>8)throw new Error('attachment-limit');
      const items=await inspectAgentFiles(list);
      appendAttachments(taskId,items);
    }catch(error){fail(error);}
  };
  const dictate=async()=>{
    if(busy)return;setBusy(true);
    try {
      useAgentStore.getState().update(taskId,s=>({...s,voiceStatus:'starting',voiceDiscard:false,voiceSendAfter:false,ioError:undefined}));
      onPrepare();
      const id=await prepareAgent(taskId,target);
      if(useAgentStore.getState().threads[taskId]?.voiceDiscard){useAgentStore.getState().update(taskId,s=>({...s,voiceStatus:'idle'}));return;}
      const reply=await agentVoice(id,'start');
      if(reply.status==='busy')throw new Error('voice-busy');
      if(useAgentStore.getState().threads[taskId]?.voiceDiscard){await agentVoice(id,'cancel');useAgentStore.getState().update(taskId,s=>({...s,voiceStatus:'idle'}));return;}
      useAgentStore.getState().update(taskId,s=>({...s,voiceStatus:['starting','idle'].includes(s.voiceStatus??'idle')?'listening':s.voiceStatus,voiceStartedAt:Date.now()}));
    }catch(error){fail(error);useAgentStore.getState().update(taskId,s=>({...s,voiceStatus:'idle'}));}
    finally{setBusy(false);}
  };
  const access=async(mode:AccessMode)=>{
    if(!task||busy)return;
    setBusy(true);
    try {
      if(thread?.id&&mode!=='restricted'&&thread.accessMode!=='restricted'){
        await setAgentAccess(thread.id,mode);
        useAgentStore.getState().update(taskId,s=>({...s,accessMode:mode}));
      }
      editTask(taskId,{accessMode:mode});
      addActivity({kind:'agent.access',level:'info',name:task.title,taskId,data:{mode,effective:!!thread?.id&&mode!=='restricted'&&thread.accessMode!=='restricted'}});
    }catch(error){fail(error);}finally{setBusy(false);}
  };
  const pendingMode=!!thread?.id&&(thread.accessMode??'manual')!==(task?.accessMode??'manual');
  return <><div className="awComposerControls">
    <div className="awComposerLeft"><AttachmentMenu disabled={!native||!!task?.archived||busy} onAttach={images=>void attach(images)}/>
      <div className={`awAccess is-${task?.accessMode??'manual'}`}><button type="button" aria-label={t('aw.io.accessInfo')} title={t('aw.io.accessInfo')} onClick={()=>setAccessInfo(true)}><Shield size={16}/></button><ChoiceSelect label={t('aw.io.access')} value={task?.accessMode??'manual'} options={(['restricted','manual','full'] as AccessMode[]).map(value=>({value,label:t(`aw.io.access.${value}`)}))} disabled={busy||thread?.starting||task?.archived||(task?.runtime==='codex'&&thread?.pending||task?.runtime==='claude'&&!!thread?.id)} onChange={v=>void access(v as AccessMode)}/></div>
    </div>
    <div className="awComposerRight">{children}{!recording&&<button type="button" className="awComposerMic" aria-label={t('aw.io.voice')} disabled={!native||(task?.runtime==='codex'||task?.runtime==='claude')||task?.archived||busy||otherVoice||!ready||thread?.ended||thread?.starting} onClick={()=>void dictate()} title={t((task?.runtime==='codex'||task?.runtime==='claude')?'openai.voiceUnavailable':otherVoice?'aw.io.micBusy':'aw.io.voiceHint')}><Mic size={19}/></button>}{action}</div>
  </div>
  {pendingMode&&<div className="awComposerReason"><span>{t('aw.io.accessCurrent',{mode:t(`aw.io.access.${thread?.accessMode??'manual'}`)})} {t('aw.io.accessNext')}</span><Button type="button" disabled={!ready||thread?.pending||thread?.starting||recording||task?.archived} onClick={onNewSession}>{t('aw.newSession')}</Button></div>}
  {recording&&<div className="awDictation"><div className="awDictationLabel" role="status"><ActivityOrb state={capturing?'listening':'working'}/>{t(capturing?'aw.io.recording':voice==='cancelling'?'aw.io.cancelling':voice==='starting'?'aw.io.startingVoice':'aw.io.transcribing')}{capturing&&<time>{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</time>}</div><div className="awDictationWave" aria-hidden="true">{levels.map((level,index)=><i key={index} style={{height:`${2+level*26}px`}}/>)}</div><button type="button" disabled={voice==='cancelling'} onClick={()=>void cancelAgentDictation(taskId)} title={t('aw.io.cancelVoice')} aria-label={t('aw.io.cancelVoice')}><X size={17}/></button>{capturing&&<button type="button" onClick={()=>void finishAgentDictation(taskId)} title={t('aw.io.stopVoice')} aria-label={t('aw.io.stopVoice')}><Square size={16}/></button>}</div>}
  {thread?.ioError&&<div className="awIoError" role="alert"><details><summary>{t(thread.ioError.includes('no-speech')?'aw.io.noSpeech':thread.ioError.includes('attachment-limit')?'aw.io.limit':'aw.io.failed')}</summary><pre>{thread.ioError}</pre></details><button type="button" aria-label={t('aw.close')} onClick={()=>useAgentStore.getState().update(taskId,s=>({...s,ioError:undefined}))}><X size={14}/></button></div>}
  {accessInfo&&<WorkspaceDialog title={t('aw.io.accessInfo')} onClose={()=>setAccessInfo(false)}>{(['restricted','manual','full'] as AccessMode[]).map(mode=><p key={mode}><b>{t(`aw.io.access.${mode}`)}</b><br/>{t(`aw.io.access.help.${mode}`)}</p>)}<p>{t('aw.io.accessScope')}</p><p>{t('aw.io.voiceHint')}</p><Button type="button" onClick={()=>setAccessInfo(false)}>{t('aw.close')}</Button></WorkspaceDialog>}
  </>;
}
