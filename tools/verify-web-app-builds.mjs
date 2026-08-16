import { expectedBuild, loadWebAppRegistry } from "./web-app-registry.mjs";

const registry = await loadWebAppRegistry();
const results = [];

function localShellAssetRefs(html, publicUrl) {
  const base = new URL(publicUrl);
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\brel=["'][^"']*(?:stylesheet|manifest)[^"']*["'][^>]*\bhref=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*(?:stylesheet|manifest)[^"']*["']/gi)
  ].map((match) => match[1]);
  return refs.flatMap((reference) => {
    const resolved = new URL(reference, base);
    if (resolved.origin !== base.origin || !/\.(?:css|js|webmanifest)$/i.test(resolved.pathname)) return [];
    return [`${resolved.pathname}${resolved.search}`];
  });
}

async function verifyPublishedAsset(assetUrl, expected, kind) {
  const url = new URL(assetUrl);
  const declaredVersion = url.searchParams.get("v");
  url.searchParams.set("app-version-check", Date.now().toString());
  const response = await fetch(url, { cache: "no-store", headers: { "X-TROOM-App-Version": "1" } });
  const ok = response.ok && (!declaredVersion || declaredVersion === expected);
  if (!ok) process.exitCode = 1;
  return { kind, url: assetUrl, status: response.status, declaredVersion, ok };
}

for (const app of registry.apps) {
  const expected = await expectedBuild(app, registry.contract);
  const publishedShellAssets = new Set();
  for (const publicUrl of app.publicUrls) {
    const url = new URL(publicUrl);
    url.searchParams.set("app-version-check", Date.now().toString());
    const response = await fetch(url, { cache: "no-store", headers: { "X-TROOM-App-Version": "1" } });
    const html = await response.text();
    for (const asset of localShellAssetRefs(html, publicUrl)) publishedShellAssets.add(asset);
    const actual = html.match(/<meta\s+name=["']troom-app-build["']\s+content=["']([^"']+)["']/i)?.[1] || "";
    const enabled = /<meta\s+name=["']troom-auto-update["']\s+content=["']enabled["']/i.test(html);
    const updater = /\/assets\/pwa-auto-update\.js\?v=([^"']+)/i.exec(html)?.[1] || "";
    const assetRefs = new Set([
      ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/gi),
      ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css(?:\?[^"']*)?)["']/gi)
    ].map((match) => new URL(match[1], publicUrl).href).filter((assetUrl) => new URL(assetUrl).origin === url.origin));
    const assets = [];
    for (const assetUrl of assetRefs) assets.push(await verifyPublishedAsset(assetUrl, expected, "asset"));
    results.push({ app: app.id, url: publicUrl, status: response.status, expected, actual, enabled, updater, assets });
    if (!response.ok || actual !== expected || !enabled || updater !== expected) {
      process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
      process.exitCode = 1;
    }
  }
  if (app.serviceWorker && app.serviceWorkerUrl) {
    const workerUrl = new URL(app.serviceWorkerUrl, app.publicUrls[0]).href;
    const url = new URL(workerUrl);
    url.searchParams.set("app-version-check", Date.now().toString());
    const response = await fetch(url, { cache: "no-store", headers: { "Service-Worker": "script" } });
    const script = await response.text();
    const cacheVersionMatches = !app.cachePrefix || script.includes(`${app.cachePrefix}${expected}`);
    const precacheMatches = app.precacheMode !== "html"
      || [...publishedShellAssets].every((asset) => script.includes(JSON.stringify(asset)));
    const existingVersions = app.precacheMode === "existing"
      ? [...script.matchAll(/\.(?:html|css|js|webmanifest)\?v=([^"'`\s)]+)/g)].map((match) => match[1])
      : [];
    const existingVersionsMatch = existingVersions.every((version) => version === expected);
    results.push({
      app: app.id,
      url: workerUrl,
      kind: "service-worker",
      status: response.status,
      expected,
      cacheVersionMatches,
      precacheMatches,
      existingVersionsMatch,
      shellAssets: [...publishedShellAssets]
    });
    if (!response.ok || !cacheVersionMatches || !precacheMatches || !existingVersionsMatch) {
      process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
      process.exitCode = 1;
    }
  }
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
