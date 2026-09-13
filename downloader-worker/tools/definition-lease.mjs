import { randomUUID } from 'node:crypto';
import { query, readState, SECURITY_DB } from './definition-api.mjs';

export const LEASE_SECONDS = 45 * 60;
export async function claimLease(api, now, { heartbeatMs = 60000 } = {}) {
  const runId = `${process.env.GITHUB_RUN_ID || 'manual'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${randomUUID()}`;
  const claim = await query(api, SECURITY_DB, `UPDATE security_definition_updates SET run_id=?,lease_until=?,last_attempt_at=?,last_result='running',
    automation_enabled=MAX(automation_enabled,?) WHERE service='downloader' AND (lease_until IS NULL OR lease_until < ?)`,
  [runId, now() + LEASE_SECONDS, now(), process.env.GITHUB_ACTIONS === 'true' ? 1 : 0, now()]);
  if (claim.meta.changes !== 1) throw new Error('definition_update_already_running');
  let lost = false, chain = Promise.resolve();
  const controller = new AbortController();
  const fail = () => { lost = true; controller.abort(); throw new Error('definition_update_lease_expired'); };
  const renew = () => {
    chain = chain.then(async () => {
      if (lost) return fail();
      let changed;
      try {
        changed = await query(api, SECURITY_DB, `UPDATE security_definition_updates SET lease_until=?
          WHERE service='downloader' AND run_id=? AND lease_until>?`, [now() + LEASE_SECONDS, runId, now()]);
      } catch { return fail(); }
      if (changed.meta.changes !== 1) return fail();
    });
    return chain;
  };
  const timer = setInterval(() => { renew().catch(() => {}); }, heartbeatMs);
  timer.unref();
  return {
    runId, signal: controller.signal, renew,
    async check() {
      if (lost) return fail();
      const row = await readState(api);
      if (row.run_id !== runId || Number(row.lease_until) <= now() || lost) return fail();
      return row;
    },
    async write(set, values = [], expectedImage) {
      if (lost) return fail();
      const condition = expectedImage === undefined ? '' : ' AND pending_image=?';
      const result = await query(api, SECURITY_DB, `UPDATE security_definition_updates SET ${set}
        WHERE service='downloader' AND run_id=? AND lease_until>?${condition}`,
      [...values, runId, now(), ...(expectedImage === undefined ? [] : [expectedImage])]);
      if (result.meta.changes !== 1) return fail();
    },
    async stop() { clearInterval(timer); await chain.catch(() => {}); },
    async release() {
      clearInterval(timer); await chain.catch(() => {});
      // Never clear a replacement owner's lease, including during failure cleanup.
      await query(api, SECURITY_DB, "UPDATE security_definition_updates SET lease_until=NULL WHERE service='downloader' AND run_id=?", [runId]);
    }
  };
}
