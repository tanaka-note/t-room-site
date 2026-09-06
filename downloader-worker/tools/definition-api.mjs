export const ACCOUNT = '277e86de986181599ce0db2b3ca1f186';
export const APPLICATION = 'a03c67ef-fbf0-4421-a1e2-972d2c06a4f8';
export const SECURITY_DB = '45c2e1ff-8ee1-4cc8-b8e5-cacc0846e475';
export const DOWNLOADER_DB = '1e047091-e838-4ec3-899d-62014b283660';
export const APPLICATION_PATH = `/containers/applications/${APPLICATION}`;
export function cloudflareClient(token = process.env.CLOUDFLARE_API_TOKEN) {
  if (!token) throw new Error('cloudflare_token_missing');
  return async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(`cloudflare_api_${response.status}`);
    return result.result;
  };
}
export async function query(api, db, sql, params = []) {
  const result = await api(`/d1/database/${db}/query`, 'POST', { sql, params });
  if (!result?.[0]?.success) throw new Error('definition_database_failed');
  return result[0];
}
export async function readState(api) {
  return (await query(api, SECURITY_DB, "SELECT * FROM security_definition_updates WHERE service='downloader'")).results[0];
}
export function validImage(image) {
  return new RegExp(`^registry\\.cloudflare\\.com/${ACCOUNT}/t-room-downloader-downloadercontainer@sha256:[a-f0-9]{64}$`).test(image);
}

export async function waitForRollout(api, id, expectedImage, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rollout = await api(`${APPLICATION_PATH}/rollouts/${id}`);
    if (['failed', 'cancelled', 'rolled_back'].includes(rollout.status)) throw new Error('definition_rollout_failed');
    if (rollout.status === 'completed') {
      const app = await api(APPLICATION_PATH);
      if (app.configuration.image === expectedImage && !app.active_rollout_id) return app;
    }
    await sleep(30000);
  }
  throw new Error('definition_rollout_timeout');
}
