import { AgentIcon } from './AgentIdentity';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { AgentInputTools, AttachmentChips, addAgentFiles } from './AgentInputTools';
import { AgentContextMeter } from './AgentContextMeter';
import { useAgentStore, type AgentThread } from './store';
import type { AgentTask } from './workspaceModel';
import { enqueueAgent, sendQueuedAgent, finishAgentDictation, removeQueuedAgent } from './generation';
import { editTask } from './workspace';
import { setCodexEffort } from '../../services/codex';
import { steerHostTask, type HostSteer } from '../../services/agentTasks';
import { codexControlError } from './codexControlError';
import { ReasoningSelect } from '../reasoning/reasoning';
import { taskReasoningKey, useReasoningProfile } from '../reasoning/profiles';
import { useControlStore } from '../../store/control';
import { clipboardImages } from '../chat/clipboardImages';

type SteerFeedback = { status: 'sending' | 'sent' } | { status: 'error'; cause: unknown };

// Keep the last unconfirmed command per task across composer remounts.
const steerAttempts = new Map<string, HostSteer>();
const MAX_RETRY_TASKS = 32;

function steerRequest(taskId: string, turnId: string, generation: number, text: string): HostSteer {
  const previous = steerAttempts.get(taskId);
  const request = previous?.expectedTurnId === turnId && previous.expectedGeneration === generation && previous.text === text
    ? previous
    : { commandId: crypto.randomUUID(), taskId, expectedTurnId: turnId, expectedGeneration: generation, text };
  steerAttempts.delete(taskId);
  steerAttempts.set(taskId, request);
  if (steerAttempts.size > MAX_RETRY_TASKS) {
    const oldest = steerAttempts.keys().next().value;
    if (oldest !== undefined) steerAttempts.delete(oldest);
  }
  return request;
}

