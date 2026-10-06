// Transfers synthetic review ciphertext and its key entirely in memory.
// Never used by Worker deployment. No plaintext records or keys are written to disk.
import { unlockClient, unwrapMaster } from '../public/health-crypto.mjs';
export async function importReview(source) {
  const url = new URL(source);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/health/' || url.search || url.hash) throw new Error('ローカル確認環境のURLだけを引き継げます。');
  const origin = url.origin;
  async function request(path, body, headers = {}) {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: {Origin:origin,'Content-Type':'application/json',...headers},
      ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10000), redirect:'error' });
    if (!response.ok) throw new Error('以前の確認環境を読み込めませんでした。元の環境は維持されています。');
    return response;
  }
  const auth = await (await request('/review/auth',{person:'owner'})).json();
  const prf = new Uint8Array(auth.prf);
  let master;
  try {
    const response = await request('/health/api/passkey/handoff',{handoffToken:auth.handoffToken});
    const login = await response.json();
    const key = await unlockClient(prf,login.keyBundle.vault);
    master = await unwrapMaster(key,login.keyBundle.wrappedKey);
    const {records} = await (await request('/health/api/records',null,{Cookie:response.headers.get('set-cookie').split(';')[0],'X-Health-Session':login.sessionId})).json();
    if (!Array.isArray(records) || records.some(row=>!/^[A-Za-z0-9_-]{43}$/.test(row.id) || !/^[A-Za-z0-9_-]{16}$/.test(row.iv) || !/^[A-Za-z0-9_-]{22,180000}$/.test(row.ciphertext) || !Number.isSafeInteger(row.revision) || row.revision<1)) throw new Error('確認環境の暗号化記録を検証できませんでした。');
    return {master,records};
  } catch(error) { master?.fill(0); throw error; }
  finally { prf.fill(0); auth.prf.fill(0); }
}
