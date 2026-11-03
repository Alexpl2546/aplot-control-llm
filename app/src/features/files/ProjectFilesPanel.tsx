import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus2, FileSearch, FileText, Eye, Paperclip, Save, Trash2 } from 'lucide-react';
import { DocumentComposer } from './DocumentComposer';
import { ProjectFileTextPreview } from './ProjectFileTextPreview';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Button, Input } from '../../components/ui/Primitives';
import type { ChatAttachment } from '../chat/media';
import { open, save } from '../../services/filePicker';
import { isTauri } from '../../services/tauri';
import {
  importProjectFile,
  exportProjectFile,
  listProjectFiles,
  readProjectFileAttachment,
  removeProjectFile,
  searchProjectFiles,
  type ProjectFile,
  type ProjectFileMatch,
} from '../../services/projectFiles';
import './projectFilesPanel.css';

export interface ProjectFilesPanelProps {
  projectId: string;
  disabled?: boolean;
  onAttach?: (attachment: ChatAttachment) => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}

const MAX_IMPORT_FILES = 8;
const IMPORT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'log',
  'html', 'htm', 'rst', 'pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'webp',
];

type ProjectFileOperation = 'load' | 'search' | 'import' | 'attach' | 'remove' | 'export';

function errorCode(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/i, '').trim();
  return message.match(/^([a-z][a-z0-9-]*)/)?.[1] ?? '';
}

function errorMessage(
  error: unknown,
  operation: ProjectFileOperation,
  translate: (key: string, defaultValue: string) => string,
): string {
  const code = errorCode(error);
  const known: Record<string, [string, string]> = {
    'project-missing': ['projectUnavailable', 'This project is no longer available.'],
    'task-missing': ['projectUnavailable', 'This project is no longer available.'],
    'project-file-source-missing': ['sourceMissing', 'The selected file could not be found. Select it again.'],
    'attachment-missing': ['sourceMissing', 'The selected file could not be found. Select it again.'],
    'project-file-source-not-file': ['chooseFile', 'Select a supported file to import.'],
    'project-file-path-invalid': ['chooseFile', 'Select a supported file to import.'],
    'project-file-size-limit': ['fileTooLarge', 'This file is over the 25 MB import limit.'],
    'attachment-limit': ['mediaSizeLimit', 'This image or PDF exceeds its supported size limit.'],
    'project-file-unsupported': ['unsupportedFile', 'This file type or format is not supported.'],
    'attachment-unsupported': ['unsupportedFile', 'This file type or format is not supported.'],
    'project-file-text-unavailable': ['textUnavailable', 'Text from this file is not available.'],
    'project-file-missing': ['copyMissing', 'This saved copy is no longer available.'],
  };
  const operationFallback: Record<ProjectFileOperation, [string, string]> = {
    load: ['loadFailed', 'Project files could not be loaded.'],
    search: ['searchFailed', 'Project files could not be searched.'],
    import: ['importFailed', 'This file could not be imported.'],
    attach: ['attachFailed', 'The saved copy could not be attached.'],
    remove: ['removeFailed', 'The saved copy could not be removed.'],
    export: ['exportFailed', 'The saved copy could not be exported.'],
  };
  const [key, fallback] = known[code] ?? operationFallback[operation];
  return translate(`error.${key}`, fallback);
}

function fileLabelFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export function ProjectFilesPanel({ projectId, disabled = false, onAttach, onBusy }: ProjectFilesPanelProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<ProjectFileMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [removeTarget, setRemoveTarget] = useState<{ projectId: string; file: ProjectFile }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [preview, setPreview] = useState<ProjectFile>();
  const requestGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const attachmentGeneration = useRef(0);
  const attachmentBusy = useRef(false);
  const onBusyRef = useRef(onBusy);
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;

  useEffect(() => { onBusyRef.current = onBusy; }, [onBusy]);

  useEffect(() => {
    return () => {
      if (!attachmentBusy.current) return;
      attachmentBusy.current = false;
      attachmentGeneration.current += 1;
      onBusyRef.current?.(false);
    };
  }, [projectId]);

  const translate = (key: string, defaultValue: string, options: Record<string, unknown> = {}) =>
    t(`projectFiles.${key}`, { defaultValue, ...options });

  const isCurrent = (targetProjectId: string, generation: number) =>
    requestGeneration.current === generation && currentProjectIdRef.current === targetProjectId;

  const refresh = async (targetProjectId: string, generation: number, showError = true) => {
    try {
      const result = await listProjectFiles(targetProjectId);
      if (!isCurrent(targetProjectId, generation)) return false;
      setFiles(result);
      setLoading(false);
      return true;
    } catch (cause) {
      if (isCurrent(targetProjectId, generation)) {
        setLoading(false);
        if (showError) setActionError(errorMessage(cause, 'load', (key, fallback) => translate(key, fallback)));
      }
      return false;
    }
  };

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setFiles([]);
    setMatches([]);
    setSearchQuery('');
    setSearchError('');
    setActionError('');
    setNotice('');
    setBusyAction('');
    setRemoveTarget(undefined);
    setCreateOpen(false);
    setPreview(undefined);
    setLoading(true);
    void refresh(projectId, generation);
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
    // refresh is intentionally local to this request and always reads the current project ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const generation = requestGeneration.current;
    const searchRequest = ++searchGeneration.current;
    const query = searchQuery.trim();
    let active = true;
    setSearchError('');
    setMatches([]);
    if (!query || !isTauri()) {
      setSearching(false);
      return () => { active = false; };
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchProjectFiles(projectId, query)
        .then(result => {
          if (active && searchGeneration.current === searchRequest && isCurrent(projectId, generation)) setMatches(result);
        })
        .catch(cause => {
          if (active && searchGeneration.current === searchRequest && isCurrent(projectId, generation)) {
            setMatches([]);
            setSearchError(errorMessage(cause, 'search', (key, fallback) => translate(key, fallback)));
          }
        })
        .finally(() => {
          if (active && searchGeneration.current === searchRequest && isCurrent(projectId, generation)) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (searchGeneration.current === searchRequest) searchGeneration.current += 1;
    };
  }, [projectId, searchQuery]);

  const invalidateSearch = () => {
    searchGeneration.current += 1;
    setSearchQuery('');
    setMatches([]);
    setSearchError('');
    setSearching(false);
  };

  const importFiles = async () => {
    if (disabled || busyAction || !isTauri()) return;
    const targetProjectId = projectId;
    const generation = requestGeneration.current;
    setBusyAction('import');
    setActionError('');
    setNotice('');
    try {
      const selection = await open({
        multiple: true,
        filters: [{ name: translate('supportedFiles', 'Supported project files'), extensions: IMPORT_EXTENSIONS }],
      });
      if (!selection || !isCurrent(targetProjectId, generation)) return;
      const paths = typeof selection === 'string' ? [selection] : selection;
      const selected = paths.slice(0, MAX_IMPORT_FILES);
      let imported = 0;
      const failures: string[] = [];
      for (const path of selected) {
        if (!isCurrent(targetProjectId, generation)) return;
        try {
          await importProjectFile(targetProjectId, path);
          imported += 1;
        } catch (cause) {
          failures.push(`${fileLabelFromPath(path)}: ${errorMessage(cause, 'import', (key, fallback) => translate(key, fallback))}`);
        }
      }
      if (!isCurrent(targetProjectId, generation)) return;
      if (paths.length > MAX_IMPORT_FILES) {
        failures.push(translate('importLimit', 'Only the first {{limit}} selected files were imported.', { limit: MAX_IMPORT_FILES }));
      }
      if (imported > 0) {
        invalidateSearch();
        setNotice(translate('imported', 'Imported {{count}} project file(s).', { count: imported }));
        await refresh(targetProjectId, generation, false);
      }
      if (failures.length > 0) setActionError(failures.join('\n'));
      else if (imported === 0) setNotice('');
    } catch (cause) {
      if (isCurrent(targetProjectId, generation)) setActionError(errorMessage(cause, 'import', (key, fallback) => translate(key, fallback)));
    } finally {
      if (isCurrent(targetProjectId, generation)) setBusyAction('');
    }
  };

  const attachFile = async (file: ProjectFile) => {
    if (!onAttach || disabled || busyAction) return;
    const targetProjectId = projectId;
    const generation = requestGeneration.current;
    const attachGeneration = ++attachmentGeneration.current;
    attachmentBusy.current = true;
    onBusyRef.current?.(true);
    setBusyAction(`attach:${file.id}`);
    setActionError('');
    setNotice('');
    try {
      const attachment = await readProjectFileAttachment(targetProjectId, file.id);
      if (!isCurrent(targetProjectId, generation)) return;
      await onAttach(attachment);
      if (isCurrent(targetProjectId, generation)) setNotice(translate('attached', 'Added {{name}} to the chat draft.', { name: file.name }));
    } catch (cause) {
      if (isCurrent(targetProjectId, generation)) setActionError(errorMessage(cause, 'attach', (key, fallback) => translate(key, fallback)));
    } finally {
      if (isCurrent(targetProjectId, generation)) setBusyAction('');
      if (attachmentGeneration.current === attachGeneration && attachmentBusy.current) {
        attachmentBusy.current = false;
        onBusyRef.current?.(false);
      }
    }
  };

  const exportCopy = async (file: ProjectFile) => {
    if (disabled || busyAction || !isTauri()) return;
    const targetProjectId = projectId;
    const generation = requestGeneration.current;
    setBusyAction(`export:${file.id}`);
    setActionError('');
    setNotice('');
    try {
      const path = await save({ defaultPath: file.name });
      if (!path || !isCurrent(targetProjectId, generation)) return;
      await exportProjectFile(targetProjectId, file.id, path);
      if (isCurrent(targetProjectId, generation)) {
        setNotice(translate('exported', 'Saved {{name}}.', { name: file.name }));
      }
    } catch (cause) {
      if (isCurrent(targetProjectId, generation)) setActionError(errorMessage(cause, 'export', (key, fallback) => translate(key, fallback)));
    } finally {
      if (isCurrent(targetProjectId, generation)) setBusyAction('');
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget || disabled || busyAction) return;
    const target = removeTarget;
    const generation = requestGeneration.current;
    setBusyAction(`remove:${target.file.id}`);
    setActionError('');
    try {
      await removeProjectFile(target.projectId, target.file.id);
      if (!isCurrent(target.projectId, generation)) return;
      invalidateSearch();
      setRemoveTarget(undefined);
      await refresh(target.projectId, generation);
    } catch (cause) {
      throw new Error(errorMessage(cause, 'remove', (key, fallback) => translate(key, fallback)));
    } finally {
      if (isCurrent(target.projectId, generation)) setBusyAction('');
    }
  };

  const native = isTauri();
  const hasQuery = searchQuery.trim().length > 0;
  const busy = Boolean(busyAction);

  return (
    <section className="projectFiles" aria-labelledby={titleId} aria-busy={loading || busy || searching || undefined}>
      <header className="projectFilesHeader">
        <div>
          <h2 id={titleId}>{translate('title', 'Project files')}</h2>
          <p>{translate('description', 'Import files into this project to keep searchable managed copies.')}</p>
        </div>
        <div className="projectFilesHeaderActions"><Button type="button" disabled={disabled || busy || !native} onClick={() => setCreateOpen(true)}><FileText size={15}/>{translate('create', 'Create document')}</Button>
        <Button type="button" className="primary" disabled={disabled || busy || !native} onClick={() => void importFiles()}>
          <FilePlus2 size={15}/>{translate('import', 'Import files')}
        </Button></div>
      </header>
      <p className="projectFilesHint">{translate('formatsHint', 'Text from DOCX and XLSX is extracted and stored; spreadsheet formulas are not recalculated. PDFs and images are searchable by filename only.')}</p>

      {!native && <p className="projectFilesDesktopNote" role="status">{translate('desktopOnly', 'Project files are available in the desktop app.')}</p>}

      <label className="projectFilesSearch">
        <FileSearch size={15} aria-hidden="true"/>
        <Input
          type="search"
          aria-label={translate('searchLabel', 'Search project files')}
          placeholder={translate('searchPlaceholder', 'Search names and indexed text')}
          value={searchQuery}
          disabled={disabled || !native}
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
          onChange={event => setSearchQuery(event.target.value)}
        />
        {searching && <span role="status">{translate('searching', 'Searching…')}</span>}
      </label>
      {searchError && <p className="projectFilesError" role="alert">{searchError}</p>}
      {hasQuery && !searching && !searchError && <div className="projectFilesSearchResults" aria-live="polite">
        <h3>{translate('searchResults', 'Search results')}</h3>
        {matches.length === 0
          ? <p className="projectFilesMuted">{translate('noMatches', 'No matching project files.')}</p>
          : <ul>{matches.map((match, index) => <SearchResult
            key={`${match.file.id}:${index}`}
            match={match}
            translate={translate}
            disabled={disabled || busy}
            onAttach={onAttach ? () => void attachFile(match.file) : undefined}
            onExport={() => void exportCopy(match.file)}
            onPreview={match.file.indexed ? () => setPreview(match.file) : undefined}
          />)}</ul>}
      </div>}

      {actionError && <p className="projectFilesError" role="alert">{actionError}</p>}
      {notice && <p className="projectFilesNotice" role="status">{notice}</p>}
      <div className="projectFilesList" aria-live="polite">
        {loading
          ? <p className="projectFilesMuted" role="status">{translate('loading', 'Loading project files…')}</p>
          : files.length === 0
            ? <p className="projectFilesMuted">{translate('empty', 'No files have been imported into this project yet.')}</p>
            : files.map(file => <ProjectFileRow
              key={file.id}
              file={file}
              locale={i18n.language}
              translate={translate}
              disabled={disabled || busy}
              onAttach={onAttach ? () => void attachFile(file) : undefined}
              onExport={() => void exportCopy(file)}
              onPreview={file.indexed ? () => setPreview(file) : undefined}
              onRemove={() => setRemoveTarget({ projectId, file })}
            />)}
      </div>

      {createOpen && <DocumentComposer key={projectId} projectId={projectId} onClose={() => setCreateOpen(false)} onCreated={file => {
        if (currentProjectIdRef.current !== projectId || file.projectId !== projectId) return;
        setFiles(current => [file, ...current.filter(item => item.id !== file.id)]);
        invalidateSearch();
        setNotice(translate('created', 'Created {{name}}.', { name: file.name }));
        setCreateOpen(false);
      }}/>}
      {preview && <ProjectFileTextPreview key={`${projectId}:${preview.id}`} projectId={projectId} fileId={preview.id} name={preview.name} onClose={() => setPreview(undefined)}/>}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title={translate('removeTitle', 'Remove saved copy?')}
        text={translate('removeText', 'This removes the managed copy only. The project file will stay unchanged.')}
        confirmLabel={translate('remove', 'Remove copy')}
        dangerous
        busy={busyAction.startsWith('remove:')}
        onCancel={() => { if (!busyAction) setRemoveTarget(undefined); }}
        onConfirm={confirmRemove}
      />
    </section>
  );
}

