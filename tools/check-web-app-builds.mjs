import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appsForTarget, inspectBuildFreshness, loadWebAppRegistry } from "./web-app-registry.mjs";

export async function checkWebAppBuilds({ registry, target, baseDirectory, inspect = inspectBuildFreshness }) {
  const results = [];
  for (const app of appsForTarget(registry, target)) {
    results.push(await inspect(app, registry.contract, baseDirectory));
  }
  return results;
}

export function formatFreshnessFailure(result, target) {
  const details = result.issues
    .map((issue) => `  - ${issue.file} (${issue.kind}): repository actual=${issue.actual}`)
    .join("\n");
  return `${result.app}: build marker is stale\n  expected=${result.expected}\n${details}\n  sync: node tools/sync-web-app-builds.mjs --target ${target}`;
}

async function main() {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex < 0 ? undefined : process.argv[targetIndex + 1];
  if (targetIndex >= 0 && !target) throw new Error("--target requires an app id or deploy target");
  const registry = await loadWebAppRegistry();
  const results = await checkWebAppBuilds({ registry, target });
  const stale = results.filter((result) => !result.fresh);
  for (const result of results) {
    const status = result.skipped ? "prepared at release" : result.fresh ? "fresh" : "stale";
    process.stdout.write(`${result.app}: ${result.expected} (${status})\n`);
  }
  if (stale.length) {
    throw new Error(stale.map((result) => formatFreshnessFailure(result, target || result.app)).join("\n"));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
