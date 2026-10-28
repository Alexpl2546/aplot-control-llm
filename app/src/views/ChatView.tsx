import { AgentIcon } from '../features/agent/AgentIdentity';
import { openSettingsSection } from '../services/settingsWindow';
import { ActivityOrb } from '../components/ui/ActivityOrb';
import { ChatInputExtras } from '../features/chat/ChatInputExtras';
import { ChatDictationBar, ChatMicButton, useChatDictation } from '../features/chat/ChatDictation';
import { ReasoningSelect, reasoningFor, useChatReasoning } from '../features/reasoning/reasoning';
import { chatAttachmentPayload } from '../features/chat/media';
import { CloudProfileSelect } from '../features/openai/CloudProfileSelect';
import { cloudSelection, useOpenAi } from '../features/openai/store';
import { MessageSquare, Plus, Send, Square, Copy } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../store/control';
import { Button } from '../components/ui/Primitives';
import { ChoiceSelect } from '../components/ui/ChoiceSelect';
import { EMPTY_THREAD, useChatStore } from '../features/chat/store';
import { initializeChatHistory, flushChatHistory } from '../features/chat/history';
import { ChatHistory } from '../features/chat/ChatHistory';
import type { ChatTarget } from '../features/chat/historyModel';
import type { ChatMessage } from '../features/chat/stream';
import type { ChatRequest } from '../services/chat';
import { startChatGeneration, stopChatGeneration, translateReasoning, stopReasoningTranslation } from '../features/chat/generation';
import { isTauri } from '../services/tauri';
import { ENGINE_NAMES } from '../lib/engineModels';
import { MessageText } from '../features/chat/MessageText';
import { ReasoningText } from '../features/chat/ReasoningText';
import { copyChatText } from '../features/chat/clipboard';

type Run = ReturnType<typeof useControlStore.getState>['runs'][number];
type Provider = 'local' | 'chatgpt' | 'claude';
type CloudTarget = NonNullable<ChatRequest['cloud']>;

function localTarget(run?: Run): ChatTarget {
  return { provider: 'local', runId: run?.info.runId ?? '', generation: run?.info.generation ?? 0, label: run?.info.name ?? '', engine: run?.info.engine, modelId: run?.info.modelId, startedAt: run?.info.startedAt };
}
function configuredTarget(provider: Provider, run?: Run, profileId = useOpenAi.getState().chatProfileId, model?: string): ChatTarget {
  if (provider === 'local') return localTarget(run);
  const state = useOpenAi.getState(), selection = cloudSelection(state, provider === 'claude' ? 'claude' : 'openai', undefined, profileId);
  const preferred = model ?? (provider === 'claude' ? state.claudeChatModel : state.chatModel);
  const selectedModel = selection.models.some(item => item.model === preferred) ? preferred : selection.models[0]?.model ?? '';
  return { provider, connectionId: selection.status.connectionId ?? '', profileId: selection.profile?.id ?? profileId, model: selectedModel, label: `${provider === 'claude' ? 'Claude' : 'ChatGPT'}${selectedModel ? ` · ${selectedModel}` : ''}` };
}

