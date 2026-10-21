import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function infrastructureChecks(account, zone) {
  if (![account, zone].every(value => /^[a-f0-9]{32}$/.test(value || ''))) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ZONE_ID must be configured.');
  }
  return [
    ['Workers', `/accounts/${account}/workers/scripts`],
    ['D1', `/accounts/${account}/d1/database`],
    ['R2', `/accounts/${account}/r2/buckets`],
    ['KV', `/accounts/${account}/storage/kv/namespaces`],
    ['Queues', `/accounts/${account}/queues`],
    ['Containers', `/accounts/${account}/containers/applications`],
    ['DNS', `/zones/${zone}/dns_records`],
    ['Routes', `/zones/${zone}/workers/routes`]
  ];
}

// This verifies connectivity and read access only. Write grants are reviewed in
// Cloudflare's token policy; testing them must not mutate production resources.
export async function checkInfrastructure({ env = process.env, request = fetch, log = console.log } = {}) {
  const checks = infrastructureChecks(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ZONE_ID);
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN must be supplied by the cloud environment Network secret.');
  let failed = false;
  for (const [name, path] of checks) {
    let status = 'request failed';
    let ok = false;
    try {
      const response = await request(`https://api.cloudflare.com/client/v4${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
      });
      status = `HTTP ${response.status}`;
      const body = await response.json();
      ok = response.ok && body.success === true;
    } catch {
      // No response bodies, resource names, credentials, or raw exceptions.
    }
    log(`[infrastructure] ${name}: ${ok ? 'read access confirmed' : 'FAILED'} (${status})`);
    failed ||= !ok;
  }
  if (failed) throw new Error('Infrastructure access check failed; inspect the service/status above. No resources were changed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await checkInfrastructure(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
