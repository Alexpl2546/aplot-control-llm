import { useTranslation } from 'react-i18next';
import type { ChatMessage } from './stream';
import { isRussianReasoning } from './reasoningLanguage';
import { Button } from '../../components/ui/Primitives';

export function ReasoningText({ message, canTranslate, onTranslate, onStop }: { message: ChatMessage; canTranslate: boolean; onTranslate: () => void; onStop: () => void }) {
  const { t } = useTranslation();
  const original = message.reasoning ?? '';
  if (!original) return null;
  const translated = message.reasoningTranslation === 'done';
  const russian = isRussianReasoning(original);
  const translating = message.reasoningTranslation === 'pending';
  return <details className="chatReasoning">
    <summary>{t(translated ? 'chat.reasoningTranslated' : 'chat.reasoning')}</summary>
    <div lang={translated || russian ? 'ru' : undefined}>{translated ? message.reasoningRu : original}</div>
    {translated && <details className="chatReasoningOriginal"><summary>{t('chat.reasoningOriginal')}</summary><div>{original}</div></details>}
    {!translated && !russian && <div className="chatReasoningActions">
      {translating ? <><span role="status">{t('chat.translatingReasoning')}</span><Button type="button" onClick={onStop}>{t('chat.stopTranslation')}</Button></> : <Button type="button" disabled={!canTranslate} onClick={onTranslate} title={t('chat.translationHint')}>{t('chat.translateReasoning')}</Button>}
    </div>}
    {message.reasoningTranslation === 'failed' && <p role="status">{t('chat.translationFailed')}</p>}
    {message.reasoningTranslation === 'stopped' && <p role="status">{t('chat.translationStopped')}</p>}
  </details>;
}
