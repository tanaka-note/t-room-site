import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectEntrypointShellAssets,
  ensureHtmlContract,
  expectedBuild,
  loadWebAppRegistry,
  validateAppDefinition,
  workspace
} from "./web-app-registry.mjs";

const registry = await loadWebAppRegistry();
assert.equal(registry.schemaVersion, 1);
assert.equal(registry.contract.autoUpdateValue, "enabled");

const ids = new Set();
const registeredHtml = new Set();
for (const app of registry.apps) {
  validateAppDefinition(app);
  assert(!ids.has(app.id), `app idが重複しています: ${app.id}`);
  ids.add(app.id);

  const wrangler = JSON.parse(await readFile(resolve(workspace, app.deployCwd, "wrangler.jsonc"), "utf8"));
  assert.equal(wrangler.name, app.deployTarget, `${app.id}: deploy targetがwranglerと一致しません`);
  const build = await expectedBuild(app, registry.contract);

  for (const entrypoint of app.entrypoints) {
    assert(!registeredHtml.has(entrypoint), `entrypointが重複しています: ${entrypoint}`);
    registeredHtml.add(entrypoint);
    const source = await readFile(resolve(workspace, entrypoint), "utf8");
    const contracted = app.buildMode === "prepared-commit"
      ? ensureHtmlContract(source, app, registry.contract, build)
      : source;
    assert.match(contracted, new RegExp(`<meta name="${registry.contract.buildMeta}" content="${build}">`), `${app.id}: build marker不足`);
    assert.match(contracted, new RegExp(`<meta name="${registry.contract.autoUpdateMeta}" content="enabled">`), `${app.id}: auto-update契約不足`);
    assert.match(contracted, /\/assets\/pwa-auto-update\.js\?v=[^"']+/, `${app.id}: 共通updater不足`);
    assert(!contracted.includes('content="diary"'), `${app.id}: 日記専用契約が残っています`);
  }

  if (app.serviceWorker) {
    await access(resolve(workspace, app.serviceWorker));
    assert(app.serviceWorkerUrl, `${app.id}: Service Worker URLがありません`);
    const worker = await readFile(resolve(workspace, app.serviceWorker), "utf8");
    const cacheConstant = app.cacheNameConstant || "CACHE_NAME";
    assert(worker.includes(`const ${cacheConstant} = "${app.cachePrefix}${build}";`), `${app.id}: Service Worker cacheがbuildと不一致`);
    if (app.serviceWorkerBuildConstant) {
      assert(worker.includes(`const ${app.serviceWorkerBuildConstant} = "${build}";`), `${app.id}: Service Worker build定数が不一致`);
    }
    if (app.precacheMode === "html") {
      const shellAssets = await collectEntrypointShellAssets(app, registry.contract, build);
      assert(shellAssets.length, `${app.id}: HTMLからapp shellを抽出できません`);
      for (const asset of shellAssets) {
        assert(worker.includes(JSON.stringify(asset)), `${app.id}: precacheに現在のHTML参照がありません (${asset})`);
      }
    } else if (app.precacheMode === "existing") {
      const versions = [...worker.matchAll(/\.(?:html|css|js|webmanifest)\?v=([^"'`\s)]+)/g)].map((match) => match[1]);
      assert(versions.every((version) => version === build), `${app.id}: 既存app shell内に旧build URLがあります`);
    }

    const clientSources = new Set(app.entrypoints);
    const publicRoot = new URL(app.publicUrls[0]).pathname;
    const buildRoot = app.buildRoots?.[0];
    if (buildRoot) {
      const shellAssets = await collectEntrypointShellAssets(app, registry.contract, build);
      for (const asset of shellAssets) {
        const pathname = new URL(asset, app.publicUrls[0]).pathname;
        if (!pathname.startsWith(publicRoot) || !pathname.endsWith(".js")) continue;
        clientSources.add(`${buildRoot}/${decodeURIComponent(pathname.slice(publicRoot.length))}`.replaceAll("//", "/"));
      }
    }
    for (const path of clientSources) {
      const source = await readFile(resolve(workspace, path), "utf8");
      assert.doesNotMatch(
        source,
        /navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/,
        `${app.id}: ${path}が共通Updaterと競合してService Workerを直接登録しています`
      );
    }
  }
  if (app.manifest) await access(resolve(workspace, app.manifest));
  if (app.twa) await access(resolve(workspace, app.twa));
}

for (const excluded of registry.excludedHtml) {
  assert(excluded.reason, `${excluded.path}: 対象外理由がありません`);
  registeredHtml.add(excluded.path);
}

const trackedHtml = execFileSync("git", ["ls-files", "*.html"], { cwd: workspace, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((path) => !path.startsWith(".site-assets/"));
const missing = trackedHtml.filter((path) => !registeredHtml.has(path));
assert.deepEqual(missing, [], `registry未登録のHTMLがあります: ${missing.join(", ")}`);

assert.throws(() => validateAppDefinition({
  id: "future-app",
  name: "新規サイト",
  publicUrls: ["https://tanaka-note.com/future/"],
  entrypoints: ["future/index.html"],
  deployTarget: "t-room-site",
  deployCwd: ".",
  deployCommand: "pnpm run site:deploy"
}), /buildMode|不足/, "自動更新build方式のない新規site definitionを拒否する必要があります");

const updater = await readFile(resolve(workspace, "assets/pwa-auto-update.js"), "utf8");
assert(!/AUTO_UPDATE_SCOPE_DIARY|isDiaryAutoUpdateEnabled/.test(updater), "共通Updaterに日記専用分岐が残っています");
assert.match(updater, /AUTO_UPDATE_ENABLED\s*=\s*"enabled"/);
assert.match(updater, /setInterval\(\(\) => void checkForUpdate\(\), CHECK_INTERVAL_MS\)/);
assert.equal((updater.match(/navigator\.serviceWorker\.register\s*\(/g) || []).length, 1, "Service Worker登録は共通Updaterの1か所へ集約します");
assert.doesNotMatch(updater, /controllerchange[\s\S]*?location\.reload\(/, "controllerchangeだけでreloadしてはいけません");

const legacyDiaryPages = ["diary.html", "diary/archive.html", "diary/tags.html"];
const requiredLegacyDiaryRobots = ["noindex", "nofollow", "noarchive", "nosnippet"];
for (const path of legacyDiaryPages) {
  const html = await readFile(resolve(workspace, path), "utf8");
  const robots = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i)?.[1] || "";
  const directives = new Set(robots.toLowerCase().split(",").map((directive) => directive.trim()).filter(Boolean));
  for (const directive of requiredLegacyDiaryRobots) {
    assert(directives.has(directive), `${path}: 旧静的日記のrobots指定に${directive}がありません`);
  }
}

const currentDiaryHtml = await readFile(resolve(workspace, "diary-worker/public/index.html"), "utf8");
assert.match(currentDiaryHtml, /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex[^"']*["']/i, "現行日記のnoindexを維持してください");
const publicHomeHtml = await readFile(resolve(workspace, "index.html"), "utf8");
assert.doesNotMatch(publicHomeHtml, /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex[^"']*["']/i, "公開トップをnoindexにしてはいけません");

process.stdout.write(`Web自動更新contract: ${registry.apps.length}アプリ・${registeredHtml.size} HTMLを確認しました。\n`);