export function AgentComposer({task,thread,ready,saveError,inputRef,modelLabel,onSend,onStop,onPrepare,onNewSession,onConnection,notice}:{
  task:AgentTask;thread:AgentThread;ready:boolean;saveError:boolean;inputRef:RefObject<HTMLTextAreaElement|null>;modelLabel:string;
  onSend:()=>void;onStop:()=>void;onPrepare:()=>void;onNewSession:()=>void;onConnection:()=>void;notice?:ReactNode;
}) {
  const runs=useControlStore(state=>state.runs);
  const reasoningProfileOfTask=useReasoningProfile(taskReasoningKey(task,runId=>runs.find(run=>run.info.runId===runId)?.config?.modelPath));
  const {t,i18n}=useTranslation();
  const [steerFeedback, setSteerFeedback] = useState<SteerFeedback>();
  const steering = useRef(false);
  const language = i18n.language.startsWith('ru') ? 'ru' : 'en';
  const target = {
    runId: task.binding?.runId ?? '',
    generation: task.binding?.generation ?? 0,
    language,
  };
  useEffect(()=>{const el=inputRef.current;if(el){el.style.height='auto';el.style.height=`${Math.min(220,Math.max(76,el.scrollHeight))}px`;}},[thread.draft,inputRef]);
  const files=(items:File[])=>void addAgentFiles(task.id,items).catch(error=>useAgentStore.getState().update(task.id,s=>({...s,ioError:String(error)})));
  const capturing=['listening','recording'].includes(thread.voiceStatus??'');
  const voiceBusy=!!thread.voiceStatus&&thread.voiceStatus!=='idle';
  const writable = ready && !thread.ended && !thread.starting && !task.archived && !saveError;
  const steerPending = steerFeedback?.status === 'sending';
  const canSend = writable && !steerPending && (capturing || (!voiceBusy && !!(thread.draft.trim() || thread.attachments?.length)));
  const turnId = thread.activeNativeTurnId;
  const generation = thread.nativeGeneration;
  const hasSteerTarget = task.runtime === 'codex' && thread.pending && !thread.ended && !thread.starting &&
    !!thread.id && !!turnId && generation !== undefined && Number.isSafeInteger(generation) && generation > 0;
  const hasAttachments = !!thread.attachments?.length;
  const canSteer = hasSteerTarget && writable && !voiceBusy && !steerPending && !hasAttachments && !!thread.draft.trim();

  const submit = () => {
    if (!canSend || steering.current) return;
    setSteerFeedback(undefined);
    if (thread.pending) enqueueAgent(task.id, language);
    else if (capturing) void finishAgentDictation(task.id, true);
    else onSend();
  };

  const steer = async () => {
    if (!canSteer || steering.current || !turnId || generation === undefined) return;
    const store = useAgentStore.getState();
    const current = store.threads[task.id];
    if (!current?.pending || current.starting || current.ended || current.id !== thread.id ||
        current.activeNativeTurnId !== turnId || current.nativeGeneration !== generation) {
      setSteerFeedback({ status: 'error', cause: 'stale' });
      return;
    }
    if (current.attachments?.length || (current.voiceStatus && current.voiceStatus !== 'idle')) return;
    const draft = current.draft;
    const text = draft.trim();
    if (!text) return;
    const request = steerRequest(task.id, turnId, generation, text);

    steering.current = true;
    setSteerFeedback({ status: 'sending' });
    // Reserve the submitted text immediately so switching tasks cannot resend it.
    store.update(task.id, value => ({ ...value, draft: '' }));
    inputRef.current?.focus();
    try {
      const result = await steerHostTask(request);
      if (result.status !== 'accepted') throw new Error(result.error ?? 'timeout');
      if (steerAttempts.get(task.id) === request) steerAttempts.delete(task.id);
      setSteerFeedback({ status: 'sent' });
    } catch (cause) {
      if (useAgentStore.getState().threads[task.id]) {
        store.update(task.id, value => ({ ...value, draft: [draft, value.draft].filter(Boolean).join('\n\n') }));
      }
      setSteerFeedback({ status: 'error', cause });
    } finally {
      steering.current = false;
    }
  };

  return <div className="awComposerDock">
    {!!thread.queue?.length && <div className="awQueued">
      <span role="status">{t('connections.queueCount', { count: thread.queue.length })}</span>
      {thread.queue.map(item => <div key={item.id}>
        <span title={item.text}>{item.text.slice(0, 100) || item.attachments?.map(attachment => attachment.name).join(', ')}</span>
        <button type="button" aria-label={t('aw.composer.removeQueued', { defaultValue: 'Remove message from queue' })} onClick={() => void removeQueuedAgent(task.id, item.id)}>×</button>
      </div>)}
      {!thread.pending && <button type="button" disabled={!writable || steerPending} onClick={() => void sendQueuedAgent(task.id, target)}>{t('connections.continueQueue')}</button>}
    </div>}
    {notice&&<div className="awComposerNotice">{notice}</div>}
    <form className="awComposer awComposerDesk" data-file-drop={`agent:${task.id}`} onSubmit={event=>{event.preventDefault();submit();}}>
      <AttachmentChips items={thread.attachments??[]} onRemove={id=>useAgentStore.getState().update(task.id,s=>({...s,attachments:s.attachments?.filter(item=>item.id!==id)}))}/>
      <textarea ref={inputRef} aria-label={t('chat.input')} placeholder={t('aw.composer.placeholder')} value={thread.draft} maxLength={100000} disabled={task.archived} rows={2}
        onPaste={event=>{const images=clipboardImages(event.clipboardData);if(images.length){event.preventDefault();files(images);}}}
        onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
        onDrop={event=>{const items=Array.from(event.dataTransfer.files);if(items.length){event.preventDefault();files(items);}}}
        onChange={event=>useAgentStore.getState().update(task.id,s=>({...s,draft:event.target.value}))}
        onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submit();}}}/>
      <AgentInputTools taskId={task.id} ready={ready&&!saveError} target={target} onPrepare={onPrepare} onNewSession={onNewSession}
        action={!thread.pending && <button type="submit" className="awComposerSubmit" disabled={!canSend} aria-label={t('chat.send')} title={t('chat.send')}><ArrowUp size={21}/></button>}>
        <AgentContextMeter compact taskId={task.id} limit={thread.actualContextTokens??task.binding?.contextTokens}/>
        <ReasoningSelect className="awComposerReasoning" profile={reasoningProfileOfTask} provider={task.runtime==='codex'?'chatgpt':task.runtime==='claude'?'claude':'local'} value={task.reasoning} disabled={task.archived} hint={t(task.runtime==='codex'?'reasoning.hint':'reasoning.nextSession')} onChange={level=>{editTask(task.id,{reasoning:level});if(task.runtime==='codex'&&thread.id)setCodexEffort(thread.id,level);}}/>
        <button type="button" className="awComposerModel" disabled={thread.pending||voiceBusy||task.archived} aria-label={t('aw.composer.modelPicker')} title={`${task.runtime??'Hermes'} · ${modelLabel}`} aria-haspopup="dialog" onClick={onConnection}><AgentIcon runtime={task.runtime}/><span className="awComposerAgent">{task.agentName??(task.runtime==='claude'?'Claude':task.runtime==='codex'?'Codex':'Hermes')}</span><span className="awComposerModelName">{modelLabel}</span><ChevronDown size={14}/></button>
      </AgentInputTools>
      {thread.pending && <div className="awComposerWorkingActions">
        {hasSteerTarget && <Button type="button" disabled={!canSteer} onClick={() => void steer()}>
          {t('codex.controls.steerLabel', { defaultValue: 'Steer the active turn' })}
        </Button>}
        <Button type="submit" className="primary" disabled={!canSend}>
          {t('aw.composer.enqueue', { defaultValue: 'Add to queue' })}
        </Button>
        <Button type="button" className="danger" onClick={onStop}>
          <Square size={15} aria-hidden="true"/>{t('aw.stopTask')}
        </Button>
      </div>}
      {steerFeedback?.status === 'error' ? (
        <p className="awComposerFeedback isError" role="alert">{codexControlError(steerFeedback.cause, t)}</p>
      ) : steerFeedback && (
        <p className="awComposerFeedback" role="status">{steerPending
          ? t('codex.controls.steerSending', { defaultValue: 'Sending direction…' })
          : t('codex.controls.steerAccepted', { defaultValue: 'Direction sent to the active turn.' })}</p>
      )}
    </form>
    <div className="awComposerFootnote">{keyboardHint()}</div>
  </div>;

  function keyboardHint() {
    if (!thread.pending) return t('chat.keyboard');
    if (!writable) return t('aw.draftWhileWorking');
    if (hasSteerTarget && hasAttachments) {
      return t('aw.composer.steerTextOnly', { defaultValue: 'Send attachments with the next message' });
    }
    return t('aw.composer.queueKeyboard', { defaultValue: 'Enter to queue · Shift+Enter for a new line' });
  }
}
