import { AgentIcon } from '../agent/AgentIdentity';
import { History, Pencil, Search, Trash2, Check, X } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { Button } from '../../components/ui/Primitives';
import { isBlankThread, useChatStore } from './store';
import './history.css';

export const ChatHistory = memo(function ChatHistory({ onSelect }: { onSelect: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const conversations = useChatStore(state => state.conversations), selectedId = useChatStore(state => state.selectedId);
  const ready = useChatStore(state => state.historyReady);
  const threads = useChatStore(state => state.threads);
  const [query, setQuery] = useState(''), [renaming, setRenaming] = useState(''), [title, setTitle] = useState('');
  const items = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return Object.values(conversations).filter(item => !isBlankThread(threads[item.id]) || item.title).sort((a, b) => b.updatedAt - a.updatedAt).filter(item => !search || `${item.title} ${item.target.label} ${(threads[item.id]?.messages ?? []).map(message => message.displayContent ?? message.content).join(' ')}`.toLocaleLowerCase().includes(search));
  }, [conversations, query, threads]);
  const remove = (id: string) => {
    const state = useChatStore.getState(), conversation = state.conversations[id], thread = state.threads[id];
    if (!conversation) return;
    state.remove(id);
    if (useChatStore.getState().conversations[id]) return;
    useControlStore.getState().notifyAction('info', t('undo.chatDeleted', { title: conversation.title || t('chat.untitled') }), { label: t('undo.restore'), run: () => useChatStore.getState().restore(conversation, thread ?? { messages: [], draft: '', error: '', stopped: false, pending: false, translating: false }) }, 7000);
  };
  const rename = () => { if (!title.trim()) return; useChatStore.getState().rename(renaming, title); setRenaming(''); };
  return <aside className="chatHistory" aria-label={t('chat.history')}>
    <header><History size={17}/><h2>{t('chat.history')}</h2><span>{Object.values(conversations).filter(item => !isBlankThread(threads[item.id]) || item.title).length}</span></header>
    <label className="chatHistorySearch"><Search size={15}/><input type="search" aria-label={t('chat.historySearch')} placeholder={t('chat.historySearch')} value={query} onChange={event => setQuery(event.target.value)}/></label>
    <div className="chatHistoryItems">
      {!items.length && <p className="chatHistoryEmpty">{t(!ready ? 'chat.historyLoading' : query ? 'chat.historyNoResults' : 'chat.historyEmpty')}</p>}
      {items.map(item => <div className={`chatHistoryItem${selectedId === item.id ? ' is-selected' : ''}`} key={item.id}>
        {renaming === item.id ? <form className="chatHistoryRename" onSubmit={event => { event.preventDefault(); rename(); }}>
          <input autoFocus aria-label={t('chat.renameTitle')} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(''); }}/>
          <Button type="submit" disabled={!title.trim()} aria-label={t('chat.save')}><Check size={14}/></Button><Button type="button" aria-label={t('chat.cancel')} onClick={() => setRenaming('')}><X size={14}/></Button>
        </form> : <>
          <button type="button" className="chatHistorySelect" aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => onSelect(item.id)}>
            <b><AgentIcon runtime={item.target.provider==='chatgpt'?'codex':item.target.provider} size={14}/><span>{item.title || t('chat.untitled')}</span></b><span>{item.target.label || t('chat.noServer')}</span>
            <small>{new Intl.DateTimeFormat(i18n?.language || 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.updatedAt)}{threads[item.id]?.pending ? ` · ${t('chat.generating')}` : ''}</small>
          </button>
          <div className="chatHistoryActions"><button type="button" className="kIconBtn" aria-label={`${t('chat.rename')}: ${item.title || t('chat.untitled')}`} onClick={() => { setRenaming(item.id); setTitle(item.title); }}><Pencil size={13}/></button><button type="button" className="kIconBtn" disabled={threads[item.id]?.pending || threads[item.id]?.translating} aria-label={`${t('chat.delete')}: ${item.title || t('chat.untitled')}`} onClick={() => remove(item.id)}><Trash2 size={13}/></button></div>
        </>}
      </div>)}
    </div>
  </aside>;
});