export function ChatView() {
  const { t } = useTranslation();
  const runs = useControlStore(state => state.runs), selectedRunId = useControlStore(state => state.selectedRunId);
  const selectRun = useControlStore(state => state.selectRun), cloudState = useOpenAi();
  const selectedId = useChatStore(state => state.selectedId), conversations = useChatStore(state => state.conversations);
  const historyReady = useChatStore(state => state.historyReady), historyError = useChatStore(state => state.historyError);
  const initialized = useControlStore(state => state.initialized);
  const provider = cloudState.chatProvider, selectedRun = runs.find(item => item.info.runId === selectedRunId);
  const selection = cloudSelection(cloudState, provider === 'claude' ? 'claude' : 'openai', undefined, cloudState.chatProfileId);
  const preferred = provider === 'claude' ? cloudState.claudeChatModel : cloudState.chatModel;
  const selectedModel = selection.models.some(item => item.model === preferred) ? preferred : selection.models[0]?.model ?? '';
  const conversation = conversations[selectedId];
  const target = conversation?.target;
  // Restored history resolves its own exact target. Current selectors can never silently redirect an old conversation.
  const run = target?.provider === 'local' ? runs.find(item => item.info.runId === target.runId && item.info.generation === target.generation && item.info.modelId === target.modelId && item.info.startedAt === target.startedAt) : undefined;
  const connected = target && target.provider !== 'local' ? cloudSelection(cloudState, target.provider === 'claude' ? 'claude' : 'openai', target.connectionId, target.profileId) : undefined;
  const cloud = useMemo<CloudTarget | undefined>(() => target && target.provider !== 'local' && target.connectionId && connected?.status.connected && connected.status.connectionId === target.connectionId && connected.models.some(item => item.model === target.model)
    ? { provider: target.provider, connectionId: target.connectionId, model: target.model } : undefined,
  [target, connected?.status.connected, connected?.status.connectionId, connected?.models]);
  const choose = useCallback((id: string) => {
    const item = useChatStore.getState().conversations[id];
    if (!item) return;
    useChatStore.getState().select(id);
    const savedTarget = item.target;
    useOpenAi.setState({ chatProvider: savedTarget.provider, ...(savedTarget.provider === 'local' ? {} : { chatProfileId: savedTarget.profileId, ...(savedTarget.provider === 'claude' ? { claudeChatModel: savedTarget.model } : { chatModel: savedTarget.model }) }) });
    if (savedTarget.provider === 'local' && useControlStore.getState().runs.some(current => current.info.runId === savedTarget.runId)) selectRun(savedTarget.runId);
  }, [selectRun]);
  useEffect(() => { void initializeChatHistory(); }, []);
  useEffect(() => {
    if (!historyReady || initialized === false) return;
    if (selectedId && useChatStore.getState().conversations[selectedId]) choose(selectedId);
    else useChatStore.getState().activate(configuredTarget(provider, selectedRun));
    // Selection restoration runs once per selected conversation, rather than whenever the connection catalog refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReady, selectedId, choose, initialized]);
  const activate = (nextProvider: Provider, nextRun = selectedRun, profileId = cloudState.chatProfileId, model?: string) => {
    useOpenAi.setState({ chatProvider: nextProvider });
    const id = useChatStore.getState().activate(configuredTarget(nextProvider, nextRun, profileId, model));
    choose(id);
  };
  const newChat = () => choose(useChatStore.getState().create(configuredTarget(provider, selectedRun)));
  const continueChat = () => {
    const previous = useChatStore.getState();
    const source = previous.threads[selectedId];
    if (!source || !conversation) return;
    const id = previous.create(configuredTarget(provider, selectedRun));
    previous.update(id, () => ({ ...structuredClone(source), pending: false, translating: false, stopped: false, error: '' }));
    if (conversation.title) previous.rename(id, conversation.title);
    choose(id);
  };
  const reasoningLevels = useChatReasoning(state => state.levels), setReasoning = useChatReasoning(state => state.set);
  const controls = <>
    <button type="button" className="chatConnectionButton" onClick={() => openSettingsSection('connections')}>{t('openai.connections')}</button>
    {provider !== 'local' ? <><CloudProfileSelect provider={provider === 'claude' ? 'claude' : 'openai'} profileId={cloudState.chatProfileId} onChange={id => { useOpenAi.setState({ chatProfileId: id }); activate(provider, selectedRun, id); }}/><ChoiceSelect variant="model" label={t('openai.model')} value={selectedModel} options={selection.models.map(item => ({ value: item.model, label: item.displayName, description: item.model, keywords: item.defaultReasoningEffort }))} onChange={model => { useOpenAi.setState(provider === 'claude' ? { claudeChatModel: model } : { chatModel: model }); activate(provider, selectedRun, cloudState.chatProfileId, model); }}/></>
      : <ChoiceSelect label={t('chat.server')} value={selectedRun?.info.runId ?? ''} options={runs.map(item => ({ value: item.info.runId, label: item.info.name }))} onChange={id => { selectRun(id); activate('local', runs.find(item => item.info.runId === id)); }}/>}
    <ReasoningSelect provider={provider} value={reasoningLevels[provider]} onChange={level => setReasoning(provider, level)}/>
  </>;
  return <div className="chatRoute">
    <div className="oaChatSwitch"><button type="button" disabled={!historyReady} aria-pressed={provider === 'local'} onClick={() => activate('local')}><AgentIcon runtime="local"/>{t('openai.localModels')}</button><button type="button" disabled={!historyReady} aria-pressed={provider === 'chatgpt'} onClick={() => activate('chatgpt')}><AgentIcon runtime="codex"/>ChatGPT</button><button type="button" disabled={!historyReady} aria-pressed={provider === 'claude'} onClick={() => activate('claude')}><AgentIcon runtime="claude"/>Claude</button></div>
    {historyError && <div className="chatHistoryError" role="alert"><p>{t(historyError === 'load' ? 'chat.historyLoadFailed' : 'chat.historySaveFailed')}</p><Button type="button" onClick={() => void (historyError === 'load' ? initializeChatHistory() : flushChatHistory())}>{t('chat.retry')}</Button></div>}
    <div className="chatWorkspace"><ChatHistory onSelect={choose}/><ChatSession key={selectedId} threadKey={selectedId} run={run} cloud={cloud} cloudMode={target?.provider !== 'local'} targetLabel={target?.label ?? ''} historyReady={historyReady && initialized !== false} controls={controls} onNew={newChat} onContinue={continueChat}/></div>
  </div>;
}

function ChatSession({ threadKey, run, cloud, cloudMode, targetLabel, historyReady, controls, onNew, onContinue }: {
  threadKey: string; run?: Run; cloud?: CloudTarget; cloudMode: boolean; targetLabel: string; historyReady: boolean; controls: ReactNode; onNew: () => void; onContinue: () => void;
}) {
  const { t } = useTranslation();
  const thread = useChatStore(state => state.threads[threadKey] ?? EMPTY_THREAD), update = useChatStore(state => state.update);
  const pending = thread.pending;
  const [mediaError, setMediaError] = useState(''), [mediaBusy, setMediaBusy] = useState(false);
  const ready = historyReady && (cloudMode ? !!cloud : !!run && ['ready', 'busy'].includes(run.info.state));
  // Dictated text joins the draft; the user reviews it before sending.
  const dictation = useChatDictation(text => update(threadKey, state => ({ ...state, draft: state.draft.trim() ? `${state.draft.trimEnd()} ${text}` : text })));
  const send = async () => {
    // Read the captured conversation again at submit time; drafts/streaming continue independently of history navigation.
    const current = useChatStore.getState().threads[threadKey] ?? EMPTY_THREAD, text = current.draft.trim();
    if (!threadKey || mediaBusy || !ready || (!text && !current.attachments?.length) || current.pending) return;
    if (text.length > 100_000 || current.messages.length >= 100) { update(threadKey, state => ({ ...state, error: 'limit' })); return; }
    stopReasoningTranslation(threadKey);
    let media;
    try { media = chatAttachmentPayload(current.attachments ?? []); if (!cloudMode && media.documents.length) throw new Error('pdf-local'); }
    catch (error) { setMediaError(String(error).replace(/^Error: /, '')); return; }
    const messages = [...current.messages.filter(message => message.content || message.images?.length || message.documents?.length), { role: 'user' as const, displayContent: text, content: [text, media.text].filter(Boolean).join('\n\n'), images: media.images, documents: media.documents, attachmentNames: current.attachments?.map(attachment => attachment.name) }];
    update(threadKey, state => ({ ...state, draft: '', attachments: [], error: '', stopped: false, messages: [...messages, { role: 'assistant', content: '' }] }));
    const plannedMax = run?.config?.smartTask?.request.max_tokens;
    const maxTokens = typeof plannedMax === 'number' ? Math.min(16384, Math.max(1, plannedMax)) : Math.min(4096, Math.max(1, Math.floor((run?.info.contextTokens ?? 16384) / 4) || 4096));
    const reasoningProvider = cloud ? cloud.provider ?? 'chatgpt' : 'local';
    const reasoning = reasoningFor(reasoningProvider, useChatReasoning.getState().levels[reasoningProvider]) || undefined;
    await startChatGeneration(threadKey, { reasoning, runId: run?.info.runId ?? '', generation: run?.info.generation ?? 0, messages, maxTokens, temperature: typeof run?.config?.smartTask?.request.temperature === 'number' ? run.config.smartTask.request.temperature : run?.config?.temperature ?? .6, ...(cloud ? { cloud } : {}) });
  };
  return <div className="chatPage">
    <header className="chatHeader"><div><h2>{t('chat.title')}</h2><span className="chatConnection">{targetLabel || (cloudMode ? t('openai.connectFirst') : run ? `${ENGINE_NAMES[run.info.engine]} · ${run.info.name}` : t('chat.noServer'))}</span></div><Button disabled={!historyReady || mediaBusy} onClick={onNew}><Plus size={15}/>{t('chat.new')}</Button></header>
    {!isTauri() && <div className="chatDemo">{t('chat.demo')}</div>}
    {historyReady && !ready && !!thread.messages.length && <div className="chatTargetUnavailable" role="status"><p>{t('chat.targetUnavailable')}</p><Button type="button" onClick={onContinue}>{t('chat.continueNew')}</Button></div>}
    <ChatTranscript threadKey={threadKey} messages={thread.messages} pending={pending} translating={thread.translating} error={thread.error} stopped={thread.stopped} ready={ready} cloudMode={cloudMode} runId={run?.info.runId} generation={run?.info.generation}/>
    <form className="chatComposer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {!ready && <p role="status">{t(!historyReady ? 'chat.historyLoading' : cloudMode ? 'openai.connectFirst' : 'chat.startServer')}</p>}
      <ChatInputExtras disabled={pending || !historyReady} items={thread.attachments ?? []} onChange={attachments => update(threadKey, state => ({ ...state, attachments }))} error={mediaError} onError={setMediaError} onBusy={setMediaBusy}/>
      <textarea aria-label={t('chat.input')} placeholder={t('chat.placeholder')} value={thread.draft} disabled={pending || !ready} rows={3} maxLength={100000} onChange={event => update(threadKey, state => ({ ...state, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
      <ChatDictationBar dictation={dictation}/>
      <div className="chatComposerControls">{controls}<ChatMicButton dictation={dictation} disabled={pending || !ready}/>{pending ? <Button type="button" onClick={() => stopChatGeneration(threadKey)}><Square size={15}/>{t('chat.stop')}</Button> : <Button className="primary" type="submit" disabled={mediaBusy || !ready || (!thread.draft.trim() && !thread.attachments?.length)}><Send size={15}/>{t('chat.send')}</Button>}</div>
    </form>
    <span className="chatLive" role="status">{pending ? t('chat.generating') : ''}</span>
  </div>;
}

interface TranscriptProps { threadKey: string; messages: ChatMessage[]; pending: boolean; translating: boolean; error: string; stopped: boolean; ready: boolean; cloudMode: boolean; runId?: string; generation?: number; }
// Draft changes never rerender Markdown, and stream updates rerender only the current answer.
const ChatTranscript = memo(function ChatTranscript({ messages, error, stopped, ...session }: TranscriptProps) {
  const { t } = useTranslation();
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true), wasPending = useRef(session.pending);
  useLayoutEffect(() => {
    if (session.pending && !wasPending.current) following.current = true;
    wasPending.current = session.pending;
    if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, session.pending]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !transcript.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
    observer.observe(transcript.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={transcript} className="chatMessages" role="log" aria-label={t('chat.messages')} aria-live="off" onScroll={event => {
    const node = event.currentTarget;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }}>
    {!messages.length && <div className="chatEmpty"><MessageSquare size={32}/><h3>{t('chat.empty')}</h3><p>{t(session.ready ? 'chat.emptyHint' : session.cloudMode ? 'openai.connectFirst' : 'chat.startServer')}</p></div>}
    {messages.map((message, index) => <ChatMessageRow key={index} message={message} index={index} {...session} isLast={index === messages.length - 1}/>)}
    {error && <p className="chatError" role="alert">{t(`chat.errors.${error}`)}</p>}
    {stopped && <p className="chatStopped" role="status">{t('chat.stopped')}</p>}
  </div>;
});
const ChatMessageRow = memo(function ChatMessageRow({ message, index, threadKey, pending, translating, ready, cloudMode, runId, generation, isLast }: Omit<TranscriptProps, 'messages' | 'error' | 'stopped'> & { message: ChatMessage; index: number; isLast: boolean }) {
  const { t } = useTranslation(), notify = useControlStore(state => state.notify);
  return <article className={`chatMessage is-${message.role}`}><header><b>{t(message.role === 'user' ? 'chat.you' : 'chat.assistant')}</b>{message.role === 'assistant' && message.content && <button type="button" className="kIconBtn" aria-label={t('chat.copy')} onClick={() => { void copyChatText(message.content).then(ok => notify(ok ? 'success' : 'error', t(ok ? 'chat.copied' : 'chat.copyFailed'))); }}><Copy size={14}/></button>}</header>
    <ReasoningText message={message} canTranslate={!cloudMode && ready && !pending && !translating} onTranslate={() => { if (runId && generation !== undefined) void translateReasoning(threadKey, index, { runId, generation }); }} onStop={() => stopReasoningTranslation(threadKey)}/>
    {pending && isLast && <div className="chatWaitingOrb"><ActivityOrb state={message.content ? 'composing' : 'connecting'}/><span>{t('chat.generating')}</span></div>}
    <MessageText text={message.displayContent ?? (message.content || (pending && isLast ? t('chat.waiting') : '—'))}/>
    {!!message.attachmentNames?.length && <p className="chatAttachmentNames">{message.attachmentNames.join(' · ')}</p>}
  </article>;
});
