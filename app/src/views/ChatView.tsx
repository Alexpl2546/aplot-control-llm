import { AgentIcon } from '../features/agent/AgentIdentity';
import { ActivityOrb } from '../components/ui/ActivityOrb';
import { ChatInputExtras } from '../features/chat/ChatInputExtras';
import { ChatDictationBar, ChatMicButton, useChatDictation } from '../features/chat/ChatDictation';
import { ReasoningSelect, reasoningFor, useChatReasoning } from '../features/reasoning/reasoning';
import { cloudReasoningKey, localReasoningKey, reasoningProfile, useReasoningProfile } from '../features/reasoning/profiles';
import { chatAttachmentPayload, messageMedia, type ChatAttachment } from '../features/chat/media';
import { clipboardImages, readImageFile } from '../features/chat/clipboardImages';
import { MediaGallery, type MediaItem } from '../features/chat/MediaGallery';
import { CloudProfileSelect } from '../features/openai/CloudProfileSelect';
import { cloudSelection, useOpenAi } from '../features/openai/store';
import { MessageSquare, Plus, Send, Square, Copy, Pencil, GitBranch, RotateCcw } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../store/control';
import { Button } from '../components/ui/Primitives';
import { ChoiceSelect } from '../components/ui/ChoiceSelect';
import { EMPTY_THREAD, useChatStore } from '../features/chat/store';
import { initializeChatHistory, flushChatHistory } from '../features/chat/history';
import { ChatHistory } from '../features/chat/ChatHistory';
import { createChatMessageId, ensureChatMessageIds, type ChatTarget } from '../features/chat/historyModel';
import type { ChatMessage } from '../features/chat/stream';
import type { ChatRequest } from '../services/chat';
import { startChatGeneration, stopChatGeneration, translateReasoning, stopReasoningTranslation } from '../features/chat/generation';
import { isTauri } from '../services/tauri';
import { ENGINE_NAMES } from '../lib/engineModels';
import { MessageText } from '../features/chat/MessageText';
import { RichContent } from '../features/chat/RichContent';
import { ChatOptions } from '../features/chat/ChatOptions';
import { chatInstructions, loadChatPreferences } from '../features/chat/preferences';
import { initializeWorkspace, useWorkspaceStore } from '../features/agent/workspace';
import { ReasoningText } from '../features/chat/ReasoningText';
import { copyChatText } from '../features/chat/clipboard';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { canStartChatRun, ensureChatRun, type ChatRun, type StartupStage } from '../features/chat/startup';

type Run = ReturnType<typeof useControlStore.getState>['runs'][number];
type Provider = 'local' | 'chatgpt' | 'claude';
type CloudTarget = NonNullable<ChatRequest['cloud']>;

const pendingBranchRegenerations = new Set<string>();

function localTarget(run?: Run): ChatTarget {
  return { provider: 'local', runId: run?.info.runId ?? '', generation: run?.info.generation ?? 0, label: run?.info.name ?? '', engine: run?.info.engine, modelId: run?.info.modelId, startedAt: run?.info.startedAt };
}
function configuredTarget(provider: Provider, run?: Run, profileId = useOpenAi.getState().chatProfileId, model?: string): ChatTarget {
  if (provider === 'local') return localTarget(run);
  const state = useOpenAi.getState(), selection = cloudSelection(state, provider === 'claude' ? 'claude' : 'openai', undefined, profileId, 'chat');
  const preferred = model ?? (provider === 'claude' ? state.claudeChatModel : state.chatModel);
  const selectedModel = selection.models.some(item => item.model === preferred) ? preferred : selection.models[0]?.model ?? '';
  const label = provider === 'claude' ? 'Claude' : selection.profile?.authMode === 'apiKey' ? 'OpenAI API' : 'ChatGPT';
  return { provider, connectionId: selection.status.connectionId ?? '', profileId: selection.profile?.id ?? profileId, model: selectedModel, label: `${label}${selectedModel ? ` · ${selectedModel}` : ''}` };
}

