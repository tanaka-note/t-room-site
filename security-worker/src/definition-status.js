export const DEFINITION_MAX_AGE = 7 * 86400;
export const DEFINITION_WARNING_AGE = 5 * 86400;
export const UPDATE_STALE_AFTER = 36 * 3600;
export const MONITOR_STALE_AFTER = 3 * 3600;

// This is an observation of the verified deployed image, never permission to
// download. The Container still verifies its own definitions before every scan.
export function definitionStatus(row, now = Math.floor(Date.now() / 1000)) {
  const issues = [];
  const built = Number(row?.definition_unix);
  const verified = Number(row?.verified_at);
  const known = Boolean(row?.image && built > 0 && verified > 0 && built <= now + 300);
  if (!known) issues.push('unknown');
  else if (now - built > DEFINITION_MAX_AGE) issues.push('expired');
  else if (now - built >= DEFINITION_WARNING_AGE) issues.push('expiring');
  if (Number(row?.deployment_matches) !== 1 || !row?.image_checked_at || now - row.image_checked_at > UPDATE_STALE_AFTER) issues.push('deployment_unknown');
  if (Number(row?.automation_enabled) !== 1) issues.push('not_configured');
  if (!row?.last_attempt_at || now - row.last_attempt_at > UPDATE_STALE_AFTER) issues.push('updater_stopped');
  if (Number(row?.failure_count) >= 2) issues.push('update_failed');
  if (row?.last_result === 'running' && now > Number(row.lease_until || 0)) issues.push('update_interrupted');
  const hourly = Number(row?.hourly_monitor_checked_at);
  if (!Number.isSafeInteger(hourly) || hourly <= 0 || hourly > now + 300 || now - hourly > MONITOR_STALE_AFTER) issues.push('monitor_stopped');
  return {
    state: issues.length ? issues.join(',') : 'healthy', issues,
    generatedAt: known ? built : null, expiresAt: known ? built + DEFINITION_MAX_AGE : null,
    verifiedAt: verified > 0 ? verified : null, lastAttemptAt: row?.last_attempt_at || null,
    lastSuccessAt: row?.last_success_at || null, result: row?.last_result || 'unknown',
    failures: Number(row?.failure_count || 0), monitorCheckedAt: row?.monitor_checked_at || null,
    hourlyMonitorStartedAt: row?.hourly_monitor_started_at || null,
    hourlyMonitorCheckedAt: row?.hourly_monitor_checked_at || null,
    incidentChangedAt: row?.incident_changed_at || null
  };
}

export async function readDefinitionStatus(env) {
  try {
    return definitionStatus(await env.DB.prepare("SELECT * FROM security_definition_updates WHERE service='downloader'").first());
  } catch { return definitionStatus(null); }
}

export async function runDefinitionSchedule(event, env, dailyMaintenance) {
  if (event?.cron === '17 * * * *') return monitorDefinitions(env, undefined, 'hourly');
  if (event?.cron === '41 18 * * *') {
    await dailyMaintenance();
    return monitorDefinitions(env, undefined, 'daily');
  }
  console.error('clamav_monitor_unexpected_cron');
  throw new Error('clamav_monitor_unexpected_cron');
}

export async function monitorDefinitions(env, now = Math.floor(Date.now() / 1000), source = 'daily') {
  if (!['hourly', 'daily'].includes(source)) throw new Error('definition_monitor_source_invalid');
  console.log({ event: 'clamav_monitor', source, stage: 'started' });
  let stage = 'start_record';
  try {
    if (source === 'hourly') {
      const started = await env.DB.prepare(`UPDATE security_definition_updates
        SET hourly_monitor_started_at=MAX(COALESCE(hourly_monitor_started_at,0),?) WHERE service='downloader'`).bind(now).run();
      if (started.meta?.changes !== 1) throw new Error('definition_monitor_row_missing');
    }
    stage = 'read';
    const row = await env.DB.prepare("SELECT * FROM security_definition_updates WHERE service='downloader'").first();
    if (!row) throw new Error('definition_monitor_row_missing');
    // Only the hourly path can recover its heartbeat, atomically with the incident.
    // Daily maintenance must evaluate the last real hourly completion unchanged.
    const status = definitionStatus(source === 'hourly' ? { ...row, hourly_monitor_checked_at: now } : row, now);
    stage = 'complete_record';
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO security_definition_events(occurred_at,state)
        SELECT ?,? FROM security_definition_updates WHERE service='downloader' AND incident != ?`).bind(now, status.state, status.state),
      env.DB.prepare(`UPDATE security_definition_updates SET monitor_checked_at=MAX(COALESCE(monitor_checked_at,0),?),
        hourly_monitor_checked_at=CASE WHEN ?='hourly' THEN MAX(COALESCE(hourly_monitor_checked_at,0),?) ELSE hourly_monitor_checked_at END,
        incident_changed_at=CASE WHEN incident != ? THEN ? ELSE incident_changed_at END, incident=?
        WHERE service='downloader'`).bind(now, source, now, status.state, now, status.state),
      env.DB.prepare("DELETE FROM security_definition_events WHERE occurred_at < ?").bind(now - 180 * 86400)
    ]);
    console.log({ event: 'clamav_monitor', source, stage: 'completed' });
    return status;
  } catch {
    // Never log raw D1 errors, SQL parameters, credentials, or user data.
    console.error({ event: 'clamav_monitor', source, stage, result: 'failed' });
    throw new Error(`definition_monitor_${stage}_failed`);
  }
}
