import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appsForTarget, loadWebAppRegistry, syncContentHashApp } from "./web-app-registry.mjs";

export async function syncWebApps({ registry, target, baseDirectory, sync = syncContentHashApp }) {
  const results = [];
  for (const app of appsForTarget(registry, target)) {
    results.push(await sync(app, registry.contract, baseDirectory));
  }
  return results;
}

async function main() {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex < 0 ? undefined : process.argv[targetIndex + 1];
  if (targetIndex >= 0 && !target) throw new Error("--target requires an app id or deploy target");
  if (!target) await import("./sync-line-browser-policy.mjs");
  const registry = await loadWebAppRegistry();
  const results = await syncWebApps({ registry, target });
  for (const result of results) {
    const suffix = result.changed.length ? ` (${result.changed.length}ファイル更新)` : " (変更なし)";
    process.stdout.write(`${result.app}: ${result.build}${suffix}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
