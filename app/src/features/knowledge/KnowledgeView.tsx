import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ExternalLink, FileText, FolderPlus, Hash, Link2, ListTree, Pencil, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SectionTitle } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { pickDirectory } from '../../services/dialog';
import { openExternalUrl } from '../../services/desktop';
import { knowledgeBind, knowledgeList, knowledgeOpenObsidian, knowledgePublishPending, knowledgeRead, knowledgeReindex, knowledgeSearch, knowledgeStatus, knowledgeUnbind, type KnowledgeHit, type KnowledgeLinkedNote, type KnowledgeNote, type KnowledgeStatus, type KnowledgeVaultStatus } from '../../services/knowledge';
import { knowledgeEditorRead, knowledgeEditorSave, type KnowledgeEditorDocument } from '../../services/knowledgeEditor';
import { initializeWorkspace, setProjectKnowledge, useWorkspaceStore } from '../agent/workspace';
import { KnowledgeTree } from './KnowledgeTree';
import { NOTE_LINK, foldText, highlightParts, knowledgeErrorKey, linkCandidates, stemOf, wikiToMarkdown } from './knowledgeModel';
import './knowledge.css';

const plugins = [remarkGfm];

type EditorDraft = Pick<KnowledgeEditorDocument, 'content' | 'etag' | 'lineEnding'> & {
  baseContent: string;
  conflict: boolean;
};

function noteHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', bodyLine: number): NonNullable<Components['h1']> {
  return ({ node, children }) => <Tag data-note-line={node?.position && node.position.start.line + bodyLine - 1}>{children}</Tag>;
}

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
  const [notes, setNotes] = useState<KnowledgeLinkedNote[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<{ vaultId: string; path: string; line?: number; heading?: string }>();
  const [note, setNote] = useState<KnowledgeNote>();
  const [error, setError] = useState('');
  const [scope, setScope] = useState('all');
  const [publishing, setPublishing] = useState(false);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, EditorDraft>>({});
  const [editingKey, setEditingKey] = useState<string>();
  const [loadingEditorKey, setLoadingEditorKey] = useState<string>();
  const [savingEditorKey, setSavingEditorKey] = useState<string>();
  const projects = useWorkspaceStore(s => s.projects);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchVersion = useRef(0);
  const activeNoteKeyRef = useRef('');

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
  const vaultKey = JSON.stringify((status?.vaults ?? []).map(row => row.vault.id).filter(id => !vaultIds || vaultIds.includes(id)));
  const selectedVault = selected?.vaultId;
  const selectedPath = selected?.path;

  useEffect(() => {
    let current = true;
    const ids: string[] = JSON.parse(vaultKey);
    if (ids.length) void knowledgeList(ids).then(rows => { if (current) setNotes(rows); })
      .catch(e => { if (current) setError(t(knowledgeErrorKey(e))); });
    else setNotes([]);
    return () => { current = false; };
  }, [vaultKey, freshness, t]);

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
    if (!selectedVault || !selectedPath) { setNote(undefined); return; }
    let current = true;
    knowledgeRead(selectedVault, selectedPath).then(view => { if (current) { setNote(view); setError(''); } })
      .catch(e => { if (current) { setNote(undefined); setError(t(knowledgeErrorKey(e))); } });
    return () => { current = false; };
  }, [selectedVault, selectedPath, freshness, t]);

  useEffect(() => {
    if (!note || !selected || note.path !== selected.path || note.vaultId !== selected.vaultId) return;
    const { line, heading: target } = selected;
    const headings = note.outline;
    const heading = target ? headings.find(item => foldText(item.heading) === foldText(target))
      : line ? headings.filter(item => item.line <= line).at(-1) : undefined;
    if (heading) bodyRef.current?.querySelector(`[data-note-line="${heading.line}"]`)?.scrollIntoView?.({ block: 'nearest' });
    else bodyRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [note?.path, note?.vaultId, selected]);

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
        if (project.knowledge?.includes(row.vault.id)) setProjectKnowledge(project.id, project.knowledge.filter(id => id !== row.vault.id));
      }
      if (selected?.vaultId === row.vault.id) setSelected(undefined);
      await refresh();
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  const openLinked = async (target: string) => {
    if (!note) return;
    const [file, heading] = target.split('#', 2);
    if (!file && heading) { setSelected({ vaultId: note.vaultId, path: note.path, heading }); return; }
    for (const path of linkCandidates(target, note.path)) {
      try { await knowledgeRead(note.vaultId, path); setSelected({ vaultId: note.vaultId, path, heading }); return; } catch { /* try the next candidate */ }
    }
    const stem = foldText(stemOf(target.split('#')[0]));
    const match = (await knowledgeSearch(stemOf(target.split('#')[0]), [note.vaultId], 50).catch(() => [])).find(hit => foldText(stemOf(hit.path)) === stem || foldText(hit.title) === stem);
    if (match) setSelected({ vaultId: match.vaultId, path: match.path, heading });
    else setError(t('knowledge.linkMissing', { name: target }));
  };
  const openObsidian = async () => {
    if (!note) return;
    try { await knowledgeOpenObsidian(note.vaultId, note.path); } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  const retryPublication = async () => {
    setPublishing(true);
    try {
      await knowledgePublishPending();
      await refresh();
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
    finally { setPublishing(false); }
  };

  const components: Components = {
    h1: noteHeading('h1', note?.bodyLine ?? 1),
    h2: noteHeading('h2', note?.bodyLine ?? 1),
    h3: noteHeading('h3', note?.bodyLine ?? 1),
    h4: noteHeading('h4', note?.bodyLine ?? 1),
    h5: noteHeading('h5', note?.bodyLine ?? 1),
    h6: noteHeading('h6', note?.bodyLine ?? 1),
    a: ({ href, children }) => {
      const url = href ?? '';
      if (url.startsWith(NOTE_LINK)) return <a href={url} className="knWikiLink" onClick={event => { event.preventDefault(); void openLinked(decodeURIComponent(url.slice(NOTE_LINK.length))); }}>{children}</a>;
      if (/^(https?:|mailto:)/i.test(url)) return <a href={url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); void openExternalUrl(url); }}>{children}</a>;
      if (url && !url.includes(':')) return <a href={url} className="knWikiLink" onClick={event => { event.preventDefault(); void openLinked(decodeURIComponent(url)); }}>{children}</a>;
      return <span>{children}</span>;
    },
    // Notes never load local or remote images into the app window.
    img: ({ alt }) => <span className="knImage">{alt}</span>,
  };

  const vaults = status?.vaults ?? [];
  const scopedVaults = vaultIds ? vaults.filter(row => vaultIds.includes(row.vault.id)) : vaults;
  const scoped = projects.filter(p => p.knowledge?.length);
  const vaultName = (id: string) => vaults.find(v => v.vault.id === id)?.vault.name ?? '';
  const properties = note ? Object.entries(note.properties).filter(([key]) => !['tags', 'tag', 'aliases', 'alias'].includes(key)) : [];
  const noteKey = note ? JSON.stringify([note.vaultId, note.path]) : '';
  activeNoteKeyRef.current = noteKey;
  const draft = noteKey ? editorDrafts[noteKey] : undefined;
  const editing = !!noteKey && editingKey === noteKey;
  const draftChanged = !!draft && draft.content !== draft.baseContent;
  const editorLoading = loadingEditorKey === noteKey;
  const editorSaving = savingEditorKey === noteKey;

  const beginEdit = async () => {
    if (!note || !noteKey) return;
    const key = noteKey;
    setError('');
    if (editorDrafts[key]) { setEditingKey(key); return; }
    setLoadingEditorKey(key);
    try {
      const opened = await knowledgeEditorRead(note.vaultId, note.path);
      setEditorDrafts(current => ({
        ...current,
        [key]: { content: opened.content, baseContent: opened.content, etag: opened.etag, lineEnding: opened.lineEnding, conflict: false },
      }));
      if (activeNoteKeyRef.current === key) setEditingKey(key);
    } catch {
      setError(t('knowledge.editor.readError'));
    } finally {
      setLoadingEditorKey(current => current === key ? undefined : current);
    }
  };

  const saveDraft = async () => {
    if (!note || !noteKey || !draft || !draftChanged || draft.conflict || editorSaving) return;
    const key = noteKey;
    const source = note;
    setSavingEditorKey(key);
    setError('');
    try {
      await knowledgeEditorSave(source.vaultId, source.path, draft.content, draft.etag);
      setEditorDrafts(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (activeNoteKeyRef.current === key) {
        setEditingKey(undefined);
        const fresh = await knowledgeRead(source.vaultId, source.path).catch(() => undefined);
        if (fresh) setNote(fresh);
      }
      await refresh();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      if (detail.includes('knowledge-conflict')) {
        setEditorDrafts(current => current[key] ? { ...current, [key]: { ...current[key], conflict: true } } : current);
      } else {
        setError(t('knowledge.editor.saveError'));
      }
    } finally {
      setSavingEditorKey(current => current === key ? undefined : current);
    }
  };

  const reloadDraft = async () => {
    if (!note || !noteKey || !window.confirm(t('knowledge.editor.reloadConfirm'))) return;
    const key = noteKey;
    setLoadingEditorKey(key);
    try {
      const opened = await knowledgeEditorRead(note.vaultId, note.path);
      setEditorDrafts(current => ({
        ...current,
        [key]: { content: opened.content, baseContent: opened.content, etag: opened.etag, lineEnding: opened.lineEnding, conflict: false },
      }));
      setError('');
    } catch {
      setError(t('knowledge.editor.readError'));
    } finally {
      setLoadingEditorKey(current => current === key ? undefined : current);
    }
  };

  const closeEditor = () => {
    if (!draftChanged && noteKey) {
      setEditorDrafts(current => {
        const next = { ...current };
        delete next[noteKey];
        return next;
      });
    }
    setEditingKey(undefined);
  };

  return <div className="page knowledgePage">
    {(!status || vaults.length > 0) && <SectionTitle title={t('knowledge.title')}
      action={<div className="toolbar">
        {scoped.length > 0 && <ChoiceSelect label={t('knowledge.scope')} value={scope} onChange={setScope} options={[{ value: 'all', label: t('knowledge.scopeAll') }, ...scoped.map(p => ({ value: p.id, label: p.name, description: t('knowledge.scopeProject', { count: p.knowledge?.length ?? 0 }) }))]}/>}
        <Button className="primary" onClick={() => void connect()}><FolderPlus size={14}/>{t('knowledge.connect')}</Button>
      </div>}/>}
    {error && <p className="knError" role="alert">{error}</p>}
    {!!status?.pendingNotes && <div className="knPending" role="status">
      <span>{t('knowledge.publish.pending', { count: status.pendingNotes })}</span>
      <Button type="button" disabled={publishing} onClick={() => void retryPublication()}><RefreshCw size={14}/>{t('knowledge.publish.retry')}</Button>
    </div>}
    {status && !vaults.length ? <KnowledgeWelcome onConnect={() => void connect()}/>
      : <div className="knGrid">
        <aside className="knSide" aria-label={t('knowledge.search')}>
          <label className="knSearch"><Search size={15}/><input type="search" value={query} aria-label={t('knowledge.search')} placeholder={t('knowledge.searchPlaceholder')} onChange={event => setQuery(event.target.value)} autoFocus/></label>
          <div className="knResults" aria-live="polite" aria-busy={searching}>
            {query.trim() && !searching && !hits.length && <p className="knMuted">{t('knowledge.noResults')}</p>}
            {!query.trim() && <><KnowledgeTree vaults={scopedVaults} notes={notes} selected={selected} onSelect={({ vaultId, path }) => setSelected({ vaultId, path })}/>
              {!notes.length && <p className="knMuted">{t('knowledge.searchHint')}</p>}</>}
            {query.trim() && hits.map(hit => <button type="button" key={`${hit.vaultId}:${hit.path}`} className={`knHit${selected?.vaultId === hit.vaultId && selected.path === hit.path ? ' isOn' : ''}`} onClick={() => setSelected({ vaultId: hit.vaultId, path: hit.path, line: hit.line })}>
              <span className="knHitHead"><FileText size={14}/><b><Highlighted text={hit.title} query={query}/></b>{hit.matched === 'partial' && <span className="knTag" title={t('knowledge.partialHint')}>{t('knowledge.partial')}</span>}</span>
              {hit.heading && hit.heading !== hit.title && <small className="knHitHeading">{hit.heading}</small>}
              {hit.snippet && <span className="knSnippet"><Highlighted text={hit.snippet} query={query}/></span>}
              <small className="knHitPath">{vaults.length > 1 ? `${vaultName(hit.vaultId)} · ` : ''}{hit.path}</small>
            </button>)}
          </div>
          <div className="knVaults">
            <div className="knVaultsHead"><span>{t('knowledge.vaults')}</span><span className="kMono">{vaults.length}</span></div>
            <ul>{vaults.map(row => <VaultRow key={row.vault.id} row={row} onReindex={() => void knowledgeReindex(row.vault.id).then(refresh).catch(e => setError(t(knowledgeErrorKey(e))))} onRemove={() => void remove(row)}/>)}</ul>
          </div>
        </aside>
        <article className="knNote" aria-label={note?.title ?? t('knowledge.noNote')}>
          {!note ? <div className="knPlaceholder"><BookOpen size={26}/><p>{t('knowledge.noNote')}</p></div> : <>
            <header className="knNoteHead">
              <div><h3>{note.title}</h3><small title={note.absolutePath}>{note.vaultName} · {note.path}</small></div>
              <div className="knNoteActions">
                {!editing && <Button type="button" disabled={editorLoading} onClick={() => void beginEdit()}><Pencil size={14}/>{draftChanged ? t('knowledge.editor.resume') : t('knowledge.editor.edit')}</Button>}
                {editing && <>
                  <Button type="button" className="primary" disabled={!draftChanged || !!draft?.conflict || editorSaving} onClick={() => void saveDraft()}><Save size={14}/>{editorSaving ? t('knowledge.editor.saving') : t('knowledge.editor.save')}</Button>
                  <Button type="button" disabled={editorSaving} onClick={closeEditor}>{t('knowledge.editor.close')}</Button>
                </>}
                <a className="uiButton primary" href={note.obsidianUri} onClick={event => { event.preventDefault(); void openObsidian(); }} title={vaults.find(v => v.vault.id === note.vaultId)?.obsidian === false ? t('knowledge.notObsidianHint') : note.obsidianUri}><ExternalLink size={14}/>{t('knowledge.openObsidian')}</a>
              </div>
            </header>
            {draftChanged && !editing && !draft?.conflict && <p className="knDraftNotice" role="status">{t('knowledge.editor.unsaved')}</p>}
            {draft?.conflict && <div className="knEditorConflict" role="alert">
              <span>{t('knowledge.editor.conflict')}</span>
              <Button type="button" disabled={editorLoading} onClick={() => void reloadDraft()}><RefreshCw size={14}/>{t('knowledge.editor.reload')}</Button>
            </div>}
            {(note.tags.length > 0 || note.aliases.length > 0 || properties.length > 0) && <dl className="knProps">
              {note.tags.length > 0 && <div><dt><Hash size={12}/>{t('knowledge.tags')}</dt><dd>{note.tags.map(tag => <span className="knTag" key={tag}>#{tag}</span>)}</dd></div>}
              {note.aliases.length > 0 && <div><dt>{t('knowledge.aliases')}</dt><dd>{note.aliases.join(', ')}</dd></div>}
              {properties.slice(0, 12).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(', ') : value === null ? '—' : String(value)}</dd></div>)}
            </dl>}
            <div className="knReader">
              {editing ? <section className="knEditor" aria-label={t('knowledge.editor.edit')}>
                <div className="knEditorIntro"><label htmlFor="knMarkdownEditor">{t('knowledge.editor.bodyLabel')}</label><p>{t('knowledge.editor.bodyHint')}</p></div>
                <textarea id="knMarkdownEditor" aria-label={t('knowledge.editor.bodyLabel')} spellCheck value={draft?.content ?? ''} disabled={editorSaving}
                  onChange={event => setEditorDrafts(current => current[noteKey] ? { ...current, [noteKey]: { ...current[noteKey], content: event.target.value } } : current)}/>
              </section> : <>
                <div className="knBody chatMarkdown" ref={bodyRef}><Markdown remarkPlugins={plugins} components={components} skipHtml>{wikiToMarkdown(note.body)}</Markdown></div>
                {note.outline.length > 0 && <nav className="knOutline" aria-label={t('knowledge.outline')}>
                  <h4><ListTree size={14}/>{t('knowledge.outline')}</h4>
                  {note.outline.map(item => <button key={item.line} type="button" style={{ paddingInlineStart: 8 + (item.level - 1) * 8 }}
                    onClick={() => setSelected({ vaultId: note.vaultId, path: note.path, line: item.line })}>{item.heading}</button>)}
                </nav>}
              </>}
            </div>
            {note.backlinks.length > 0 && <footer className="knBacklinks"><h4><Link2 size={13}/>{t('knowledge.backlinks')}</h4><div>{note.backlinks.map(link => <button type="button" key={link.path} className="knWikiLink" onClick={() => setSelected({ vaultId: link.vaultId, path: link.path })}>{link.title}</button>)}</div></footer>}
            <p className="knMuted knModified">{t('knowledge.modified', { date: new Date(note.modified).toLocaleString(i18n.language) })}</p>
          </>}
        </article>
      </div>}
  </div>;
}

/** Before the first vault: what knowledge is and the three steps to start, like the agent workspace. */
function KnowledgeWelcome({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation();
  const steps: [string, string][] = [['knowledge.welcome.step1', 'knowledge.welcome.step1Hint'], ['knowledge.welcome.step2', 'knowledge.welcome.step2Hint'], ['knowledge.welcome.step3', 'knowledge.welcome.step3Hint']];
  return <div className="awHero knWelcome">
    <div className="awHeroOrb" aria-hidden="true"><i/><i/><i/><b/></div>
    <h2>{t('knowledge.title')}</h2>
    <p>{t('knowledge.emptyText')}</p>
    <ol className="awHeroSteps">{steps.map(([title, hint], index) => <li key={title}><span className="kMono">{index + 1}</span><b>{t(title)}</b><small>{t(hint)}</small></li>)}</ol>
    <Button className="primary" onClick={onConnect}><FolderPlus size={16}/>{t('knowledge.connect')}</Button>
  </div>;
}
