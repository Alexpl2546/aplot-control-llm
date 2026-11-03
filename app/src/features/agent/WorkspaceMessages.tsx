import { AlertCircle, BookOpen, Check, ChevronDown, Copy, FileText, Image, Pencil, Square, Terminal } from 'lucide-react';
import { Fragment, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { MessageText } from '../chat/MessageText';
import { ArtifactImagePreview } from './ArtifactImagePreview';
import { AgentTurnResults } from './AgentTurnResults';
import { copyChatText } from '../chat/clipboard';
import { answerAgent, isHostTask } from './generation';
import { toolPath } from './workspaceModel';
import { approvalChoices } from './ioModel';
import { AttachmentChips } from './AgentInputTools';
import { useAgentStore, type AgentDecision, type AgentEntry, type AgentQuestion, type AgentTurnOutcome } from './store';
import type { ToolOutcome } from './workspaceModel';
import './workspaceTranscript.css';

function isDirection(entry: AgentEntry) {
  // The host reserves this prefix for user messages delivered to the current turn.
  return entry.kind === 'user' && entry.id.startsWith('steer:');
}

type TranscriptBlock = { entry: AgentEntry } | { tools: AgentEntry[] };
type TranscriptTurn = { id: string; userId?: string; entries: AgentEntry[]; blocks: TranscriptBlock[] };

function splitTranscript(entries: readonly AgentEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let turn: TranscriptTurn | undefined;
  for (const entry of entries) {
    const startsTurn = entry.kind === 'user' && !isDirection(entry);
    if (!turn || startsTurn) {
      turn = { id: entry.id, userId: startsTurn ? entry.id : undefined, entries: [], blocks: [] };
      turns.push(turn);
    }
    turn.entries.push(entry);
    const previous = turn.blocks.at(-1);
    if (entry.kind !== 'tool') turn.blocks.push({ entry });
    else if (previous && 'tools' in previous) previous.tools.push(entry);
    else turn.blocks.push({ tools: [entry] });
  }
  return turns;
}

interface TranscriptProps {
  entries: readonly AgentEntry[];
  turnOutcomes?: Readonly<Record<string, AgentTurnOutcome>>;
  assistantName?: string;
  taskId?: string;
  onMemory: (entry: AgentEntry) => void;
  onCopied: (ok: boolean) => void;
  onShowDiff?: () => void;
  onShowProjectFiles?: () => void;
}

export function WorkspaceTranscript({ entries, turnOutcomes, assistantName, taskId, onMemory, onCopied, onShowDiff, onShowProjectFiles }: TranscriptProps) {
  const turns = useMemo(() => splitTranscript(entries), [entries]);
  return <>{turns.map(turn => {
    const outcome = turn.userId ? turnOutcomes?.[turn.userId] : undefined;
    return <Fragment key={turn.id}>
      {turn.blocks.map(block => 'tools' in block
        ? <WorkspaceToolGroup key={block.tools[0]!.id} entries={block.tools} taskId={taskId}/>
        : <WorkspaceMessage key={block.entry.id} entry={block.entry} taskId={taskId} assistantName={assistantName}
            onMemory={() => onMemory(block.entry)} onCopied={onCopied}/>)}
      {outcome && <TurnOutcome outcome={outcome}/>}
      {outcome && taskId && <AgentTurnResults taskId={taskId} entries={turn.entries}
        onShowDiff={onShowDiff} onShowProjectFiles={onShowProjectFiles}/>}
    </Fragment>;
  })}</>;
}

const turnLabels: Record<AgentTurnOutcome, string> = {
  completed: 'Turn completed',
  interrupted: 'Turn interrupted',
  failed: 'Turn failed',
};

function TurnOutcome({ outcome }: { outcome: AgentTurnOutcome }) {
  const { t } = useTranslation();
  const Icon = outcome === 'completed' ? Check : outcome === 'interrupted' ? Square : AlertCircle;
  return <p className={`awTurnOutcome is-${outcome}`}>
    <Icon size={14} aria-hidden="true"/>{t(`aw.timeline.${outcome}`, { defaultValue: turnLabels[outcome] })}
  </p>;
}

function describeTool(entry: AgentEntry, t: TFunction) {
  const name = entry.name ?? '';
  const target = toolPath(entry.args, entry.result);
  if (name === 'terminal') {
    const command = (entry.args as { command?: unknown } | undefined)?.command;
    return { Icon: Terminal, label: t('aw.timeline.command', { defaultValue: 'Command' }), target: typeof command === 'string' ? command : '' };
  }
  if (name === 'image_generation') return { Icon: Image, label: t('aw.timeline.image', { defaultValue: 'Image generation' }), target };
  if (['read_file', 'search_files', 'list_directory', 'aplot_read_project_file', 'aplot_search_project_files'].includes(name)) {
    return { Icon: FileText, label: t('aw.tool.read'), target: target || name };
  }
  if (['write_file', 'patch', 'edit_file', 'apply_patch'].includes(name)) {
    return { Icon: Pencil, label: t('aw.tool.write'), target: target || name };
  }
  return { Icon: Terminal, label: t('aw.tool.execute'), target: target || name };
}

const prominentToolStates: readonly ToolOutcome[] = ['running', 'error', 'denied', 'interrupted'];

function WorkspaceToolGroup({ entries, taskId }: { entries: readonly AgentEntry[]; taskId?: string }) {
  const { t } = useTranslation();
  if (entries.length === 1) return <WorkspaceTool entry={entries[0]!} taskId={taskId}/>;

  const states = new Map<ToolOutcome, { count: number; last: AgentEntry }>();
  for (const entry of entries) {
    if (entry.status) states.set(entry.status, { count: (states.get(entry.status)?.count ?? 0) + 1, last: entry });
  }
  const highlight = prominentToolStates.map(status => states.get(status)?.last).find(Boolean) ?? entries.at(-1)!;
  const { Icon, label, target } = describeTool(highlight, t);
  return <details className="awToolGroup">
    <summary>
      <Icon size={16} aria-hidden="true"/>
      <span className="awToolGroupCount">{t('aw.timeline.actions', { count: entries.length, defaultValue: '{{count}} tool actions' })}</span>
      <span className="awToolGroupHighlight" title={target || undefined}>{label} {target && <code>{target}</code>}</span>
      {prominentToolStates.map(status => {
        const count = states.get(status)?.count;
        return count ? <span key={status} className={`awToolGroupState is-${status}`}>
          {t(`aw.tool.${status}`)}{count > 1 && ` · ${count}`}
        </span> : null;
      })}
      <ChevronDown className="awToolChevron" size={14} aria-hidden="true"/>
    </summary>
    <div className="awToolGroupItems">
      {entries.map(entry => <WorkspaceTool key={entry.id} entry={entry} taskId={taskId}/>)}
    </div>
  </details>;
}

function WorkspaceTool({ entry, taskId }: { entry: AgentEntry; taskId?: string }) {
  const { t } = useTranslation();
  const { Icon, label, target } = describeTool(entry, t);
  const status = entry.status ?? 'unknown';
  let artifact: { id?: string; name?: string; mime?: string } | undefined;
  if (taskId && entry.name === 'image_generation') {
    try {
      const result: unknown = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
      artifact = result && typeof result === 'object' ? (result as { artifact?: typeof artifact }).artifact : undefined;
    } catch { /* Non-JSON tool output stays plain text. */ }
  }
  return <details className={`awTool is-${status}`}>
    <summary>
      <span className="awToolIcon"><Icon size={16} aria-hidden="true"/></span>
      <span className="awToolTitle">{label} {target && <code>{target}</code>}</span>
      <span className="awToolState">{t(`aw.tool.${status}`)}</span>
      {typeof entry.duration === 'number' && Number.isFinite(entry.duration) && <span className="awTime">{entry.duration.toFixed(1)} s</span>}
      <ChevronDown className="awToolChevron" size={14} aria-hidden="true"/>
    </summary>
    <div className="awToolDetails">
      {entry.name && <b>{entry.name}</b>}
      {entry.details && <pre>{entry.details}</pre>}
      {entry.text && <pre>{entry.text}</pre>}
      {entry.diff && <pre className="awDiff">{entry.diff}</pre>}
      {taskId && typeof artifact?.id === 'string' && artifact.mime?.startsWith('image/') &&
        <ArtifactImagePreview taskId={taskId} artifactId={artifact.id} name={artifact.name ?? 'Image'}/>}
    </div>
  </details>;
}

const decisionLabels: Record<AgentDecision['kind'], string> = {
  answered: 'aw.decision.answered', skipped: 'aw.questionSkipped', denied: 'aw.permissionDenied',
  session: 'aw.decision.session', always: 'aw.decision.always', once: 'aw.permissionAllowed', recorded: 'aw.decision.recorded',
};

export function WorkspaceMessage({ entry, onMemory, onCopied, assistantName, taskId }: { taskId?: string; entry: AgentEntry; onMemory: () => void; onCopied: (ok: boolean) => void; assistantName?:string }) {
  const { t, i18n } = useTranslation();
  if (entry.kind === 'notice' && entry.approvalDecision) {
    const { kind, delivery } = entry.approvalDecision;
    return <div className={`awNotice awDecisionNotice is-${delivery}`}>
      <strong>{t(decisionLabels[kind] ?? 'aw.decision.recorded')}</strong>
      {entry.text && <div className="awDecisionText">{entry.text}</div>}
      {delivery !== 'delivered' && <div>{t(delivery === 'failed' ? 'aw.decision.failed' : 'aw.decision.pending')}</div>}
    </div>;
  }
  if (entry.kind === 'notice') return <p className="awNotice">{entry.text}</p>;
  if (entry.kind === 'tool') return <WorkspaceTool entry={entry} taskId={taskId}/>;
  return <article className={`awMessage is-${entry.kind}`}><header><b>{entry.kind==='assistant'&&assistantName?assistantName:t(entry.kind === 'user' ? 'chat.you' : 'agent.assistant')}</b>{entry.time && <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString(i18n.language,{hour:'2-digit',minute:'2-digit'})}</time>}</header>
    {isDirection(entry) && <p className="awTurnDirection">{t('aw.timeline.steer', { defaultValue: 'Direction for the current turn' })}</p>}
    {entry.reasoning && <details className="chatReasoning"><summary>{t('agent.reasoning')}</summary><div>{entry.reasoning}</div></details>}
    {!!entry.attachments?.length&&<AttachmentChips items={entry.attachments}/>}<MessageText text={entry.text}/>
    {entry.kind === 'assistant' && entry.text && <div className="awMessageActions"><button onClick={() => { void copyChatText(entry.text).then(onCopied); }}><Copy size={13}/>{t('aw.copy')}</button><button onClick={onMemory}><BookOpen size={13}/>{t('aw.toMemory')}</button></div>}
  </article>;
}
export function WorkspaceRequest({ question, taskId, hermes }: { question: AgentQuestion; taskId: string; hermes: boolean }) {
  const { t } = useTranslation(), [values,setValues] = useState<Record<string,string>>({}), [sending,setSending] = useState(false), gate = useRef(false);
  const submit = async (result: Record<string,unknown>, note: string) => {
    if (gate.current) return; gate.current = true; setSending(true);
    try {
      const journaled = isHostTask(taskId);
      const ok = await answerAgent(taskId,question.id,result);
      if (ok && !journaled) useAgentStore.getState().update(taskId,s => ({...s,entries:[...s.entries,{id:crypto.randomUUID(),kind:'notice',text:note,time:Date.now()}]}));
    } finally { gate.current = false; setSending(false); }
  };
  const questions = Array.isArray(question.params.questions) ? question.params.questions as { qid: string; question: string; choices?: string[] }[] : [{qid:'single',question:String(question.params.question ?? ''),choices:question.params.choices as string[]|undefined}];
  const choices = approvalChoices(question.params);
  const title = t(question.method === 'approval' ? 'agent.permission' : 'agent.question');
  return <section className="awRequest" aria-label={title}><h3><AlertCircle size={17} aria-hidden="true"/>{title}</h3>
    {question.method === 'approval' ? <>
      {typeof question.params.description === 'string' && question.params.description && <p>{question.params.description}</p>}
      {typeof question.params.command === 'string' && question.params.command && <pre>{question.params.command}</pre>}
      <div className="awInlineActions">
        <Button disabled={sending} onClick={() => void submit({ choice: 'deny' }, t('aw.permissionDenied'))}>{t('agent.deny')}</Button>
        <Button disabled={sending} className="primary" onClick={() => void submit({ choice: 'once' }, t('aw.permissionAllowed'))}>{t('agent.allowOnce')}</Button>
        {choices.includes('session') && <Button disabled={sending} onClick={() => void submit({ choice: 'session' }, t('aw.decision.session'))}>{t('aw.io.allowSession')}</Button>}
        {choices.includes('always') && <Button disabled={sending} onClick={() => void submit({ choice: 'always' }, t('aw.decision.always'))}>{t('aw.io.allowAlways')}</Button>}
      </div>
      {hermes && choices.includes('always') && <p className="awMuted">{t('aw.io.alwaysScope')}</p>}
    </> : <form onSubmit={e => {e.preventDefault(); void submit(Array.isArray(question.params.questions) ? {answers:values} : {answer:values.single ?? ''},questions.map(q => `${q.question} — ${values[q.qid] ?? ''}`).join('\n'));}}>{questions.map(item => <div className="agentQuestion" key={item.qid}><label htmlFor={`aw-${question.id}-${item.qid}`}>{item.question}</label>{item.choices && <div className="awChoices">{item.choices.map(choice => <Button key={choice} type="button" disabled={sending} aria-pressed={values[item.qid] === choice} onClick={() => setValues(v => ({...v,[item.qid]:choice}))}>{choice}{values[item.qid] === choice && <Check size={12}/>}</Button>)}</div>}<input id={`aw-${question.id}-${item.qid}`} className="uiInput" maxLength={4000} disabled={sending} value={values[item.qid] ?? ''} onChange={e => setValues(v => ({...v,[item.qid]:e.target.value}))}/></div>)}<div className="awInlineActions"><Button type="button" disabled={sending} onClick={() => void submit({},t('aw.questionSkipped'))}>{t('agent.skip')}</Button><Button className="primary" type="submit" disabled={sending || questions.some(q => !values[q.qid]?.trim())}>{t('agent.answer')}</Button></div></form>}
  </section>;
}
