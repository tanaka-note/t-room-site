import { lineBrowserResponse } from "../assets/line-browser-worker.mjs";

export const LEGACY_REPORT = '/asset-report-k7m4q9x2';
// Keep this URL available for installed legacy PWAs, including old ?v= values.
// Never clear another app's caches or registrations on this origin.
export const retirementWorker = `
const OLD = '/asset-report-k7m4q9x2/';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter(key => key.startsWith('asset-report-shell-')).map(key => caches.delete(key)));
  await self.clients.claim();
  const windows = await self.clients.matchAll({type: 'window'});
  await Promise.all(windows.filter(client => new URL(client.url).pathname.startsWith(OLD)).map(client => client.navigate('/asset-report/').catch(() => {})));
  await self.registration.unregister();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(OLD)) return;
  event.respondWith(Promise.resolve(event.request.mode === 'navigate'
    ? Response.redirect(new URL('/asset-report/', self.location.origin), 308)
    : new Response('Gone', {status: 410, headers: {'Cache-Control': 'no-store'}})));
});
`;

export function legacyReportResponse(request) {
  const url = new URL(request.url);
  if (url.pathname !== LEGACY_REPORT && !url.pathname.startsWith(`${LEGACY_REPORT}/`)) return null;
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status: 405, headers: {...headers, Allow: 'GET, HEAD'}});
  if (url.pathname === `${LEGACY_REPORT}/service-worker.js`) {
    return new Response(request.method === 'HEAD' ? null : retirementWorker, {headers: {...headers, 'Content-Type': 'application/javascript; charset=utf-8'}});
  }
  if ([LEGACY_REPORT, `${LEGACY_REPORT}/`, `${LEGACY_REPORT}/index.html`].includes(url.pathname)) {
    return new Response(null, {status: 308, headers: {...headers, Location: '/asset-report/'}});
  }
  return new Response(request.method === 'HEAD' ? null : 'Gone', {status: 410, headers});
}
export default {
  fetch(request, env) {
    return lineBrowserResponse(request) || legacyReportResponse(request) || env.ASSETS.fetch(request);
  }
};
