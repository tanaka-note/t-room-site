import { createHash } from 'node:crypto';
import { APPLICATION_PATH, DOWNLOADER_DB, query, validImage, delay, safeError } from './definition-api.mjs';

// workers-sdk tag wrangler@4.128.0, ApplicationRollout.status.
export const ROLLOUT_STATUSES = ['pending', 'progressing', 'completed', 'reverted', 'replaced'];
// There is no documented idempotency key, conditional create, or bounded
// visibility guarantee. Once dispatched, even an apparently absent POST must
// not be sent again automatically. Read reconciliation may run in later jobs.
export const MAX_SUBMISSIONS = 1;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function configurationHash(app) {
  // Only a hash is stored; do not persist configuration/env/credential values.
  const { configuration, rollout_active_grace_period, max_instances, instances, constraints, scheduling_policy } = app;
  return createHash('sha256').update(JSON.stringify(canonical({ configuration, rollout_active_grace_period,
    max_instances, instances, constraints, scheduling_policy }))).digest('hex');
}
const snapshotKey = app => `${app.version}:${app.active_rollout_id || ''}:${configurationHash(app)}`;
const outcome = (state, details = {}) => ({ state, ...details });
const baselineIds = row => JSON.parse(row.pending_rollout_ids || '[]');
function validateApplication(app) {
  if (!validImage(app?.configuration?.image) || app.rollout_active_grace_period !== 900 || !Number.isSafeInteger(app.version)) {
    throw new Error('definition_application_mismatch');
  }
}

export async function observeRollout(api, row) {
  const app = await api(APPLICATION_PATH);
  validateApplication(app);
  // No limit: generated client explicitly specifies that the default is ALL.
  const rollouts = await api(`${APPLICATION_PATH}/rollouts`);
  if (!Array.isArray(rollouts) || rollouts.some(r => !r?.id)) throw new Error('definition_rollout_list_invalid');
  const id = app.active_rollout_id || row.pending_rollout_id;
  let rollout, missing = false;
  if (id) {
    try { rollout = await api(`${APPLICATION_PATH}/rollouts/${encodeURIComponent(id)}`); }
    catch (error) { if (error.status !== 404) throw error; missing = true; }
  }
  const after = await api(APPLICATION_PATH);
  if (snapshotKey(app) !== snapshotKey(after)) return outcome('rollout_ambiguous');
  const base = { app, rollouts, rollout, key: snapshotKey(app), id };
  const listed = rollouts.find(r => r.id === id);
  if (rollout && (rollout.id !== id || (listed && (listed.target_configuration?.image !== rollout.target_configuration?.image || listed.status !== rollout.status)))) {
    return outcome('rollout_ambiguous', base);
  }
  const image = app.configuration.image;
  if (row.pending_image && ![row.pending_previous_image, row.pending_image].includes(image)) return outcome('rollout_conflict', base);
  const newRollouts = row.pending_image ? rollouts.filter(r => !baselineIds(row).includes(r.id)) : [];
  if (newRollouts.some(r => r.target_configuration?.image !== row.pending_image) || newRollouts.length > 1) return outcome('rollout_conflict', base);
  if (app.active_rollout_id && missing) {
    // A list entry is evidence against stale, even if the individual GET is 404.
    return outcome(listed ? 'rollout_ambiguous' : 'missing_active', base);
  }
  if (!row.pending_image) {
    if (app.active_rollout_id) return outcome(rollout && !ROLLOUT_STATUSES.includes(rollout.status) ? 'rollout_unknown_status' : 'rollout_conflict', base);
    // Do not start a deployment while an untracked running rollout is visible.
    if (rollouts.some(r => !ROLLOUT_STATUSES.includes(r.status))) return outcome('rollout_unknown_status', base);
    if (rollouts.some(r => ['pending', 'progressing'].includes(r.status))) return outcome('rollout_ambiguous', base);
    return outcome('ready', base);
  }
  rollout ||= newRollouts[0];
  if (rollout) {
    base.rollout = rollout; base.id = rollout.id;
    if (rollout.target_configuration?.image !== row.pending_image || rollout.current_configuration?.image !== row.pending_previous_image ||
      rollout.current_version !== row.pending_version || ![rollout.current_version, rollout.target_version].includes(app.version)) return outcome('rollout_conflict', base);
    if (!ROLLOUT_STATUSES.includes(rollout.status)) return outcome('rollout_unknown_status', base);
    if (['reverted', 'replaced'].includes(rollout.status)) return outcome(`rollout_${rollout.status}`, base);
    if (row.pending_rollout_id && row.pending_rollout_id !== rollout.id) return outcome('rollout_conflict', base);
    if (['pending', 'progressing'].includes(rollout.status)) return outcome('rollout_pending', base);
    if (app.active_rollout_id) return outcome('rollout_pending', base);
  }
  if (!app.active_rollout_id && image === row.pending_image) return outcome('applied', base);
  if (app.active_rollout_id) return outcome('rollout_ambiguous', base);
  if (app.version !== row.pending_version || configurationHash(app) !== row.pending_configuration_hash) return outcome('rollout_conflict', base);
  if (rollout || missing || newRollouts.length) return outcome('rollout_ambiguous', base);
  return outcome(Number(row.pending_attempts) === 0 ? 'ready' : 'absent_after_dispatch', base);
}

