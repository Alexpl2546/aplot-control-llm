import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaGallery } from '../chat/MediaGallery';

export function ArtifactImagePreview({ taskId, artifactId, name }: { taskId: string; artifactId: string; name: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState(''), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  if (data) return <MediaGallery items={[{ id: artifactId, name, kind: 'image', data }]}/>;
  return <div><button type="button" disabled={loading} onClick={() => {
    setLoading(true); setFailed(false);
    void invoke<{ data: string }>('user_artifact_preview', { taskId, id: artifactId }).then(result => setData(result.data)).catch(() => setFailed(true)).finally(() => setLoading(false));
  }}>{t('agent.artifacts.preview', { defaultValue: 'Preview image' })}</button>{failed && <p role="alert">{t('chat.media.previewFailed')}</p>}</div>;
}
