import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';

export function ApiKeyForm({ profileId, disabled, onSaved }: { profileId: string; disabled: boolean; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  return <form className="oaRename" onSubmit={event => {
    event.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true); setError(false);
    const submitted = key; setKey('');
    void invoke('openai_api_key_set', { profileId, apiKey: submitted }).then(onSaved).catch(() => setError(true)).finally(() => setBusy(false));
  }}>
    <label>{t('chatTools.apiKeyLabel', { defaultValue: 'OpenAI API key' })}<input type="password" autoComplete="off" spellCheck={false} className="uiInput" value={key} maxLength={1024} disabled={disabled || busy} onChange={event => setKey(event.target.value)} /></label>
    <Button type="submit" disabled={disabled || busy || key.trim().length < 16}>{t('aw.save')}</Button>
    <p className="oaHelp">{t('chatTools.apiBilling', { defaultValue: 'API usage is billed separately. The key is stored in protected native storage and is never included in chat exports.' })}</p>
    {error && <p role="alert" className="awError">{t('chatTools.apiKeyFailed', { defaultValue: 'Could not save the API key. Check the input and try again.' })}</p>}
  </form>;
}