export async function settleObservation(api, row, { sleep = delay } = {}) {
  let previous, repeated = 0, observation;
  for (let i = 0; i < 3; i++) {
    observation = await observeRollout(api, row);
    if (!['missing_active', 'absent_after_dispatch', 'rollout_ambiguous'].includes(observation.state)) return observation;
    const key = `${observation.state}:${observation.key}`;
    repeated = key === previous ? repeated + 1 : 1; previous = key;
    if (i < 2) await sleep(10000 * 2 ** i);
  }
  if (observation.state === 'missing_active' && repeated === 3) return { ...observation, state: 'stale_rollout' };
  if (observation.state === 'absent_after_dispatch' && repeated === 3) return { ...observation, state: 'reconciliation_stuck' };
  return { ...observation, state: 'rollout_ambiguous' };
}

export function validPending(row, now, { deploying = false } = {}) {
  return validImage(row.pending_image) && validImage(row.pending_previous_image) && validImage(row.pending_source_image) &&
    Number.isSafeInteger(row.pending_definition_unix) && row.pending_definition_unix > 0 && row.pending_definition_unix <= now + 300 &&
    now - row.pending_definition_unix < (deploying ? 5 : 7) * 86400 &&
    Number.isSafeInteger(row.pending_verified_at) && row.pending_verified_at > 0 && row.pending_verified_at <= now + 300 &&
    row.pending_verified_at >= row.pending_definition_unix - 300 && row.pending_verified_at <= row.pending_started_at + 300;
}

export async function saveObservation(lease, row, observation) {
  const state = observation.state;
  // Never reset the submission counter when handing off to another run.
  const adoptId = ['rollout_pending', 'applied', 'stale_rollout'].includes(state) ? observation.id : null;
  await lease.write('pending_state=?,pending_reconciliations=pending_reconciliations+1,last_result=?,pending_rollout_id=COALESCE(pending_rollout_id,?)',
    [state, state, adoptId || null], row.pending_image || undefined);
  return outcome(state, { pending: true });
}

