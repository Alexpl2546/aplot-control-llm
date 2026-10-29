import { AgentIcon } from './AgentIdentity';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import { useEffect, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentInputTools, AttachmentChips, addAgentFiles } from './AgentInputTools';
import { AgentContextMeter } from './AgentContextMeter';
import { useAgentStore, type AgentThread } from './store';
import type { AgentTask } from './workspaceModel';
import { enqueueAgent, sendQueuedAgent, finishAgentDictation, removeQueuedAgent } from './generation';
import { editTask } from './workspace';
import { setCodexEffort } from '../../services/codex';
import { ReasoningSelect } from '../reasoning/reasoning';

export function AgentComposer({task,thread,ready,saveError,inputRef,modelLabel,onSend,onStop,onPrepare,onNewSession,onConnection,notice}:{
  task:AgentTask;thread:AgentThread;ready:boolean;saveError:boolean;inputRef:RefObject<HTMLTextAreaElement|null>;modelLabel:string;
  onSend:()=>void;onStop:()=>void;onPrepare:()=>void;onNewSession:()=>void;onConnection:()=>void;notice?:ReactNode;
}) {
  const {t,i18n}=useTranslation();
  useEffect(()=>{const el=inputRef.current;if(el){el.style.height='auto';el.style.height=`${Math.min(220,Math.max(76,el.scrollHeight))}px`;}},[thread.draft,inputRef]);
  const files=(items:File[])=>void addAgentFiles(task.id,items).catch(error=>useAgentStore.getState().update(task.id,s=>({...s,ioError:String(error)})));
  const capturing=['listening','recording'].includes(thread.voiceStatus??'');
  const voiceBusy=!!thread.voiceStatus&&thread.voiceStatus!=='idle';
  const canSend=ready&&!thread.ended&&!thread.starting&&!task.archived&&!saveError&&(capturing||(!voiceBusy&&!!(thread.draft.trim()||thread.attachments?.length)));
  const submit=()=>{if(!canSend)return;if(thread.pending){enqueueAgent(task.id,i18n.language.startsWith('ru')?'ru':'en');return;}if(capturing)void finishAgentDictation(task.id,true);else onSend();};
  return <div className="awComposerDock">
    {!!thread.queue?.length&&<div className="awQueued"><span>{t('connections.queueCount',{count:thread.queue.length})}</span>{thread.queue.map(item=><div key={item.id}><span title={item.text}>{item.text.slice(0,100)||item.attachments?.map(a=>a.name).join(', ')}</span><button type="button" aria-label={t('aw.close')} onClick={()=>void removeQueuedAgent(task.id,item.id)}>×</button></div>)}{!thread.pending&&<button type="button" disabled={!ready||thread.ended} onClick={()=>void sendQueuedAgent(task.id,{runId:task.binding?.runId??'',generation:task.binding?.generation??0,language:i18n.language.startsWith('ru')?'ru':'en'})}>{t('connections.continueQueue')}</button>}</div>}
    {notice&&<div className="awComposerNotice">{notice}</div>}
    <form className="awComposer awComposerDesk" data-file-drop={`agent:${task.id}`} onSubmit={event=>{event.preventDefault();submit();}}>
      <AttachmentChips items={thread.attachments??[]} onRemove={id=>useAgentStore.getState().update(task.id,s=>({...s,attachments:s.attachments?.filter(item=>item.id!==id)}))}/>
      <textarea ref={inputRef} aria-label={t('chat.input')} placeholder={t('aw.composer.placeholder')} value={thread.draft} maxLength={100000} disabled={task.archived} rows={2}
        onPaste={event=>{const images=Array.from(event.clipboardData.files).filter(file=>file.type.startsWith('image/'));if(images.length){event.preventDefault();files(images);}}}
        onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
        onDrop={event=>{const items=Array.from(event.dataTransfer.files);if(items.length){event.preventDefault();files(items);}}}
        onChange={event=>useAgentStore.getState().update(task.id,s=>({...s,draft:event.target.value}))}
        onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submit();}}}/>
      <AgentInputTools taskId={task.id} ready={ready&&!saveError} target={{runId:task.binding?.runId??'',generation:task.binding?.generation??0,language:i18n.language.startsWith('ru')?'ru':'en'}} onPrepare={onPrepare} onNewSession={onNewSession}
        action={thread.pending?<>{canSend&&<button type="submit" className="awQueueNext">{t('connections.sendNext')}</button>}<button type="button" className="awComposerSubmit isStop" onClick={onStop} aria-label={t('aw.stopTask')} title={t('aw.stopTask')}><Square size={17}/></button></>:<button type="submit" className="awComposerSubmit" disabled={!canSend} aria-label={t('chat.send')} title={t('chat.send')}><ArrowUp size={21}/></button>}>
        <AgentContextMeter compact taskId={task.id} limit={thread.actualContextTokens??task.binding?.contextTokens}/>
        <ReasoningSelect className="awComposerReasoning" provider={task.runtime==='codex'?'chatgpt':task.runtime==='claude'?'claude':'local'} value={task.reasoning} disabled={task.archived} hint={t(task.runtime==='codex'?'reasoning.hint':'reasoning.nextSession')} onChange={level=>{editTask(task.id,{reasoning:level});if(task.runtime==='codex'&&thread.id)setCodexEffort(thread.id,level);}}/>
        <button type="button" className="awComposerModel" disabled={thread.pending||voiceBusy||task.archived} aria-label={t('aw.composer.modelPicker')} title={`${task.runtime??'Hermes'} · ${modelLabel}`} aria-haspopup="dialog" onClick={onConnection}><AgentIcon runtime={task.runtime}/><span className="awComposerAgent">{task.agentName??(task.runtime==='claude'?'Claude':task.runtime==='codex'?'Codex':'Hermes')}</span><span className="awComposerModelName">{modelLabel}</span><ChevronDown size={14}/></button>
      </AgentInputTools>
    </form>
    <div className="awComposerFootnote">{t(thread.pending?'aw.draftWhileWorking':'chat.keyboard')}</div>
  </div>;
}
