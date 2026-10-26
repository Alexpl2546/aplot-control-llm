import { BookOpen, Check, ChevronDown, Copy, FileText, Pencil, Terminal, AlertCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { MessageText } from '../chat/MessageText';
import { copyChatText } from '../chat/clipboard';
import { answerAgent } from './generation';
import { toolPath } from './workspaceModel';
import { approvalChoices } from './ioModel';
import { AttachmentChips } from './AgentInputTools';
import { useAgentStore, type AgentEntry, type AgentQuestion } from './store';

export function WorkspaceMessage({ entry, onMemory, onCopied, assistantName }: { entry: AgentEntry; onMemory: () => void; onCopied: (ok: boolean) => void; assistantName?:string }) {
  const { t, i18n } = useTranslation();
  if (entry.kind === 'notice') return <p className="awNotice">{entry.text}</p>;
  if (entry.kind === 'tool') {
    const path = toolPath(entry.args,entry.result), name = entry.name ?? '', isRead = ['read_file','search_files','list_directory'].includes(name), isWrite = ['write_file','patch','edit_file','apply_patch'].includes(name);
    const Icon = isRead ? FileText : isWrite ? Pencil : Terminal;
    const label = t(isRead ? 'aw.tool.read' : isWrite ? 'aw.tool.write' : 'aw.tool.execute');
    return <details className={`awTool is-${entry.status ?? 'unknown'}`}><summary><span className="awToolIcon"><Icon size={16}/></span><span className="awToolTitle">{label} <code>{path || name}</code></span><span className="awToolState">{t(`aw.tool.${entry.status ?? 'unknown'}`)}</span>{entry.duration !== undefined && <span className="awTime">{entry.duration.toFixed(1)} s</span>}<ChevronDown size={14}/></summary>
      <div className="awToolDetails"><b>{name}</b>{entry.details && <pre>{entry.details}</pre>}{entry.text && <pre>{entry.text}</pre>}{entry.diff && <pre className="awDiff">{entry.diff}</pre>}</div>
    </details>;
  }
  return <article className={`awMessage is-${entry.kind}`}><header><b>{entry.kind==='assistant'&&assistantName?assistantName:t(entry.kind === 'user' ? 'chat.you' : 'agent.assistant')}</b>{entry.time && <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString(i18n.language,{hour:'2-digit',minute:'2-digit'})}</time>}</header>
    {entry.reasoning && <details className="chatReasoning"><summary>{t('agent.reasoning')}</summary><div>{entry.reasoning}</div></details>}
    {!!entry.attachments?.length&&<AttachmentChips items={entry.attachments}/>}<MessageText text={entry.text}/>
    {entry.kind === 'assistant' && entry.text && <div className="awMessageActions"><button onClick={() => { void copyChatText(entry.text).then(onCopied); }}><Copy size={13}/>{t('aw.copy')}</button><button onClick={onMemory}><BookOpen size={13}/>{t('aw.toMemory')}</button></div>}
  </article>;
}
export function WorkspaceRequest({ question, taskId }: { question: AgentQuestion; taskId: string }) {
  const { t } = useTranslation(), [values,setValues] = useState<Record<string,string>>({}), [sending,setSending] = useState(false), gate = useRef(false);
  const submit = async (result: Record<string,unknown>, note: string) => {
    if (gate.current) return; gate.current = true; setSending(true);
    try {
      const ok = await answerAgent(taskId,question.id,result);
      if (ok) useAgentStore.getState().update(taskId,s => ({...s,entries:[...s.entries,{id:crypto.randomUUID(),kind:'notice',text:note,time:Date.now()}]}));
    } finally { gate.current = false; setSending(false); }
  };
  const questions = Array.isArray(question.params.questions) ? question.params.questions as { qid: string; question: string; choices?: string[] }[] : [{qid:'single',question:String(question.params.question ?? ''),choices:question.params.choices as string[]|undefined}];
  return <section className="awRequest" aria-label={t(question.method === 'approval' ? 'agent.permission' : 'agent.question')}><h3><AlertCircle size={17}/>{t(question.method === 'approval' ? 'agent.permission' : 'agent.question')}</h3>
    {question.method === 'approval' ? <><p>{String(question.params.description ?? '')}</p><pre>{String(question.params.command ?? '')}</pre><div className="awInlineActions"><Button disabled={sending} onClick={() => void submit({choice:'deny'},t('aw.permissionDenied'))}>{t('agent.deny')}</Button><Button disabled={sending} className="primary" onClick={() => void submit({choice:'once'},t('aw.permissionAllowed'))}>{t('agent.allowOnce')}</Button>{approvalChoices(question.params).includes('session')&&<Button disabled={sending} onClick={()=>void submit({choice:'session'},t('aw.io.allowedSession'))}>{t('aw.io.allowSession')}</Button>}{approvalChoices(question.params).includes('always')&&<Button disabled={sending} title={t('aw.io.alwaysScope')} onClick={()=>void submit({choice:'always'},t('aw.io.allowedAlways'))}>{t('aw.io.allowAlways')}</Button>}</div><p className="awMuted">{t('aw.io.alwaysScope')}</p></> : <form onSubmit={e => {e.preventDefault(); void submit(Array.isArray(question.params.questions) ? {answers:values} : {answer:values.single ?? ''},questions.map(q => `${q.question} — ${values[q.qid] ?? ''}`).join('\n'));}}>{questions.map(item => <div className="agentQuestion" key={item.qid}><label htmlFor={`aw-${question.id}-${item.qid}`}>{item.question}</label>{item.choices && <div className="awChoices">{item.choices.map(choice => <Button key={choice} type="button" disabled={sending} aria-pressed={values[item.qid] === choice} onClick={() => setValues(v => ({...v,[item.qid]:choice}))}>{choice}{values[item.qid] === choice && <Check size={12}/>}</Button>)}</div>}<input id={`aw-${question.id}-${item.qid}`} className="uiInput" maxLength={4000} disabled={sending} value={values[item.qid] ?? ''} onChange={e => setValues(v => ({...v,[item.qid]:e.target.value}))}/></div>)}<div className="awInlineActions"><Button type="button" disabled={sending} onClick={() => void submit({},t('aw.questionSkipped'))}>{t('agent.skip')}</Button><Button className="primary" type="submit" disabled={sending || questions.some(q => !values[q.qid]?.trim())}>{t('agent.answer')}</Button></div></form>}
  </section>;
}
