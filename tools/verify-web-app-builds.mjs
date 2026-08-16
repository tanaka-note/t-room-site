import { expectedBuild, loadWebAppRegistry } from "./web-app-registry.mjs";

const registry = await loadWebAppRegistry();
const results = [];
for (const app of registry.apps) {
  const expected = await expectedBuild(app, registry.contract);
  for (const publicUrl of app.publicUrls) {
    const url = new URL(publicUrl);
    url.searchParams.set("app-version-check", Date.now().toString());
    const response = await fetch(url, { cache: "no-store", headers: { "X-TROOM-App-Version": "1" } });
    const html = await response.text();
    const actual = html.match(/<meta\s+name=["']troom-app-build["']\s+content=["']([^"']+)["']/i)?.[1] || "";
    const enabled = /<meta\s+name=["']troom-auto-update["']\s+content=["']enabled["']/i.test(html);
    const updater = /\/assets\/pwa-auto-update\.js\?v=([^"']+)/i.exec(html)?.[1] || "";
    results.push({ app: app.id, url: publicUrl, status: response.status, expected, actual, enabled, updater });
    if (!response.ok || actual !== expected || !enabled || updater !== expected) {
      process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
      process.exitCode = 1;
    }
  }
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
