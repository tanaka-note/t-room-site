// Local synthetic review only. This file is outside the Worker bundle and assets.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../test/fixture.js';
import { handleRequest, CONTENT_SECURITY_POLICY } from '../src/worker.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function startReview(port = 0) {
  const f = await fixture(); const issued = new Map();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(incoming.url, origin);
      if (!['127.0.0.1', 'localhost'].includes(String(incoming.headers.host).split(':')[0])) { outgoing.writeHead(403); outgoing.end(); return; }
      if (url.pathname === '/review/auth' && incoming.method === 'POST') {
        if (incoming.headers.origin !== origin) { outgoing.writeHead(403); outgoing.end(); return; }
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks).toString());
        const person = input.person === 'subject' ? 'subject' : 'owner';
        const token = f.issue(person);
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); outgoing.end(JSON.stringify({ prf: Array.from(f.users[person].prf), handoffToken: token })); return;
      }
      if (url.pathname === '/security/passkey-client.js') {
        outgoing.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        outgoing.end(`globalThis.TRoomPasskeys={authenticate:async()=>{const r=await fetch('/review/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({person:document.getElementById('review-person').value})});const v=await r.json();return {prfOutput:new Uint8Array(v.prf),handoff:{handoffToken:v.handoffToken}};}};`); return;
      }
      if (url.pathname === '/security/health.html') { outgoing.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); outgoing.end('<h1>ローカル確認環境</h1><p>この環境のログインは合成データ用です。Security Center・実パスキーの接続は含みません。</p><a href="/health/">戻る</a>'); return; }
      const mapping = new Map([['/assets/pwa-auto-update.js','assets/pwa-auto-update.js'],['/diary/dialog-navigation.js','diary-worker/public/dialog-navigation.js']]);
      if (url.pathname === '/') { outgoing.writeHead(302, { Location: '/health/' }); outgoing.end(); return; }
      if (!url.pathname.startsWith('/health/api/')) {
        const relative = mapping.get(url.pathname) || (url.pathname.startsWith('/health/') ? `health-worker/public/${url.pathname.slice(8) || 'index.html'}` : null);
        if (!relative || relative.includes('..')) { outgoing.writeHead(404); outgoing.end(); return; }
        let data = await readFile(resolve(root, relative));
        if (relative.endsWith('index.html')) data = Buffer.from(data.toString().replace('<body>', '<body><div class="card" id="review-banner"><strong>ローカル確認用・合成データのみ／終了すると記録は消えます</strong><label>操作する利用者<select id="review-person"><option value="owner">田中宏知（確認用）</option><option value="subject">田中暢美（確認用）</option></select></label></div>'));
        outgoing.writeHead(200, { 'Content-Type': relative.endsWith('.html') ? 'text/html;charset=utf-8' : relative.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store', 'Content-Security-Policy': CONTENT_SECURITY_POLICY }); outgoing.end(data); return;
      }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(['GET','HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) });
      const response = await handleRequest(request, f.env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) { outgoing.writeHead(e.status || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); outgoing.end(JSON.stringify({ error: e.status ? e.message : '確認環境で処理に失敗しました。' })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/health/`, fixture: f, close: async () => { await new Promise(resolve => server.close(resolve)); f.master.fill(0); f.db.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startReview(Number(process.env.HEALTH_REVIEW_PORT || 8793));
  console.log(`Local synthetic review: ${instance.url}`);
  process.once('SIGINT', async () => { await instance.close(); process.exit(0); });
}