export function ChatView() {
  const { t } = useTranslation();
  const projects = useWorkspaceStore(state => state.projects);
  const runs = useControlStore(state => state.runs), selectedRunId = useControlStore(state => state.selectedRunId);
  const selectRun = useControlStore(state => state.selectRun), cloudState = useOpenAi();
  const selectedId = useChatStore(state => state.selectedId), conversations = useChatStore(state => state.conversations);
  const historyReady = useChatStore(state => state.historyReady), historyError = useChatStore(state => state.historyError);
  const initialized = useControlStore(state => state.initialized);
  const provider = cloudState.chatProvider, selectedRun = runs.find(item => item.info.runId === selectedRunId);
  const selection = cloudSelection(cloudState, provider === 'claude' ? 'claude' : 'openai', undefined, cloudState.chatProfileId, 'chat');
  const preferred = provider === 'claude' ? cloudState.claudeChatModel : cloudState.chatModel;
  const selectedModel = selection.models.some(item => item.model === preferred) ? preferred : selection.models[0]?.model ?? '';
  const conversation = conversations[selectedId];
  const target = conversation?.target;
  // Restored history resolves its own exact target. Current selectors can never silently redirect an old conversation.
  const run = target?.provider === 'local' ? runs.find(item => item.info.runId === target.runId && item.info.generation === target.generation && item.info.modelId === target.modelId && item.info.startedAt === target.startedAt) : undefined;
  const connected = target && target.provider !== 'local' ? cloudSelection(cloudState, target.provider === 'claude' ? 'claude' : 'openai', target.connectionId, target.profileId, 'chat') : undefined;
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
    const id = conversation.temporary ? previous.createTemporary(configuredTarget(provider, selectedRun)) : previous.create(configuredTarget(provider, selectedRun));
    previous.update(id, () => ({ ...structuredClone(source), pending: false, translating: false, stopped: false, error: '' }));
    useChatStore.setState(state => ({ conversations: { ...state.conversations, [id]: { ...state.conversations[id], projectId: conversation.temporary ? undefined : conversation.projectId, instructions: conversation.instructions, webSearch: conversation.webSearch, branchParentId: conversation.id, branchFromMessageId: source.messages.at(-1)?.id } } }));
    if (conversation.title) previous.rename(id, conversation.title);
    choose(id);
  };
  const reasoningLevels = useChatReasoning(state => state.levels), setReasoning = useChatReasoning(state => state.set);
  const chatProfile = useReasoningProfile(provider === 'local' ? localReasoningKey((run ?? selectedRun)?.config?.modelPath) : cloudReasoningKey(provider === 'claude' ? 'claude' : 'codex', selection.status.connectionId, selectedModel));
  const controls = <>
    {provider !== 'local' ? <><CloudProfileSelect provider={provider === 'claude' ? 'claude' : 'openai'} profileId={cloudState.chatProfileId} purpose="chat" onChange={id => { useOpenAi.setState({ chatProfileId: id }); activate(provider, selectedRun, id); }}/><ChoiceSelect variant="model" label={t('openai.model')} value={selectedModel} options={selection.models.map(item => ({ value: item.model, label: item.displayName, description: item.model, keywords: item.defaultReasoningEffort }))} onChange={model => { useOpenAi.setState(provider === 'claude' ? { claudeChatModel: model } : { chatModel: model }); activate(provider, selectedRun, cloudState.chatProfileId, model); }}/></>
      : <ChoiceSelect label={t('chat.server')} value={selectedRun?.info.runId ?? ''} options={runs.map(item => ({ value: item.info.runId, label: item.info.name }))} onChange={id => { selectRun(id); activate('local', runs.find(item => item.info.runId === id)); }}/>}
    <ReasoningSelect provider={provider} profile={chatProfile} value={reasoningLevels[provider]} onChange={level => setReasoning(provider, level)}/>
  </>;
  return <div className="chatRoute">
    <div className="oaChatSwitch"><button type="button" disabled={!historyReady} aria-pressed={provider === 'local'} onClick={() => activate('local')}><AgentIcon runtime="local"/>{t('openai.localModels')}</button><button type="button" disabled={!historyReady} aria-pressed={provider === 'chatgpt'} onClick={() => activate('chatgpt')}><AgentIcon runtime="codex"/>ChatGPT</button><button type="button" disabled={!historyReady} aria-pressed={provider === 'claude'} onClick={() => activate('claude')}><AgentIcon runtime="claude"/>Claude</button></div>
    {historyError && <div className="chatHistoryError" role="alert"><p>{t(historyError === 'load' ? 'chat.historyLoadFailed' : 'chat.historySaveFailed')}</p><Button type="button" onClick={() => void (historyError === 'load' ? initializeChatHistory() : flushChatHistory())}>{t('chat.retry')}</Button></div>}
    <div className="chatWorkspace"><ChatHistory onSelect={choose} projects={projects}/><ChatSession key={selectedId} threadKey={selectedId} run={run} cloud={cloud} cloudMode={target?.provider !== 'local'} targetLabel={target?.label ?? ''} historyReady={historyReady && initialized !== false} controls={controls} onNew={newChat} onContinue={continueChat}/></div>
  </div>;
}

