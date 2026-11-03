import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkspaceDialog } from '../agent/WorkspacePanels';
import { readProjectFile } from '../../services/projectFiles';
import './projectFileTextPreview.css';

export interface ProjectFileTextPreviewProps {
  projectId: string;
  fileId: string;
  name: string;
  onClose: () => void;
}

const MAX_PREVIEW_CHARS = 200_000;

type PreviewState = {
  projectId: string;
  fileId: string;
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  text?: string;
};

function boundPreviewText(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  let end = MAX_PREVIEW_CHARS;
  const lastCodeUnit = text.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function ProjectFileTextPreview({ projectId, fileId, name, onClose }: ProjectFileTextPreviewProps) {
  const { t } = useTranslation();
  const epochRef = useRef(0);
  const renderedIdentityRef = useRef({ projectId, fileId, revision: 0 });
  if (renderedIdentityRef.current.projectId !== projectId || renderedIdentityRef.current.fileId !== fileId) {
    renderedIdentityRef.current = {
      projectId,
      fileId,
      revision: renderedIdentityRef.current.revision + 1,
    };
  }
  const [request, setRequest] = useState<PreviewState>(() => ({ projectId, fileId, status: 'loading' }));

  useEffect(() => {
    const epoch = ++epochRef.current;
    const targetProjectId = projectId;
    const targetFileId = fileId;
    const targetRevision = renderedIdentityRef.current.revision;
    let active = true;
    const isCurrent = () =>
      active &&
      epochRef.current === epoch &&
      renderedIdentityRef.current.projectId === targetProjectId &&
      renderedIdentityRef.current.fileId === targetFileId &&
      renderedIdentityRef.current.revision === targetRevision;

    setRequest({ projectId: targetProjectId, fileId: targetFileId, status: 'loading' });
    void readProjectFile(targetProjectId, targetFileId)
      .then(result => {
        if (!isCurrent()) return;
        if (typeof result.text !== 'string' || result.text.length === 0) {
          setRequest({ projectId: targetProjectId, fileId: targetFileId, status: 'unavailable' });
          return;
        }
        setRequest({
          projectId: targetProjectId,
          fileId: targetFileId,
          status: 'ready',
          text: boundPreviewText(result.text),
        });
      })
      .catch(() => {
        if (isCurrent()) setRequest({ projectId: targetProjectId, fileId: targetFileId, status: 'error' });
      });

    return () => {
      active = false;
      if (epochRef.current === epoch) epochRef.current += 1;
    };
  }, [projectId, fileId]);

  const currentRequest = request.projectId === projectId && request.fileId === fileId
    ? request
    : { projectId, fileId, status: 'loading' as const };
  const translate = (key: string, defaultValue: string) =>
    t(`projectFiles.${key}`, { defaultValue });

  return (
    <WorkspaceDialog title={translate('previewTitle', 'Text preview')} wide onClose={onClose}>
      <section className="projectFileTextPreview" aria-busy={currentRequest.status === 'loading'}>
        <p className="projectFileTextPreviewName">{name}</p>
        <p className="projectFileTextPreviewNote">
          {translate('previewNote', 'Text preview only; formatting and formula calculation are not reproduced.')}
        </p>
        {currentRequest.status === 'loading' ? (
          <p className="projectFileTextPreviewState" role="status">
            {translate('previewLoading', 'Loading text preview…')}
          </p>
        ) : currentRequest.status === 'error' ? (
          <p className="projectFileTextPreviewError" role="alert">
            {translate('previewError', 'The text preview could not be loaded.')}
          </p>
        ) : currentRequest.status === 'unavailable' ? (
          <p className="projectFileTextPreviewState" role="status">
            {translate('previewUnavailable', 'Text preview is not available for this file.')}
          </p>
        ) : (
          <pre className="projectFileTextPreviewContent" aria-label={name}>{currentRequest.text}</pre>
        )}
      </section>
    </WorkspaceDialog>
  );
}