function ProjectFileRow({
  file,
  locale,
  translate,
  disabled,
  onAttach,
  onExport,
  onPreview,
  onRemove,
}: {
  file: ProjectFile;
  locale: string;
  translate: (key: string, defaultValue: string, options?: Record<string, unknown>) => string;
  disabled: boolean;
  onAttach?: () => void;
  onExport: () => void;
  onPreview?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const indexState = file.indexed
    ? translate('indexed', 'Text indexed')
    : translate('nameOnly', 'Name only');
  const state = file.truncated
    ? translate('truncated', 'Text index truncated')
    : indexState;
  const version = translate('version', 'Version {{version}}', { version: file.version });
  const removeLabel = t('projectFiles.removeVersioned', { defaultValue: 'Remove copy: {{name}}, version {{version}}', name: file.name, version: file.version });
  const attachLabel = t('projectFiles.attachVersioned', { defaultValue: 'Attach to chat: {{name}}, version {{version}}', name: file.name, version: file.version });
  const exportLabel = t('projectFiles.exportVersioned', { defaultValue: 'Save copy as: {{name}}, version {{version}}', name: file.name, version: file.version });
  return (
    <article className="projectFilesRow">
      <div className="projectFilesFileIcon" aria-hidden="true"><Paperclip size={16}/></div>
      <div className="projectFilesMain">
        <div className="projectFilesName"><strong>{file.name}</strong><span>{version}</span></div>
        <div className="projectFilesMeta">
          <span>{file.mime}</span>
          {file.bytes >= 0 && <span>{formatBytes(file.bytes)}</span>}
          <span>{formatDate(file.createdAt, locale)}</span>
          <span className={file.truncated ? 'isTruncated' : ''}>{state}</span>
        </div>
      </div>
      <div className="projectFilesActions">
        {onPreview && <Button type="button" className="kIconBtn" disabled={disabled} aria-label={t('projectFiles.previewVersioned', { defaultValue: 'Preview text: {{name}}, version {{version}}', name: file.name, version: file.version })} onClick={onPreview}><Eye size={14}/></Button>}
        {onAttach && <Button type="button" disabled={disabled} aria-label={attachLabel} onClick={onAttach}>{translate('attach', 'Attach')}<Paperclip size={13}/></Button>}
        <Button type="button" disabled={disabled || !isTauri()} aria-label={exportLabel} title={exportLabel} onClick={onExport}>{translate('export', 'Save as…')}<Save size={13}/></Button>
        <Button type="button" className="kIconBtn projectFilesRemove" disabled={disabled} aria-label={removeLabel} title={removeLabel} onClick={onRemove}><Trash2 size={14}/></Button>
      </div>
    </article>
  );
}

function SearchResult({ match, translate, disabled, onAttach, onExport, onPreview }: {
  match: ProjectFileMatch;
  translate: (key: string, defaultValue: string, options?: Record<string, unknown>) => string;
  disabled: boolean;
  onAttach?: () => void;
  onExport: () => void;
  onPreview?: () => void;
}) {
  const attachLabel = translate('attachVersioned', 'Attach to chat: {{name}}, version {{version}}', { name: match.file.name, version: match.file.version });
  const exportLabel = translate('exportVersioned', 'Save copy as: {{name}}, version {{version}}', { name: match.file.name, version: match.file.version });
  return (
    <li className="projectFilesSearchResult">
      <div className="projectFilesSearchResultHead"><strong>{match.file.name}</strong><span>{translate('version', 'Version {{version}}', { version: match.file.version })}</span></div>
      <div className="projectFilesSearchActions">
        {onPreview && <Button type="button" className="kIconBtn" disabled={disabled} aria-label={translate('previewVersioned', 'Preview text: {{name}}, version {{version}}', { name: match.file.name, version: match.file.version })} onClick={onPreview}><Eye size={14}/></Button>}
        {onAttach && <Button type="button" disabled={disabled} aria-label={attachLabel} onClick={onAttach}>{translate('attach', 'Attach')}<Paperclip size={12}/></Button>}
        <Button type="button" disabled={disabled || !isTauri()} aria-label={exportLabel} title={exportLabel} onClick={onExport}>{translate('export', 'Save as…')}<Save size={12}/></Button>
      </div>
      <p>{match.snippet}</p>
    </li>
  );
}
