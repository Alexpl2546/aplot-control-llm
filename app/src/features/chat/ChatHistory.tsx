import { AgentIcon } from '../agent/AgentIdentity';
import { History, Pencil, Search, Trash2, Check, X, Pin, Archive, ArchiveRestore, Download, Upload, MessageSquarePlus } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { Button } from '../../components/ui/Primitives';
import { exportChatFile, importChatFile } from '../../services/chatTransfer';
import { isTauri } from '../../services/tauri';
import { EMPTY_THREAD, isBlankThread, useChatStore } from './store';
import { savedConversation } from './historyModel';
import { parseChatHistoryImport, serializeChatHistoryJson, serializeChatHistoryMarkdown } from './historyTransfer';
import './history.css';

export interface ChatHistoryProject { id: string; name: string; }
export const ChatHistory = memo(function ChatHistory({ onSelect, projects }: { onSelect: (id: string) => void; projects?: readonly ChatHistoryProject[] }) {
  const { t, i18n } = useTranslation();
  const conversations = useChatStore(state => state.conversations), selectedId = useChatStore(state => state.selectedId);
  const ready = useChatStore(state => state.historyReady);
  const threads = useChatStore(state => state.threads);
  const [query, setQuery] = useState(''), [renaming, setRenaming] = useState(''), [title, setTitle] = useState('');
  const [showArchived, setShowArchived] = useState(false), [transferError, setTransferError] = useState('');
  const [projectFilter, setProjectFilter] = useState('*'), [dateFilter, setDateFilter] = useState<'7' | '30' | 'all'>('all');
  const importInput = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const cutoff = dateFilter === 'all' ? undefined : Date.now() - Number(dateFilter) * 24 * 60 * 60 * 1000;
    return Object.values(conversations).filter(item => (item.archivedAt !== undefined) === showArchived
      && (item.temporary || threads[item.id]?.messages.some(message => message.role === 'user'))
      && (projectFilter === '*' || (projectFilter === '__none__' ? !item.projectId : item.projectId === projectFilter))
      && (cutoff === undefined || item.updatedAt >= cutoff))
      .sort((a, b) => Number(b.pinnedAt !== undefined) - Number(a.pinnedAt !== undefined) || b.updatedAt - a.updatedAt)
      .filter(item => !search || `${item.title} ${item.target.label} ${(threads[item.id]?.messages ?? []).map(message => message.displayContent ?? message.content).join(' ')}`.toLocaleLowerCase().includes(search));
  }, [conversations, dateFilter, projectFilter, query, showArchived, threads]);
  const remove = (id: string) => {
    const state = useChatStore.getState(), conversation = state.conversations[id], thread = state.threads[id];
    if (!conversation) return;
    state.remove(id);
    if (useChatStore.getState().conversations[id]) return;
    useControlStore.getState().notifyAction('info', t('undo.chatDeleted', { title: conversation.title || t('chat.untitled') }), { label: t('undo.restore'), run: () => useChatStore.getState().restore(conversation, thread ?? { messages: [], draft: '', error: '', stopped: false, pending: false, translating: false }) }, 7000);
  };
  const rename = () => { if (!title.trim()) return; useChatStore.getState().rename(renaming, title); setRenaming(''); };
  const download = async (format: 'json' | 'markdown') => {
    setTransferError('');
    try {
      const state = useChatStore.getState();
      const saved = Object.values(state.conversations).flatMap(conversation => {
        if (conversation.temporary) return [];
        const thread = state.threads[conversation.id] ?? EMPTY_THREAD;
        return !isBlankThread(thread) || conversation.title ? [savedConversation(conversation, thread)] : [];
      });
      const data = { version: 1 as const, selectedId: state.conversations[state.selectedId]?.temporary ? '' : state.selectedId, conversations: saved };
      const body = format === 'json' ? serializeChatHistoryJson(data) : serializeChatHistoryMarkdown(data);
      await exportChatFile(format, body);
    } catch {
      setTransferError(t('chat.exportFailed', { defaultValue: 'Could not export chat history.' }));
    }
  };
  const importFile = async (file?: File) => {
    const native = isTauri();
    if (!file && !native) return;
    setTransferError('');
    try {
      const contents = native ? await importChatFile() : await file!.text();
      if (contents === undefined) return;
      const data = parseChatHistoryImport(contents);
      const count = useChatStore.getState().importConversations(data.conversations);
      useControlStore.getState().notify('success', t('chat.importSuccess', { defaultValue: `Imported ${count} conversations.` }));
    } catch (error) {
      const code = String(error).replace(/^Error: /, '');
      setTransferError(code === 'chat-import-limit' ? t('chat.importTooLarge', { defaultValue: 'This file is too large to import.' }) : t('chat.importInvalid', { defaultValue: 'This file is not a valid chat history export.' }));
    } finally { if (importInput.current) importInput.current.value = ''; }
  };
  const newTemporary = () => {
    const target = useChatStore.getState().conversations[useChatStore.getState().selectedId]?.target;
    if (!target) return;
    const id = useChatStore.getState().createTemporary(target);
    setShowArchived(false); setProjectFilter('*'); setDateFilter('all'); setQuery('');
    onSelect(id);
  };
  return <aside className="chatHistory" aria-label={t('chat.history')}>
    <header><History size={17}/><h2>{t('chat.history')}</h2><span>{items.length}</span><button type="button" className="kIconBtn" disabled={!ready || !conversations[selectedId]} aria-label={t('chat.newTemporary', { defaultValue: 'New temporary chat' })} title={t('chat.newTemporary', { defaultValue: 'New temporary chat' })} onClick={newTemporary}><MessageSquarePlus size={14}/></button><button type="button" className="kIconBtn" aria-label={t('chat.showArchived', { defaultValue: 'Archived conversations' })} aria-pressed={showArchived} title={t('chat.showArchived', { defaultValue: 'Archived conversations' })} onClick={() => setShowArchived(value => !value)}><Archive size={14}/></button></header>
    <div className="chatHistoryTransfer">
      <button type="button" className="kIconBtn" disabled={!ready} aria-label={t('chat.exportJson', { defaultValue: 'Export JSON' })} title={t('chat.exportJson', { defaultValue: 'Export JSON' })} onClick={() => download('json')}><Download size={13}/><small>JSON</small></button>
      <button type="button" className="kIconBtn" disabled={!ready} aria-label={t('chat.exportMarkdown', { defaultValue: 'Export Markdown' })} title={t('chat.exportMarkdown', { defaultValue: 'Export Markdown' })} onClick={() => download('markdown')}><Download size={13}/><small>MD</small></button>
      <button type="button" className="kIconBtn" disabled={!ready} aria-label={t('chat.importHistory', { defaultValue: 'Import history' })} title={t('chat.importHistory', { defaultValue: 'Import history' })} onClick={() => isTauri() ? void importFile() : importInput.current?.click()}><Upload size={13}/></button>
      <input ref={importInput} type="file" accept=".json,.md,.markdown,application/json,text/markdown" hidden disabled={!ready} onChange={event => void importFile(event.currentTarget.files?.[0])}/>
    </div>
    {transferError && <p className="chatHistoryTransferError" role="alert">{transferError}</p>}
    <label className="chatHistorySearch"><Search size={15}/><input type="search" aria-label={t('chat.historySearch')} placeholder={t('chat.historySearch')} value={query} onChange={event => setQuery(event.target.value)}/></label>
    {conversations[selectedId]?.temporary && <p className="chatHistoryTemporaryNotice" role="status">{t('chat.temporaryScope', { defaultValue: 'Temporary chats are excluded from Aplot history and exports. Your selected provider may retain its own records.' })}</p>}
    <div className="chatHistoryFilters">
      <label>{t('chat.historyDate', { defaultValue: 'Date' })}<select aria-label={t('chat.historyDate', { defaultValue: 'Date' })} value={dateFilter} onChange={event => setDateFilter(event.target.value as typeof dateFilter)}>
        <option value="all">{t('chat.historyAllDates', { defaultValue: 'All time' })}</option>
        <option value="7">{t('chat.historyLast7Days', { defaultValue: 'Last 7 days' })}</option>
        <option value="30">{t('chat.historyLast30Days', { defaultValue: 'Last 30 days' })}</option>
      </select></label>
      {projects && <label>{t('chat.historyProject', { defaultValue: 'Project' })}<select aria-label={t('chat.historyProject', { defaultValue: 'Project' })} value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
        <option value="*">{t('chat.historyAllProjects', { defaultValue: 'All projects' })}</option>
        <option value="__none__">{t('chat.historyNoProject', { defaultValue: 'No project' })}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>}
    </div>
    <div className="chatHistoryItems">
      {!items.length && <p className="chatHistoryEmpty">{t(!ready ? 'chat.historyLoading' : query || projectFilter !== '*' || dateFilter !== 'all' ? 'chat.historyNoResults' : 'chat.historyEmpty')}</p>}
      {items.map(item => <div className={`chatHistoryItem${selectedId === item.id ? ' is-selected' : ''}`} key={item.id}>
        {renaming === item.id ? <form className="chatHistoryRename" onSubmit={event => { event.preventDefault(); rename(); }}>
          <input autoFocus aria-label={t('chat.renameTitle')} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(''); }}/>
          <Button type="submit" disabled={!title.trim()} aria-label={t('chat.save')}><Check size={14}/></Button><Button type="button" aria-label={t('chat.cancel')} onClick={() => setRenaming('')}><X size={14}/></Button>
        </form> : <>
        <button type="button" className="chatHistorySelect" aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => onSelect(item.id)}>
            <b><AgentIcon runtime={item.target.provider==='chatgpt'?'codex':item.target.provider} size={14}/><span className="chatHistoryTitle">{item.title || t('chat.untitled')}</span>{item.temporary && <em>{t('chat.temporary', { defaultValue: 'Temporary' })}</em>}{item.pinnedAt !== undefined && <Pin size={12}/>}</b><span>{item.target.label || t('chat.noServer')}</span>
            <small>{new Intl.DateTimeFormat(i18n?.language || 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.updatedAt)}{item.branchParentId ? ` · ${t('chat.branch', { defaultValue: 'Branch' })}` : ''}{threads[item.id]?.pending ? ` · ${t('chat.generating')}` : ''}</small>
          </button>
          <div className="chatHistoryActions"><button type="button" className="kIconBtn" aria-label={`${t('chat.rename')}: ${item.title || t('chat.untitled')}`} onClick={() => { setRenaming(item.id); setTitle(item.title); }}><Pencil size={13}/></button>
            {!item.temporary && <><button type="button" className="kIconBtn" aria-label={`${t(item.pinnedAt !== undefined ? 'chat.unpin' : 'chat.pin', { defaultValue: item.pinnedAt !== undefined ? 'Unpin' : 'Pin' })}: ${item.title || t('chat.untitled')}`} title={t(item.pinnedAt !== undefined ? 'chat.unpin' : 'chat.pin', { defaultValue: item.pinnedAt !== undefined ? 'Unpin' : 'Pin' })} onClick={() => useChatStore.getState().pin(item.id, item.pinnedAt === undefined)}><Pin size={13}/></button>
            <button type="button" className="kIconBtn" aria-label={`${t(showArchived ? 'chat.unarchive' : 'chat.archive', { defaultValue: showArchived ? 'Restore' : 'Archive' })}: ${item.title || t('chat.untitled')}`} title={t(showArchived ? 'chat.unarchive' : 'chat.archive', { defaultValue: showArchived ? 'Restore' : 'Archive' })} onClick={() => useChatStore.getState().archive(item.id, !showArchived)}>{showArchived ? <ArchiveRestore size={13}/> : <Archive size={13}/>}</button></>}
            <button type="button" className="kIconBtn" disabled={threads[item.id]?.pending || threads[item.id]?.translating} aria-label={`${t('chat.delete')}: ${item.title || t('chat.untitled')}`} onClick={() => remove(item.id)}><Trash2 size={13}/></button></div>
        </>}
      </div>)}
    </div>
  </aside>;
});
