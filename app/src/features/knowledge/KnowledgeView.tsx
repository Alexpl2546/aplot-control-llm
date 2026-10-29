import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ExternalLink, FileText, FolderPlus, Hash, Link2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState, SectionTitle } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { pickDirectory } from '../../services/dialog';
import { openExternalUrl } from '../../services/desktop';
import { knowledgeBind, knowledgeOpenObsidian, knowledgeRead, knowledgeReindex, knowledgeSearch, knowledgeStatus, knowledgeUnbind, type KnowledgeHit, type KnowledgeNote, type KnowledgeStatus, type KnowledgeVaultStatus } from '../../services/knowledge';
import { initializeWorkspace, useWorkspaceStore } from '../agent/workspace';
import { NOTE_LINK, foldText, highlightParts, knowledgeErrorKey, linkCandidates, stemOf, wikiToMarkdown } from './knowledgeModel';
import './knowledge.css';

const plugins = [remarkGfm];

function Highlighted({ text, query }: { text: string; query: string }) {
  return <>{highlightParts(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}

function VaultRow({ row, onReindex, onRemove }: { row: KnowledgeVaultStatus; onReindex: () => void; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  const state = row.state === 'indexing' ? t('knowledge.state.indexing') : row.state === 'missing' ? t('knowledge.state.missing') : row.state === 'error' ? t('knowledge.state.error') : t('knowledge.notes', { count: row.documents });
  return <li className={`knVault is-${row.state}`}>
    <span className="knVaultLed" aria-hidden="true"/>
    <span className="knVaultText"><b title={row.vault.path}>{row.vault.name}</b><small title={row.vault.path}>{row.vault.path}</small>
      <small className="knVaultState" role={row.state === 'indexing' ? 'status' : undefined}>{state}{row.state === 'ready' && row.indexedAt ? ` · ${new Date(row.indexedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}` : ''}{!row.obsidian && ` · ${t('knowledge.notObsidian')}`}</small></span>
    <button type="button" className="kIconBtn" title={t('knowledge.reindex')} aria-label={t('knowledge.reindexVault', { name: row.vault.name })} onClick={onReindex}><RefreshCw size={14}/></button>
    <button type="button" className="kIconBtn" title={t('knowledge.disconnect')} aria-label={t('knowledge.disconnectVault', { name: row.vault.name })} onClick={onRemove}><Trash2 size={14}/></button>
  </li>;
}

export function KnowledgeView() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<KnowledgeStatus>();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<{ vaultId: string; path: string; line?: number }>();
  const [note, setNote] = useState<KnowledgeNote>();
  const [error, setError] = useState('');
  const [scope, setScope] = useState('all');
  const projects = useWorkspaceStore(s => s.projects);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchVersion = useRef(0);

  const refresh = useCallback(async () => {
    try { setStatus(await knowledgeStatus()); } catch (e) { setError(t(knowledgeErrorKey(e))); }
  }, [t]);
  useEffect(() => { void initializeWorkspace(); void refresh(); }, [refresh]);
  const indexing = !!status?.vaults.some(v => v.state === 'indexing');
  // External edits reach the index through the watcher; polling shows them here.
  useEffect(() => { const timer = setInterval(() => void refresh(), indexing ? 1000 : 4000); return () => clearInterval(timer); }, [indexing, refresh]);

  const vaultIds = useMemo(() => {
    if (scope === 'all') return undefined;
    return projects.find(p => p.id === scope)?.knowledge ?? [];
  }, [scope, projects]);
  const freshness = status?.vaults.map(v => `${v.vault.id}:${v.indexedAt ?? ''}:${v.documents}`).join('|') ?? '';

  useEffect(() => {
    const version = ++searchVersion.current;
    if (!query.trim()) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void knowledgeSearch(query, vaultIds).then(rows => { if (version === searchVersion.current) setHits(rows); })
        .catch(e => { if (version === searchVersion.current) setError(t(knowledgeErrorKey(e))); })
        .finally(() => { if (version === searchVersion.current) setSearching(false); });
    }, 180);
    return () => clearTimeout(timer);
  }, [query, vaultIds, freshness, t]);

  useEffect(() => {
    if (!selected) { setNote(undefined); return; }
    let current = true;
    knowledgeRead(selected.vaultId, selected.path).then(view => { if (current) { setNote(view); setError(''); } })
      .catch(e => { if (current) { setNote(undefined); setError(t(knowledgeErrorKey(e))); } });
    return () => { current = false; };
  }, [selected, freshness, t]);

  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [selected?.path, selected?.vaultId]);

  const connect = async () => {
    setError('');
    try {
      const path = await pickDirectory();
      if (!path) return;
      await knowledgeBind(path);
      await refresh();
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  const remove = async (row: KnowledgeVaultStatus) => {
    try {
      await knowledgeUnbind(row.vault.id);
      for (const project of useWorkspaceStore.getState().projects) {
        if (project.knowledge?.includes(row.vault.id)) useWorkspaceStore.setState(s => ({ projects: s.projects.map(p => p.id === project.id ? { ...p, knowledge: p.knowledge?.filter(id => id !== row.vault.id) } : p) }));
      }
      if (selected?.vaultId === row.vault.id) setSelected(undefined);
      await refresh();
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  const openLinked = async (target: string) => {
    if (!note) return;
    for (const path of linkCandidates(target, note.path)) {
      try { await knowledgeRead(note.vaultId, path); setSelected({ vaultId: note.vaultId, path }); return; } catch { /* try the next candidate */ }
    }
    const stem = foldText(stemOf(target.split('#')[0]));
    const match = (await knowledgeSearch(stemOf(target.split('#')[0]), [note.vaultId], 50).catch(() => [])).find(hit => foldText(stemOf(hit.path)) === stem || foldText(hit.title) === stem);
    if (match) setSelected({ vaultId: match.vaultId, path: match.path });
    else setError(t('knowledge.linkMissing', { name: target }));
  };
  const openObsidian = async () => {
    if (!note) return;
    try { await knowledgeOpenObsidian(note.vaultId, note.path); } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };

  const components: Components = {
    a: ({ href, children }) => {
      const url = href ?? '';
      if (url.startsWith(NOTE_LINK)) return <a href={url} className="knWikiLink" onClick={event => { event.preventDefault(); void openLinked(decodeURIComponent(url.slice(NOTE_LINK.length))); }}>{children}</a>;
      if (/^(https?:|mailto:)/i.test(url)) return <a href={url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); void openExternalUrl(url); }}>{children}</a>;
      if (url && !url.includes(':') && !url.startsWith('#')) return <a href={url} className="knWikiLink" onClick={event => { event.preventDefault(); void openLinked(decodeURIComponent(url)); }}>{children}</a>;
      return <span>{children}</span>;
    },
    // Notes never load local or remote images into the app window.
    img: ({ alt }) => <span className="knImage">{alt}</span>,
  };

  const vaults = status?.vaults ?? [];
  const scoped = projects.filter(p => p.knowledge?.length);
  const vaultName = (id: string) => vaults.find(v => v.vault.id === id)?.vault.name ?? '';
  const properties = note ? Object.entries(note.properties).filter(([key]) => !['tags', 'tag', 'aliases', 'alias'].includes(key)) : [];

  return <div className="page knowledgePage">
    <SectionTitle title={t('knowledge.title')} description={t('knowledge.description')}
      action={<div className="toolbar">
        {scoped.length > 0 && <ChoiceSelect label={t('knowledge.scope')} value={scope} onChange={setScope} options={[{ value: 'all', label: t('knowledge.scopeAll') }, ...scoped.map(p => ({ value: p.id, label: p.name, description: t('knowledge.scopeProject', { count: p.knowledge?.length ?? 0 }) }))]}/>}
        <Button className="primary" onClick={() => void connect()}><FolderPlus size={14}/>{t('knowledge.connect')}</Button>
      </div>}/>
    {error && <p className="knError" role="alert">{error}</p>}
    {status && !vaults.length ? <div className="knEmpty"><EmptyState title={t('knowledge.emptyTitle')} text={t('knowledge.emptyText')} action={<Button className="primary" onClick={() => void connect()}><FolderPlus size={14}/>{t('knowledge.connect')}</Button>}/></div>
      : <div className="knGrid">
        <aside className="knSide" aria-label={t('knowledge.search')}>
          <label className="knSearch"><Search size={15}/><input type="search" value={query} aria-label={t('knowledge.search')} placeholder={t('knowledge.searchPlaceholder')} onChange={event => setQuery(event.target.value)} autoFocus/></label>
          <div className="knResults" aria-live="polite" aria-busy={searching}>
            {query.trim() && !searching && !hits.length && <p className="knMuted">{t('knowledge.noResults')}</p>}
            {!query.trim() && <p className="knMuted">{t('knowledge.searchHint')}</p>}
            {hits.map(hit => <button type="button" key={`${hit.vaultId}:${hit.path}`} className={`knHit${selected?.vaultId === hit.vaultId && selected.path === hit.path ? ' isOn' : ''}`} onClick={() => setSelected({ vaultId: hit.vaultId, path: hit.path, line: hit.line })}>
              <span className="knHitHead"><FileText size={14}/><b><Highlighted text={hit.title} query={query}/></b>{hit.matched === 'partial' && <span className="knTag" title={t('knowledge.partialHint')}>{t('knowledge.partial')}</span>}</span>
              {hit.heading && hit.heading !== hit.title && <small className="knHitHeading">{hit.heading}</small>}
              {hit.snippet && <span className="knSnippet"><Highlighted text={hit.snippet} query={query}/></span>}
              <small className="knHitPath">{vaults.length > 1 ? `${vaultName(hit.vaultId)} · ` : ''}{hit.path}</small>
            </button>)}
          </div>
          <div className="knVaults">
            <div className="knVaultsHead"><span>{t('knowledge.vaults')}</span><span className="kMono">{vaults.length}</span></div>
            <ul>{vaults.map(row => <VaultRow key={row.vault.id} row={row} onReindex={() => void knowledgeReindex(row.vault.id).then(refresh).catch(e => setError(t(knowledgeErrorKey(e))))} onRemove={() => void remove(row)}/>)}</ul>
            <p className="knMuted knReadOnly">{t('knowledge.readOnly')}</p>
          </div>
        </aside>
        <article className="knNote" aria-label={note?.title ?? t('knowledge.noNote')}>
          {!note ? <div className="knPlaceholder"><BookOpen size={26}/><p>{t('knowledge.noNote')}</p></div> : <>
            <header className="knNoteHead">
              <div><h3>{note.title}</h3><small title={note.absolutePath}>{note.vaultName} · {note.path}</small></div>
              <a className="uiButton primary" href={note.obsidianUri} onClick={event => { event.preventDefault(); void openObsidian(); }} title={vaults.find(v => v.vault.id === note.vaultId)?.obsidian === false ? t('knowledge.notObsidianHint') : note.obsidianUri}><ExternalLink size={14}/>{t('knowledge.openObsidian')}</a>
            </header>
            {(note.tags.length > 0 || note.aliases.length > 0 || properties.length > 0) && <dl className="knProps">
              {note.tags.length > 0 && <div><dt><Hash size={12}/>{t('knowledge.tags')}</dt><dd>{note.tags.map(tag => <span className="knTag" key={tag}>#{tag}</span>)}</dd></div>}
              {note.aliases.length > 0 && <div><dt>{t('knowledge.aliases')}</dt><dd>{note.aliases.join(', ')}</dd></div>}
              {properties.slice(0, 12).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(', ') : value === null ? '—' : String(value)}</dd></div>)}
            </dl>}
            <div className="knBody chatMarkdown" ref={bodyRef}><Markdown remarkPlugins={plugins} components={components} skipHtml>{wikiToMarkdown(note.body)}</Markdown></div>
            {note.backlinks.length > 0 && <footer className="knBacklinks"><h4><Link2 size={13}/>{t('knowledge.backlinks')}</h4><div>{note.backlinks.map(link => <button type="button" key={link.path} className="knWikiLink" onClick={() => setSelected({ vaultId: link.vaultId, path: link.path })}>{link.title}</button>)}</div></footer>}
            <p className="knMuted knModified">{t('knowledge.modified', { date: new Date(note.modified).toLocaleString(i18n.language) })}</p>
          </>}
        </article>
      </div>}
  </div>;
}