function ChatSession({ threadKey, run, cloud, cloudMode, targetLabel, historyReady, controls, onNew, onContinue }: {
  threadKey: string; run?: Run; cloud?: CloudTarget; cloudMode: boolean; targetLabel: string; historyReady: boolean; controls: ReactNode; onNew: () => void; onContinue: () => void;
}) {
  const { t } = useTranslation();
  const thread = useChatStore(state => state.threads[threadKey] ?? EMPTY_THREAD), update = useChatStore(state => state.update);
  const pending = thread.pending;
  const [mediaError, setMediaError] = useState(''), [mediaBusy, setMediaBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const attachmentBusy = mediaBusy || libraryBusy;
  const [starting, setStarting] = useState<StartupStage>(), [startupError, setStartupError] = useState('');
  const [release, setRelease] = useState<ChatRun[]>();
  const releaseReply = useRef<(approved: boolean) => void>(undefined);
  const startupAbort = useRef<AbortController>(undefined), submitting = useRef(false);
  const answerRelease = (approved: boolean) => { releaseReply.current?.(approved); releaseReply.current = undefined; setRelease(undefined); };
  useEffect(() => () => { startupAbort.current?.abort(); releaseReply.current?.(false); }, []);
  const ready = historyReady && (cloudMode ? !!cloud : !!run && ['ready', 'busy'].includes(run.info.state));
  const available = historyReady && (cloudMode ? !!cloud : ready || canStartChatRun(run));
  // Dictated text joins the draft; the user reviews it before sending.
  const dictation = useChatDictation(text => update(threadKey, state => ({ ...state, draft: state.draft.trim() ? `${state.draft.trimEnd()} ${text}` : text })));
  const pasteImages = async (files: File[]) => {
    if (attachmentBusy || submitting.current) return;
    setMediaBusy(true); setMediaError('');
    try {
      const added = await Promise.all(files.map(async file => ({ id: crypto.randomUUID(), name: file.name || 'clipboard.png', kind: 'image' as const, data: await readImageFile(file) })));
      const current = useChatStore.getState().threads[threadKey] ?? EMPTY_THREAD;
      if ((current.attachments?.length ?? 0) + added.length > 8) throw new Error('attachment-limit');
      update(threadKey, state => ({ ...state, attachments: [...(state.attachments ?? []), ...added] }));
    } catch (error) { setMediaError(String(error).replace(/^Error: /, '')); }
    finally { setMediaBusy(false); }
  };
  const attachLibraryFile = useCallback((attachment: ChatAttachment) => {
    const state = useChatStore.getState(), current = state.threads[threadKey];
    if (state.selectedId !== threadKey || !current || current.pending || submitting.current) throw new Error('conversation-unavailable');
    if ((current.attachments?.length ?? 0) >= 8) throw new Error('attachment-limit');
    state.update(threadKey, thread => ({ ...thread, attachments: [...(thread.attachments ?? []), attachment] }));
  }, [threadKey]);
  const generateReply = async (request: ChatMessage[], clearComposer = false) => {
    const current = useChatStore.getState().threads[threadKey] ?? EMPTY_THREAD;
    if (!threadKey || !available || current.pending || submitting.current || request.length > 100) return;
    stopReasoningTranslation(threadKey);
    submitting.current = true;
    setStartupError('');
    let activeRun = run;
    try {
    await loadChatPreferences();
    const conversation = useChatStore.getState().conversations[threadKey];
    if (conversation?.projectId) await initializeWorkspace();
    const instructions = chatInstructions(conversation ?? {});
    const webSearch = !!conversation?.webSearch;
    if (webSearch && (!cloud || cloud.provider === 'claude')) throw new Error('unsupported');
    if (!cloudMode) {
      const abort = new AbortController(); startupAbort.current = abort;
      if (!ready) setStarting('checking');
      activeRun = await ensureChatRun(threadKey, proposed => new Promise<boolean>(resolve => {
        releaseReply.current = resolve; setRelease(proposed);
      }), abort.signal, setStarting);
      if (abort.signal.aborted) return;
    }
    setStarting(undefined);
    const messages = ensureChatMessageIds(request);
    update(threadKey, state => ({ ...state, draft: clearComposer ? '' : state.draft, attachments: clearComposer ? [] : state.attachments, error: '', stopped: false, messages: [...messages, { role: 'assistant', id: createChatMessageId(), content: '' }] }));
    const plannedMax = activeRun?.config?.smartTask?.request.max_tokens;
    const maxTokens = typeof plannedMax === 'number' ? Math.min(16384, Math.max(1, plannedMax)) : Math.min(4096, Math.max(1, Math.floor((activeRun?.info.contextTokens ?? 16384) / 4) || 4096));
    const reasoningProvider = cloud ? cloud.provider ?? 'chatgpt' : 'local';
    const profile = reasoningProfile(cloud ? cloudReasoningKey(cloud.provider === 'claude' ? 'claude' : 'codex', cloud.connectionId, cloud.model) : localReasoningKey(activeRun?.config?.modelPath));
    const reasoning = reasoningFor(reasoningProvider, useChatReasoning.getState().levels[reasoningProvider], profile) || undefined;
    await startChatGeneration(threadKey, { reasoning, instructions, webSearch, runId: activeRun?.info.runId ?? '', generation: activeRun?.info.generation ?? 0, messages, maxTokens, temperature: typeof activeRun?.config?.smartTask?.request.temperature === 'number' ? activeRun.config.smartTask.request.temperature : activeRun?.config?.temperature ?? .6, ...(cloud ? { cloud } : {}) });
    } catch (error) {
      const code = String(error).replace(/^Error: /, '');
      if (code !== 'cancelled') setStartupError(t(`chat.errors.${code}`, { defaultValue: `${t('chat.startFailed')} ${code}` }));
    } finally { submitting.current = false; setStarting(undefined); startupAbort.current = undefined; }
  };
  const send = async () => {
    // Read the captured conversation again at submit time; drafts/streaming continue independently of history navigation.
    const current = useChatStore.getState().threads[threadKey] ?? EMPTY_THREAD, text = current.draft.trim();
    if (!threadKey || attachmentBusy || !available || (!text && !current.attachments?.length) || current.pending || submitting.current) return;
    if (text.length > 100_000 || current.messages.length >= 100) { update(threadKey, state => ({ ...state, error: 'limit' })); return; }
    let media;
    try {
      media = chatAttachmentPayload(current.attachments ?? []);
      if (!cloudMode && media.documents.length) throw new Error('pdf-local');
      if (new TextEncoder().encode([text, media.text].filter(Boolean).join('\n\n')).length > 400_000) throw new Error('attachment-limit');
    }
    catch (error) { setMediaError(String(error).replace(/^Error: /, '')); return; }
    const messages = ensureChatMessageIds([
      ...current.messages.filter(message => message.content || message.images?.length || message.documents?.length),
      { role: 'user' as const, id: createChatMessageId(), displayContent: text, content: [text, media.text].filter(Boolean).join('\n\n'), attachmentText: media.text || undefined,
        images: media.images, documents: media.documents, media: messageMedia(current.attachments ?? []), attachmentNames: current.attachments?.map(attachment => attachment.name) },
    ]);
    await generateReply(messages, true);
  };
  useEffect(() => {
    if (!pendingBranchRegenerations.delete(threadKey)) return;
    const branch = useChatStore.getState().threads[threadKey];
    if (branch) void generateReply(branch.messages);
  }, [threadKey]);
  const forkMessage = useCallback((messageId: string) => { useChatStore.getState().forkFromMessage(threadKey, messageId, 'through'); }, [threadKey]);
  const editMessage = useCallback((messageId: string) => { useChatStore.getState().forkFromMessage(threadKey, messageId, 'edit'); }, [threadKey]);
  const regenerateMessage = useCallback((messageId: string) => {
    const branchId = useChatStore.getState().forkFromMessage(threadKey, messageId, 'regenerate');
    if (branchId) pendingBranchRegenerations.add(branchId);
  }, [threadKey]);
  return <div className="chatPage">
    <header className="chatHeader"><div><h2>{t('chat.title')}</h2><span className="chatConnection">{targetLabel || (cloudMode ? t('openai.connectFirst') : run ? `${ENGINE_NAMES[run.info.engine]} · ${run.info.name}` : t('chat.noServer'))}</span></div><Button disabled={!historyReady || attachmentBusy} onClick={onNew}><Plus size={15}/>{t('chat.new')}</Button></header>
    {!isTauri() && <div className="chatDemo">{t('chat.demo')}</div>}
    {historyReady && !available && !starting && !!thread.messages.length && <div className="chatTargetUnavailable" role="status"><p>{t('chat.targetUnavailable')}</p><Button type="button" onClick={onContinue}>{t('chat.continueNew')}</Button></div>}
    <ChatTranscript threadKey={threadKey} messages={thread.messages} pending={pending} translating={thread.translating} error={thread.error} stopped={thread.stopped} ready={ready} canAutoStart={available && !ready} cloudMode={cloudMode} runId={run?.info.runId} generation={run?.info.generation} onFork={forkMessage} onEdit={editMessage} onRegenerate={regenerateMessage}/>
    <form className="chatComposer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <ChatOptions conversationId={threadKey} disabled={pending || !!starting || mediaBusy || !historyReady} onAttach={attachLibraryFile} onLibraryBusy={setLibraryBusy}/>
      {starting ? <p role="status">{t(`chat.startup.${starting}`)}</p> : !ready && <p role="status">{t(!historyReady ? 'chat.historyLoading' : cloudMode ? 'openai.connectFirst' : available ? 'chat.autoStartHint' : 'chat.startServer')}</p>}
      {startupError && <p className="chatError" role="alert">{startupError}</p>}
      <ChatInputExtras disabled={pending || !!starting || !historyReady || libraryBusy} items={thread.attachments ?? []} onChange={attachments => update(threadKey, state => ({ ...state, attachments }))} error={mediaError} onError={setMediaError} onBusy={setMediaBusy}/>
      <textarea aria-label={t('chat.input')} placeholder={t('chat.placeholder')} value={thread.draft} disabled={pending || !!starting || !available} rows={3} maxLength={100000} onPaste={event => { const files = clipboardImages(event.clipboardData); if (files.length) { event.preventDefault(); void pasteImages(files); } }} onChange={event => update(threadKey, state => ({ ...state, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
      <ChatDictationBar dictation={dictation}/>
      <div className="chatComposerControls">{controls}<ChatMicButton dictation={dictation} disabled={pending || !!starting || !available}/>{starting ? <Button type="button" onClick={() => { startupAbort.current?.abort(); answerRelease(false); }}><Square size={15}/>{t('actions.cancel')}</Button> : pending ? <Button type="button" onClick={() => stopChatGeneration(threadKey)}><Square size={15}/>{t('chat.stop')}</Button> : <Button className="primary" type="submit" disabled={attachmentBusy || !available || (!thread.draft.trim() && !thread.attachments?.length)}><Send size={15}/>{t('chat.send')}</Button>}</div>
    </form>
    <span className="chatLive" role="status">{pending ? t('chat.generating') : ''}</span>
    <ConfirmDialog open={!!release} title={t('chat.releaseMemoryTitle')} text={t('chat.releaseMemoryText', { names: release?.map(item => item.info.name).join(', ') ?? '' })} confirmLabel={t('chat.releaseMemoryConfirm')} dangerous onCancel={() => answerRelease(false)} onConfirm={() => answerRelease(true)}/>
  </div>;
}

interface TranscriptProps {
  threadKey: string; messages: ChatMessage[]; pending: boolean; translating: boolean; error: string; stopped: boolean; ready: boolean; canAutoStart?: boolean; cloudMode: boolean; runId?: string; generation?: number;
  onFork: (messageId: string) => void; onEdit: (messageId: string) => void; onRegenerate: (messageId: string) => void;
}
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
    {!messages.length && <div className="chatEmpty"><MessageSquare size={32}/><h3>{t('chat.empty')}</h3><p>{t(session.ready ? 'chat.emptyHint' : session.cloudMode ? 'openai.connectFirst' : session.canAutoStart ? 'chat.autoStartHint' : 'chat.startServer')}</p></div>}
    {messages.map((message, index) => <ChatMessageRow key={message.id ?? index} message={message} index={index} {...session} error={error} isLast={index === messages.length - 1}/>)}
    {error && <p className="chatError" role="alert">{t(session.cloudMode && error === 'failed' ? 'chat.cloudFailed' : `chat.errors.${error}`)}</p>}
    {stopped && <p className="chatStopped" role="status">{t('chat.stopped')}</p>}
  </div>;
});
const ChatMessageRow = memo(function ChatMessageRow({ message, index, threadKey, pending, translating, ready, canAutoStart, cloudMode, runId, generation, error, isLast, onFork, onEdit, onRegenerate }: Omit<TranscriptProps, 'messages' | 'stopped'> & { message: ChatMessage; index: number; isLast: boolean }) {
  const { t } = useTranslation(), notify = useControlStore(state => state.notify);
  const media: MediaItem[] = message.media?.length ? message.media.map((item, i) => ({ id: String(i), name: item.name, kind: item.kind,
    ...(item.kind === 'image' ? { data: message.images?.[item.imageIndex] } : { path: item.path, poster: message.images?.[item.imageIndex] }) }))
    : (message.images ?? []).map((data, i) => ({ id: String(i), kind: 'image', name: message.attachmentNames?.[i] ?? `${i + 1}`, data }));
  const workflowReady = (ready || !!canAutoStart) && !pending && !translating && !!message.id;
  return <article className={`chatMessage is-${message.role}`} data-message-id={message.id}><header><b>{t(message.role === 'user' ? 'chat.you' : 'chat.assistant')}</b>{message.role === 'assistant' && message.content && <button type="button" className="kIconBtn" aria-label={t('chat.copy')} onClick={() => { void copyChatText(message.content).then(ok => notify(ok ? 'success' : 'error', t(ok ? 'chat.copied' : 'chat.copyFailed'))); }}><Copy size={14}/></button>}</header>
    {workflowReady && <div className="chatMessageActions">
      {message.role === 'user' && <button type="button" className="kIconBtn" aria-label={t('chat.editAndResend', { defaultValue: 'Edit and resend in a new branch' })} title={t('chat.editAndResend', { defaultValue: 'Edit and resend in a new branch' })} onClick={() => onEdit(message.id!)}><Pencil size={13}/></button>}
      <button type="button" className="kIconBtn" aria-label={t('chat.forkFromHere', { defaultValue: 'Fork from here' })} title={t('chat.forkFromHere', { defaultValue: 'Fork from here' })} onClick={() => onFork(message.id!)}><GitBranch size={13}/></button>
      {message.role === 'assistant' && <button type="button" className="kIconBtn" aria-label={t(error && isLast ? 'chat.retry' : 'chat.regenerate', { defaultValue: error && isLast ? 'Retry in a new branch' : 'Regenerate in a new branch' })} title={t(error && isLast ? 'chat.retry' : 'chat.regenerate', { defaultValue: error && isLast ? 'Retry in a new branch' : 'Regenerate in a new branch' })} onClick={() => onRegenerate(message.id!)}><RotateCcw size={13}/></button>}
    </div>}
    <ReasoningText message={message} canTranslate={!cloudMode && ready && !pending && !translating} onTranslate={() => { if (runId && generation !== undefined) void translateReasoning(threadKey, index, { runId, generation }); }} onStop={() => stopReasoningTranslation(threadKey)}/>
    {pending && isLast && <div className="chatWaitingOrb"><ActivityOrb state={message.content ? 'composing' : 'connecting'}/><span>{t('chat.generating')}</span></div>}
    <MessageText text={message.displayContent ?? (message.content || (pending && isLast ? t('chat.waiting') : '—'))}/>
    <MediaGallery items={media}/>
    <RichContent blocks={message.blocks}/>
    {message.usage && <p className="chatGenerationSpeed">{t('chatTools.usage', { defaultValue: 'Tokens' })}: {message.usage.totalTokens ?? '—'} · {t('chatTools.input', { defaultValue: 'Input' })}: {message.usage.inputTokens ?? '—'} · {t('chatTools.output', { defaultValue: 'Output' })}: {message.usage.outputTokens ?? '—'}</p>}
    {!!message.attachmentNames?.length && <p className="chatAttachmentNames">{message.attachmentNames.join(' · ')}</p>}
    {message.role === 'assistant' && (message.generationTps !== undefined || pending && isLast && !cloudMode) && <footer className="chatGenerationSpeed" aria-label={t('chat.generationSpeed')} title={t('chat.generationSpeed')}>
      {message.generationTps !== undefined ? message.generationTps.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'} {t('chat.tokensPerSecond')}
    </footer>}
  </article>;
});
