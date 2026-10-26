import { remaining, type QuotaSnapshot, type useOpenAi } from './store';

type State = ReturnType<typeof useOpenAi.getState>;
export interface AccountLimit {
  id: string;
  minutes?: number;
  label?: string;
  remaining: number;
  resetsAt?: number;
  stale?: boolean;
}
export interface AccountQuota {
  id: string;
  name: string;
  email?: string;
  runtime: 'codex' | 'claude';
  limits: AccountLimit[];
}
function codexLimits(snapshot: QuotaSnapshot | undefined): AccountLimit[] {
  const buckets = snapshot?.rateLimitsByLimitId ?? (snapshot?.rateLimits ? { codex: snapshot.rateLimits } : {});
  return Object.entries(buckets).flatMap(([id, bucket]) => [bucket.primary, bucket.secondary].flatMap((window, index) => {
    if (!window || !Number.isFinite(window.usedPercent)) return [];
    return [{ id: `${id}:${index}`, minutes: window.windowDurationMins ?? undefined,
      label: id === 'codex' ? undefined : bucket.limitName ?? id,
      remaining: remaining(window), resetsAt: window.resetsAt ?? undefined }];
  }));
}
function claudeLimits(value: Record<string, unknown> | undefined): AccountLimit[] {
  if (!value) return [];
  const windows = value.unifiedWindows && typeof value.unifiedWindows === 'object'
    ? Object.entries(value.unifiedWindows) : [['current', value] as const];
  return windows.flatMap(([id, data]) => {
    if (!data || typeof data !== 'object') return [];
    const row = data as Record<string, unknown>;
    if (typeof row.utilization !== 'number' || !Number.isFinite(row.utilization)) return [];
    return [{ id, minutes: /week|7.?day|seven.?day|7d/i.test(id) ? 10080 : /5.?hour|five.?hour|5h/i.test(id) ? 300 : undefined,
      label: id === 'current' || /week|7.?day|seven.?day|7d|5.?hour|five.?hour|5h/i.test(id) ? undefined : id,
      remaining: Math.min(100, Math.max(0, 100 - row.utilization * 100)),
      resetsAt: typeof row.resetsAt === 'number' ? row.resetsAt : undefined }];
  });
}
/** Account ownership comes from verified status, never the currently selected default. */
export function accountQuotas(state: State): AccountQuota[] {
  return state.profiles.flatMap(profile => {
    const status = state.profileStatuses[profile.id];
    if (!profile.enabled || !status?.connected || !status.connectionId) return [];
    const cached = state.quotasByConnection[status.connectionId];
    const limits = profile.provider === 'openai'
      ? codexLimits(cached?.value).map(limit => ({ ...limit, stale: cached?.stale }))
      : claudeLimits(state.claudeLimitsByConnection[status.connectionId]?.value);
    const email=status.email?.trim()||profile.email?.trim();
    const name=profile.name.trim()||email||(profile.provider==='openai'?'Codex':'Claude');
    return [{ id: profile.id, name, email,
      runtime: profile.provider === 'openai' ? 'codex' as const : 'claude' as const, limits }];
  });
}
