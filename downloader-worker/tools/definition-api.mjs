export const ACCOUNT = '277e86de986181599ce0db2b3ca1f186';
export const APPLICATION = 'a03c67ef-fbf0-4421-a1e2-972d2c06a4f8';
export const SECURITY_DB = '45c2e1ff-8ee1-4cc8-b8e5-cacc0846e475';
export const DOWNLOADER_DB = '1e047091-e838-4ec3-899d-62014b283660';
export const APPLICATION_PATH = `/containers/applications/${APPLICATION}`;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function category(path) {
  if (path === APPLICATION_PATH) return 'application';
  if (path === `${APPLICATION_PATH}/rollouts`) return 'rollout_list';
  if (path.startsWith(`${APPLICATION_PATH}/rollouts/`)) return 'rollout';
  if (/^\/d1\/database\/[a-f0-9-]+\/query$/.test(path)) return 'd1_query';
  if (path.endsWith('/credentials')) return 'registry_credentials';
  return 'other';
}
export class CloudflareError extends Error {
  constructor({ status = 0, codes = [], retryAfterMs = null, ray = null, method = 'GET', stage = 'other', kind = 'http' } = {}) {
    const safeCodes = codes.map(Number).filter(Number.isSafeInteger);
    super(`cloudflare_api_${status}${safeCodes.length ? '_' + safeCodes.join('_') : ''}`);
    this.name = 'CloudflareError';
    Object.assign(this, { status, codes: safeCodes, retryAfterMs, method, stage, kind,
      ray: /^[a-f0-9]+-[A-Z]{3}$/.test(ray || '') ? ray : null });
  }
}
export function safeError(error) {
  if (error instanceof CloudflareError) return { event: 'definition_api_error', status: error.status, codes: error.codes,
    retryAfterMs: error.retryAfterMs, ray: error.ray, method: error.method, stage: error.stage, kind: error.kind };
  return { event: /^definition_[a-z_]+$/.test(error?.message) ? error.message : 'definition_update_failed' };
}
export function cloudflareClient(token = process.env.CLOUDFLARE_API_TOKEN, {
  fetcher = fetch, sleep = delay, random = Math.random, clock = Date.now, readAttempts = 4, readBudgetMs = 90000
} = {}) {
  if (!token) throw new Error('cloudflare_token_missing');
  return async function api(path, method = 'GET', body, { readOnly = false } = {}) {
    // Explicit SELECT calls only; never retry D1 writes or any other POST here.
    const safe = method === 'GET' || (readOnly && category(path) === 'd1_query' && method === 'POST' && /^SELECT\b/i.test(body?.sql || ''));
    const start = clock();
    let slept = 0;
    for (let attempt = 0; ; attempt++) {
      let response, result, failure;
      try {
        response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000)
        });
        try { result = await response.json(); } catch { /* Preserve HTTP metadata even for HTML/errors/truncated JSON. */ }
        if (response.ok && result?.success === true && Object.hasOwn(result, 'result')) return result.result;
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter == null ? null : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - clock());
        failure = new CloudflareError({ status: response.status, codes: Array.isArray(result?.errors) ? result.errors.map(e => e.code) : [],
          retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null, ray: response.headers.get('cf-ray'),
          method, stage: category(path), kind: result ? 'http' : 'parse' });
      } catch {
        // Do not retain fetch errors/cause: URLs, headers and credentials can be included.
        failure = new CloudflareError({ method, stage: category(path), kind: 'transport' });
      }
      const transient = failure.status === 0 || failure.status === 429 || failure.status >= 500 || failure.kind === 'parse';
      const wait = Math.max(failure.retryAfterMs || 0, Math.min(8000, 1000 * 2 ** attempt) * (0.5 + random()));
      // A Retry-After outside our budget means stop, never retry before it.
      if (!safe || !transient || attempt + 1 >= readAttempts || Math.max(clock() - start, slept) + wait > readBudgetMs) throw failure;
      await sleep(wait); slept += wait;
    }
  };
}
export async function query(api, db, sql, params = []) {
  const result = await api(`/d1/database/${db}/query`, 'POST', { sql, params }, { readOnly: /^SELECT\b/i.test(sql) });
  if (!result?.[0]?.success) throw new Error('definition_database_failed');
  return result[0];
}
export async function readState(api) {
  return (await query(api, SECURITY_DB, "SELECT * FROM security_definition_updates WHERE service='downloader'")).results[0];
}
export function validImage(image) {
  return new RegExp(`^registry\\.cloudflare\\.com/${ACCOUNT}/t-room-downloader-downloadercontainer@sha256:[a-f0-9]{64}$`).test(image);
}
