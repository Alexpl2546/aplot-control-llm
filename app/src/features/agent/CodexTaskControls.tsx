import { useState, type FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { reviewHostTask, steerHostTask } from '../../services/agentTasks';
import './codexTaskControls.css';

function controlError(cause: unknown, t: TFunction) {
  const raw = String(cause).replace(/^Error:\s*/, '').trim();
  const code = raw.split(/[\s:]/, 1)[0]?.toLowerCase() ?? '';
  const messages: Record<string, string> = {
    busy: 'Codex is already working on this task.',
    stale: 'This turn changed. Try again on the current turn.',
    closed: 'The Codex session has ended. Start a new task.',
    changed: 'The Codex connection changed. Reopen the task to continue.',
    timeout: 'Codex did not confirm the request. Check the task before retrying.',
    'message-limit': 'Shorten the direction and try again.',
    'command-conflict': 'This request ID was already used for different input.',
  };
  return t(`codex.controls.errors.${code}`, {
    defaultValue: messages[code] ?? 'Codex could not complete that control. Try again.',
  }).slice(0, 180);
}

export function CodexTaskControls({
  taskId,
  activeTurnId,
  workerGeneration,
  pending,
  disabled = false,
  onFork,
}: {
  taskId: string;
  /** Native app-server turn id from the host's running turn row. */
  activeTurnId?: string;
  /** Generation of the Codex worker currently backing this task. */
  workerGeneration?: number;
  pending: boolean;
  disabled?: boolean;
  /** Parent owns creation and persistence of the child workspace task. */
  onFork?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const hasGeneration = Number.isSafeInteger(workerGeneration) && (workerGeneration ?? 0) > 0;
  const canSteer = !!activeTurnId && pending && hasGeneration && !disabled && !busy;
  const canReview = !pending && hasGeneration && !disabled && !busy;
  const canFork = !!onFork && canReview;

  const steer = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!canSteer || !activeTurnId || !workerGeneration || !message) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await steerHostTask({
        commandId: crypto.randomUUID(),
        taskId,
        expectedTurnId: activeTurnId,
        expectedGeneration: workerGeneration,
        text: message,
      });
      setText('');
      setNotice(t('codex.controls.steerAccepted', { defaultValue: 'Direction sent to the active turn.' }));
    } catch (cause) {
      setError(controlError(cause, t));
    } finally {
      setBusy(false);
    }
  };

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
      setError(controlError(cause, t));
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
      setError(controlError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return <section className="awCodexControls" aria-label={t('codex.controls.label', { defaultValue: 'Codex controls' })}>
    {activeTurnId && <form className="awCodexSteer" onSubmit={steer}>
      <label htmlFor={`codex-steer-${taskId}`}>{t('codex.controls.steerLabel', { defaultValue: 'Steer the active turn' })}</label>
      <div className="awCodexSteerRow">
        <textarea
          id={`codex-steer-${taskId}`}
          value={text}
          maxLength={100000}
          rows={1}
          disabled={!canSteer}
          placeholder={t('codex.controls.steerPlaceholder', { defaultValue: 'Add direction while Codex is working…' })}
          onChange={event => setText(event.target.value)}
        />
        <button type="submit" disabled={!canSteer || !text.trim()}>
          {t(busy ? 'codex.controls.working' : 'codex.controls.steer', { defaultValue: busy ? 'Sending…' : 'Steer' })}
        </button>
      </div>
    </form>}
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
