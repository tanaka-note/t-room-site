// Shared by scheduled producers. Never include exception text or user data.
export async function reportRun(env, service, runId, state, details = {}, at = Date.now()) {
  const safe = {};
  for (const name of ['stage', 'reason', 'attempt', 'bytes', 'rowCount', 'deleted', 'remaining', 'pendingCount', 'pendingCapped', 'pending', 'oldestAgeDays']) {
    const value = details[name];
    if (typeof value === 'number' || typeof value === 'boolean') safe[name] = value;
    else if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) safe[name] = value;
  }
  if (details.oldestPendingAt && Number.isFinite(Date.parse(details.oldestPendingAt))) safe.oldestPendingAt = new Date(details.oldestPendingAt).toISOString();
  const event = { eventId: `${runId}-${state}`, occurredAt: new Date(at).toISOString(), service,
    eventType: `backup_${state}`, outcome: ['failed', 'partial', 'prune_failed'].includes(state) ? 'failure' : state === 'succeeded' ? 'success' : 'info',
    authMethod: 'system', targetType: 'backup', targetId: service === 'diary' && ['photos','photo-verification'].includes(details.kind) ? 'diary-' + details.kind : service, details: { runId, ...safe } };
  try {
    if (!env.SECURITY?.recordAuditEvent) throw new Error('AuditUnavailable');
    const response = await env.SECURITY.recordAuditEvent(event);
    if (response?.stored !== true) throw new Error('AuditNotStored');
    return true;
  } catch {
    try { if (env.SECURITY_AUDIT?.send) { await env.SECURITY_AUDIT.send(event); return true; } } catch {}
    console.error(JSON.stringify({ event: 'backup_audit_unavailable', service, runId, state }));
    return false;
  }
}

export function runState(events, { now = Date.now(), hour = 3, minute = 40 } = {}) {
  const priority = { backup_started: 0, backup_succeeded: 1, backup_partial: 2, backup_failed: 2, backup_prune_failed: 3 };
  const sorted = [...events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)
    || (priority[b.event_type] || 0) - (priority[a.event_type] || 0) || b.event_id.localeCompare(a.event_id));
  const latest = sorted[0];
  const success = sorted.find(e => e.event_type === 'backup_succeeded');
  const jst = new Date(now + 9 * 3600000);
  let expected = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour - 9, minute);
  if (now < expected + 2 * 3600000) expected -= 86400000; // Grace for bounded retries.
  let state = !latest || Date.parse(latest.occurred_at) < expected ? 'overdue'
    : ({ backup_started: 'running', backup_succeeded: 'ok', backup_failed: 'failed', backup_partial: 'partial', backup_prune_failed: 'prune_failed' }[latest.event_type] || 'unknown');
  if (state === 'running' && now - Date.parse(latest.occurred_at) > 2 * 3600000) state = 'overdue';
  const details = latest ? JSON.parse(latest.details_json || '{}') : {};
  return { state, lastAttemptAt: latest?.occurred_at || null, lastSuccessAt: success?.occurred_at || null,
    expectedAt: new Date(expected).toISOString(), stage: details.stage || null, reason: details.reason || null,
    attempt: details.attempt || null, pendingCount: details.pendingCount ?? null, pendingCapped: details.pendingCapped ?? false, oldestPendingAt: details.oldestPendingAt || null, pending: details.pending ?? null, observedAt: new Date(now).toISOString(), history: sorted.slice(0, 10).map(e => ({
      at: e.occurred_at, state: e.event_type.slice(7), ...JSON.parse(e.details_json || '{}') })) };
}