export async function reconcileRollout({ api, lease, now, target, sleep = delay, maxPolls = 60, deadline = now() + 30 * 60 }) {
  for (let poll = 0; poll < maxPolls; poll++) {
    await lease.renew();
    let row = await lease.check(), observation;
    try { observation = await settleObservation(api, row, { sleep }); }
    catch (error) {
      console.error(safeError(error));
      return saveObservation(lease, row, outcome('rollout_ambiguous'));
    }
    await saveObservation(lease, row, observation);
    if (observation.state === 'applied') {
      if (!validPending(row, now())) return saveObservation(lease, row, outcome('candidate_expired'));
      // Final production read and CAS precede success; acceptance alone is not success.
      await lease.renew();
      const finalApp = await api(APPLICATION_PATH);
      if (snapshotKey(finalApp) !== snapshotKey(observation.app)) continue;
      await lease.write(`image=pending_image,previous_image=pending_previous_image,source_image=pending_source_image,
        definition_unix=pending_definition_unix,verified_at=pending_verified_at,last_success_at=?,image_checked_at=?,
        deployment_matches=1,last_result='success',failure_count=0,pending_image=NULL,pending_previous_image=NULL,pending_source_image=NULL,
        pending_definition_unix=NULL,pending_verified_at=NULL,pending_started_at=NULL,pending_rollout_id=NULL,pending_state=NULL,
        pending_attempts=0,pending_reconciliations=0,pending_version=NULL,pending_configuration_hash=NULL,pending_rollout_ids=NULL`, [now(), now()], row.pending_image);
      console.log('Verified definition image rollout completed');
      return { image: row.pending_image, verified: true, definitionUnix: row.pending_definition_unix, verifiedAt: row.pending_verified_at, maxAgeSeconds: 604800 };
    }
    if (observation.state === 'ready') {
      if (!validPending(row, now(), { deploying: true })) return saveObservation(lease, row, outcome('candidate_expired'));
      if (row.pending_attempts >= MAX_SUBMISSIONS) return saveObservation(lease, row, outcome('reconciliation_stuck'));
      await lease.renew();
      const current = await lease.check();
      if (current.pending_image !== row.pending_image || current.pending_attempts !== row.pending_attempts) throw new Error('definition_pending_changed');
      const jobs = await query(api, DOWNLOADER_DB, "SELECT COUNT(*) AS count FROM downloader_jobs WHERE status IN ('queued','processing','analyzing')");
      if (Number(jobs.results[0].count) !== 0) {
        await saveObservation(lease, row, outcome('rollout_deferred'));
        return { deferred: true, pending: true, state: 'rollout_deferred' };
      }
      const finalApp = await api(APPLICATION_PATH);
      if (snapshotKey(finalApp) !== snapshotKey(observation.app)) continue;
      // CAS the durable dispatch marker BEFORE the non-idempotent request.
      // A crash in this tiny window is conservatively ambiguous, never a resend.
      await lease.write("pending_attempts=pending_attempts+1,pending_state='rollout_ambiguous',last_result='rollout_ambiguous'", [], row.pending_image);
      await lease.check();
      console.log('Starting image-only rollout; Worker code and existing grace period are unchanged');
      try {
        const rollout = await api(`${APPLICATION_PATH}/rollouts`, 'POST', {
          description: 'Daily verified ClamAV definitions', strategy: 'rolling', kind: 'full_auto',
          steps: [10, 100].map(percentage => ({ step_size: { percentage }, description: `Rollout to ${percentage}% of instances` })),
          target_configuration: target(finalApp.configuration, row.pending_image)
        });
        if (typeof rollout?.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(rollout.id)) {
          await lease.write("pending_rollout_id=?,pending_state='rollout_pending',last_result='rollout_pending'", [rollout.id], row.pending_image);
        }
      } catch (error) { console.error(safeError(error)); }
      // No second POST path: next iteration observes provider state first.
      poll--; // The dispatch itself cannot consume the last reconciliation slot.
      continue;
    }
    if (observation.state !== 'rollout_pending') return { pending: true, state: observation.state };
    if (now() >= deadline || poll + 1 >= maxPolls) return { pending: true, state: 'rollout_pending' };
    await sleep(Math.min(30000, Math.max(0, (deadline - now()) * 1000)));
  }
  // A provider rollout still running is not a failed deployment.
  return { pending: true, state: 'rollout_pending' };
}
