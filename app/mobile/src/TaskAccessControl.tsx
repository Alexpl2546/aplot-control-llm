import { useEffect, useState } from 'react';
import { MobileApiError } from '../api';
import type { MobileAccessMode, MobileAccessReceipt } from '../types';
import { uuidV4 } from './uuid';
import './taskAccessControl.css';

export interface AccessChangeRequest {
  commandId: string;
  expectedRevision: number;
  accessMode: MobileAccessMode;
}

export function TaskAccessControl({ taskId, accessMode, revision, busy, allowedModes, onApply, onRefresh }: {
  taskId: string;
  accessMode: MobileAccessMode;
  revision: number;
  busy: boolean;
  allowedModes: readonly MobileAccessMode[];
  onApply: (request: AccessChangeRequest) => Promise<MobileAccessReceipt>;
  onRefresh: () => void;
}) {
  const [confirmFull, setConfirmFull] = useState(false);
  const [pending, setPending] = useState<AccessChangeRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (pending && pending.accessMode === accessMode) {
      setPending(null);
      setError('');
      setConfirmFull(false);
    }
  }, [accessMode, pending]);

  const apply = async (request: AccessChangeRequest) => {
    if (saving || busy) return;
    setPending(request);
    setSaving(true);
    setError('');
    try {
      const receipt = await onApply(request);
      if (receipt.taskId !== taskId || receipt.commandId !== request.commandId
        || receipt.accessMode !== request.accessMode || receipt.status !== 'updated') {
        throw new Error('access-receipt-mismatch');
      }
      setPending(null);
      setConfirmFull(false);
    } catch (cause) {
      if (cause instanceof MobileApiError && (cause.status === 409 || cause.status === 400 || cause.status === 403)) {
        setPending(null);
        setConfirmFull(false);
        setError(cause.status === 403 ? 'Сервер не разрешил изменение доступа.' : 'Состояние задачи изменилось. Проверьте режим и выберите его снова.');
        onRefresh();
      } else {
        setError('Изменение доступа не подтверждено. Повторите тот же запрос, чтобы проверить результат.');
      }
    } finally {
      setSaving(false);
    }
  };

  const change = (mode: MobileAccessMode) => {
    if (busy || saving || pending || accessMode === mode) return;
    void apply({ commandId: uuidV4(), expectedRevision: revision, accessMode: mode });
  };

  return <section className="task-access" aria-labelledby="task-access-title">
    <h3 id="task-access-title">Доступ агента</h3>
    <p className="task-access-current">Сейчас: <strong>{accessMode === 'full' ? 'полный доступ' : 'только чтение'}</strong></p>
    <div className="task-access-modes">
      {allowedModes.includes('restricted') && <button type="button" aria-pressed={accessMode === 'restricted'} disabled={busy || saving || Boolean(pending) || accessMode === 'restricted'} onClick={() => change('restricted')}>
        <strong>Только чтение</strong><span>Анализ проекта и веб-поиск</span>
      </button>}
      {allowedModes.includes('full') && <button type="button" aria-pressed={accessMode === 'full'} disabled={busy || saving || Boolean(pending) || accessMode === 'full'} onClick={() => setConfirmFull(true)}>
        <strong>Полный доступ</strong><span>Изменение файлов, команды и сеть на сервере</span>
      </button>}
    </div>
    {busy && <p className="task-access-help">Дождитесь завершения или остановите задачу, чтобы изменить доступ.</p>}
    {confirmFull && !pending && <div className="task-access-confirm" role="group" aria-label="Подтверждение полного доступа">
      <p>Агент сможет выполнять команды и изменять доступные пользователю сервера файлы, в том числе вне папки проекта. Разрешение действует для этой задачи.</p>
      <button className="task-access-allow" type="button" disabled={busy || saving} onClick={() => change('full')}>Разрешить полный доступ</button>
      <button type="button" onClick={() => setConfirmFull(false)}>Отмена</button>
    </div>}
    {saving && <p role="status">Сохраняем режим…</p>}
    {error && <p className="task-access-error" role="alert">{error}</p>}
    {pending && !saving && <button className="task-access-retry" type="button" disabled={busy} onClick={() => void apply(pending)}>Повторить изменение доступа</button>}
  </section>;
}
