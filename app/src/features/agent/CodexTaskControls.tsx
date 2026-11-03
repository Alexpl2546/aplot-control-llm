import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reviewHostTask } from '../../services/agentTasks';
import { codexControlError } from './codexControlError';
import './codexTaskControls.css';

export function CodexTaskControls({
  taskId,
  workerGeneration,
  pending,
  disabled = false,
  onFork,
}: {
  taskId: string;
  /** Generation of the Codex worker currently backing this task. */
  workerGeneration?: number;
  pending: boolean;
  disabled?: boolean;
  /** Parent owns creation and persistence of the child workspace task. */
  onFork?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const hasGeneration = Number.isSafeInteger(workerGeneration) && (workerGeneration ?? 0) > 0;
  const canReview = !pending && hasGeneration && !disabled && !busy;
  const canFork = !!onFork && canReview;

  const review = async () => {
    if (!canReview || !workerGeneration) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await reviewHostTask({
        commandId: crypto.randomUUID(),
        taskId,
        expectedGeneration: workerGeneration,
      });
      setNotice(result.status === 'accepted' || result.status === 'dispatching'
        ? t('codex.controls.reviewStarted', { defaultValue: 'Review started.' })
        : t('codex.controls.reviewStatus', { defaultValue: 'Review status: {{status}}', status: result.status }));
    } catch (cause) {
      setError(codexControlError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const fork = async () => {
    if (!canFork || !onFork) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await onFork();
      setNotice(t('codex.controls.forkStarted', { defaultValue: 'Forked task created.' }));
    } catch (cause) {
      setError(codexControlError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return <section className="awCodexControls" aria-label={t('codex.controls.label', { defaultValue: 'Codex controls' })}>
    <div className="awCodexReviewRow">
      <span>{t('codex.controls.reviewHint', { defaultValue: 'Ask Codex to review the project’s uncommitted changes.' })}</span>
      <div className="awCodexControlActions">
        <button type="button" disabled={!canReview} onClick={() => void review()}>
          {t(busy ? 'codex.controls.working' : 'codex.controls.review', { defaultValue: busy ? 'Starting…' : 'Review changes' })}
        </button>
        {onFork && <button type="button" disabled={!canFork} onClick={() => void fork()}>
          {t(busy ? 'codex.controls.working' : 'codex.controls.fork', { defaultValue: busy ? 'Starting…' : 'Fork task' })}
        </button>}
      </div>
    </div>
    {error && <p className="awCodexControlError" role="alert">{error}</p>}
    {notice && <p className="awCodexControlNotice" role="status">{notice}</p>}
  </section>;
}
