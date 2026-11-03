import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { createProjectDocument, documentFromSource, projectDocumentName, ProjectDocumentInputError, workbookFromCsv, type DocumentFormat, type ProjectDocumentContent } from '../../services/projectDocuments';
import type { ProjectFile } from '../../services/projectFiles';
import { isTauri } from '../../services/tauri';
import { WorkspaceDialog } from '../agent/WorkspacePanels';
import './documentComposer.css';

export interface DocumentComposerProps {
  projectId: string;
  onCreated: (file: ProjectFile) => void;
  onClose: () => void;
}

function validationMessage(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ProjectDocumentInputError)) return t('documentCreate.createError');
  switch (error.code) {
    case 'invalid-title': return t('documentCreate.invalidTitle');
    case 'invalid-filename': return t('documentCreate.invalidFilename');
    case 'invalid-csv': return t('documentCreate.invalidCsv');
    case 'invalid-content':
    case 'limit': return t('documentCreate.invalidContent');
  }
}

export function DocumentComposer({ projectId, onCreated, onClose }: DocumentComposerProps) {
  const { t, i18n } = useTranslation();
  const [title, setTitle] = useState('');
  const [fileNameBase, setFileNameBase] = useState('');
  const [format, setFormat] = useState<DocumentFormat>('docx');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'title' | 'filename'>();
  const composerRef = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const mounted = useRef(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const preventOuterFormSubmit = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && event.target instanceof HTMLElement
      && !(event.target instanceof HTMLTextAreaElement)
      && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
    };
  }, []);

  useEffect(() => {
    requestEpoch.current += 1;
    setBusy(false);
    setError('');
    setErrorField(undefined);
  }, [projectId]);

  // WorkspaceDialog owns the outer dialog's close button and Escape handling.
  // Capture those events only while a native file write is in flight.
  useEffect(() => {
    if (!busy) return;
    const dialog = composerRef.current?.closest('dialog');
    if (!dialog) return;
    const preventClose = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const closeButton = dialog.querySelector<HTMLButtonElement>(':scope > header > button');
    closeButton?.addEventListener('click', preventClose, true);
    dialog.addEventListener('cancel', preventClose, true);
    return () => {
      closeButton?.removeEventListener('click', preventClose, true);
      dialog.removeEventListener('cancel', preventClose, true);
    };
  }, [busy]);

  const handleClose = () => {
    if (!busy) onClose();
  };

  const updateSource = (value: string) => {
    setSource(value);
    setError('');
    setErrorField(undefined);
  };

  const submit = async () => {
    if (busy) return;
    setError('');
    setErrorField(undefined);

    let request: { name: string; content: ProjectDocumentContent };
    try {
      const name = projectDocumentName(fileNameBase, format);
      const content: ProjectDocumentContent = format === 'xlsx'
        ? {
            format: 'xlsx',
            workbook: workbookFromCsv(
              title,
              source,
              i18n.language.toLowerCase().startsWith('ru') ? 'Лист1' : 'Sheet1',
            ),
          }
        : { format, document: documentFromSource(title, source) };
      request = { name, content };
    } catch (reason) {
      setError(validationMessage(reason, t));
      if (reason instanceof ProjectDocumentInputError) {
        setErrorField(reason.code === 'invalid-title' ? 'title' : reason.code === 'invalid-filename' ? 'filename' : undefined);
      }
      return;
    }

    const targetProjectId = projectId;
    const epoch = requestEpoch.current;
    setBusy(true);
    let file: ProjectFile;
    try {
      file = await createProjectDocument(targetProjectId, request);
    } catch (reason) {
      if (mounted.current && requestEpoch.current === epoch && projectIdRef.current === targetProjectId) {
        const nativeMessage = reason instanceof Error ? reason.message : String(reason);
        setError(nativeMessage.startsWith('document-pdf-glyph:')
          ? t('documentCreate.unsupportedGlyph')
          : t('documentCreate.createError'));
        setBusy(false);
      }
      return;
    }

    if (!mounted.current || requestEpoch.current !== epoch || projectIdRef.current !== targetProjectId) return;
    setBusy(false);
    onCreated(file);
    onClose();
  };

  const sourceBytes = new TextEncoder().encode(source).byteLength;
  let outputName = '';
  try {
    outputName = projectDocumentName(fileNameBase, format);
  } catch {
    // Keep the suffix hint visible while the user is entering a name.
  }
  const desktopAvailable = isTauri();

  return <WorkspaceDialog title={t('documentCreate.title')} wide onClose={handleClose}>
    <div className="documentComposer" ref={composerRef} aria-busy={busy} onKeyDown={preventOuterFormSubmit}>
      {!desktopAvailable && <p className="documentComposerNotice" role="status">{t('documentCreate.desktopOnly')}</p>}

      <div className="documentComposerFields">
        <label>
          <span>{t('documentCreate.titleLabel')}</span>
          <input
            autoFocus
            disabled={busy}
            value={title}
            onChange={event => { setTitle(event.target.value); setError(''); setErrorField(undefined); }}
            aria-invalid={errorField === 'title'}
          />
        </label>

        <div className="documentComposerRow">
          <label>
            <span>{t('documentCreate.formatLabel')}</span>
            <select disabled={busy} value={format} onChange={event => { setFormat(event.target.value as DocumentFormat); setError(''); setErrorField(undefined); }}>
              <option value="docx">{t('documentCreate.format.docx')}</option>
              <option value="pdf">{t('documentCreate.format.pdf')}</option>
              <option value="xlsx">{t('documentCreate.format.xlsx')}</option>
            </select>
          </label>
          <label className="documentComposerFileName">
            <span>{t('documentCreate.fileNameLabel')}</span>
            <input
              disabled={busy}
              aria-label={t('documentCreate.fileNameLabel')}
              value={fileNameBase}
              onChange={event => { setFileNameBase(event.target.value); setError(''); setErrorField(undefined); }}
              aria-describedby="documentComposerNameHint"
              aria-invalid={errorField === 'filename'}
            />
            <span className="documentComposerNameHint" id="documentComposerNameHint">
              {outputName || `${fileNameBase || '…'}.${format}`}
            </span>
          </label>
        </div>

        <label className="documentComposerSource">
          <span>{t(format === 'xlsx' ? 'documentCreate.csvLabel' : 'documentCreate.contentLabel')}</span>
          <textarea
            rows={14}
            maxLength={256_000}
            disabled={busy}
            spellCheck={format !== 'xlsx'}
            value={source}
            onChange={event => updateSource(event.target.value)}
            aria-describedby="documentComposerSourceHint documentComposerSourceCount"
          />
        </label>

        <div className="documentComposerSourceMeta">
          <p id="documentComposerSourceHint">
            {t(format === 'xlsx' ? 'documentCreate.csvHint' : 'documentCreate.markdownHint')}
          </p>
          {format === 'xlsx' && <p className="documentComposerLiteralNote">{t('documentCreate.literalCsvNote')}</p>}
          <span id="documentComposerSourceCount" aria-live="polite">
            {t('documentCreate.textLimit', { bytes: sourceBytes.toLocaleString(i18n.language) })}
          </span>
        </div>
      </div>

      {error && <p className="documentComposerError" role="alert">{error}</p>}

      <div className="documentComposerActions">
        <Button type="button" disabled={busy} onClick={handleClose}>{t('documentCreate.cancel')}</Button>
        <Button type="button" className="primary" disabled={busy || !desktopAvailable} onClick={() => void submit()}>
          {t(busy ? 'documentCreate.creating' : 'documentCreate.save')}
        </Button>
      </div>
    </div>
  </WorkspaceDialog>;
}
