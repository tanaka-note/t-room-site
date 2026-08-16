import { loadWebAppRegistry, syncContentHashApp } from "./web-app-registry.mjs";

const registry = await loadWebAppRegistry();
const results = [];
for (const app of registry.apps) results.push(await syncContentHashApp(app, registry.contract));
for (const result of results) {
  const suffix = result.changed.length ? ` (${result.changed.length}ファイル更新)` : " (変更なし)";
  process.stdout.write(`${result.app}: ${result.build}${suffix}\n`);
}
