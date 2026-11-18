const retiredPages = new Set([
  '/investment', '/investment-bitcoin-decline', '/investment-boj-rate-hike',
  '/investment-btc-four-year-cycle', '/investment-performance', '/thought',
]);
const retiredDirectories = new Set(['/learning', '/columns', '/transfer', '/health', '/images/learning']);
const retiredAssets = new Set(['/investment-performance.css', '/assets/investment-chart-bg.png']);

export function isRetiredSitePath(path) {
  if (retiredPages.has(path.replace(/(?:\.html)?\/?$/, '')) || retiredAssets.has(path)) return true;
  if (path === '/learning.html' || path === '/learning.html/') return true;
  for (const directory of retiredDirectories) {
    if (path === directory || path.startsWith(`${directory}/`)) return true;
  }
  return false;
}

export function retiredServiceResponse(request) {
  return new Response(request.method === 'HEAD' ? null : 'Gone', {
    status: 410,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
