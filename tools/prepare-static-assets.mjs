import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHtmlContract, expectedSiteBuild, loadWebAppRegistry } from "./web-app-registry.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(workspace, ".site-assets");
const publicDirectories = [
  ".well-known",
  "apps",
  "asset-report-k7m4q9x2",
  "assets",
  "columns",
  "diary",
  "images",
  "learning",
  "pagefind",
  "transfer"
];
const publicRootExtensions = new Set([".css", ".html", ".ico", ".js", ".png", ".webmanifest"]);
const publicRootFiles = new Set(["robots.txt"]);
const forbiddenNames = new Set([".dev.vars", ".env", ".git", ".wrangler", "node_modules", "tmp"]);
const forbiddenExtensions = new Set([".jks", ".keystore", ".log", ".map", ".py"]);

function assertInsideWorkspace(path) {
  const pathFromWorkspace = relative(workspace, path);
  if (!pathFromWorkspace || pathFromWorkspace.startsWith("..") || resolve(workspace, pathFromWorkspace) !== path) {
    throw new Error(`公開用フォルダの場所が不正です: ${path}`);
  }
}

function isSafePublicPath(source) {
  const parts = relative(workspace, source).split(/[\\/]/);
  if (parts.some((part) => forbiddenNames.has(part))) return false;
  return !forbiddenExtensions.has(extname(source).toLowerCase());
}

assertInsideWorkspace(output);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const directory of publicDirectories) {
  const source = resolve(workspace, directory);
  const destination = resolve(output, directory);
  await cp(source, destination, {
    recursive: true,
    filter: isSafePublicPath
  });
}

const rootEntries = await readdir(workspace, { withFileTypes: true });
for (const entry of rootEntries) {
  if (!entry.isFile() || (!publicRootExtensions.has(extname(entry.name).toLowerCase()) && !publicRootFiles.has(entry.name))) continue;
  await cp(join(workspace, entry.name), join(output, entry.name));
}

const webAppRegistry = await loadWebAppRegistry();
const rootSiteApp = webAppRegistry.apps.find((app) => app.id === "site");
if (!rootSiteApp) throw new Error("web-apps.jsonにroot site定義がありません。");
const rootSiteBuild = expectedSiteBuild();
for (const entrypoint of rootSiteApp.entrypoints) {
  const target = resolve(output, entrypoint);
  const html = await readFile(target, "utf8");
  await writeFile(target, ensureHtmlContract(html, rootSiteApp, webAppRegistry.contract, rootSiteBuild));
}

const publishedFiles = [];
async function collectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(target);
    else if (entry.isFile()) publishedFiles.push(relative(output, target));
  }
}
await collectFiles(output);

if (!publishedFiles.includes(join("asset-report-k7m4q9x2", "index.html"))) {
  throw new Error("資産運用報告ページが公開対象に含まれていません。");
}
if (publishedFiles.some((path) => /(?:^|[\\/])(?:cloud-worker|diary-worker|billing-worker|android-tcloud|android-tcloud-twa|android-diary-twa)(?:[\\/]|$)/.test(path))) {
  throw new Error("非公開のアプリケーションコードが公開対象に含まれています。");
}

process.stdout.write(`安全な公開用ファイルを${publishedFiles.length}件準備しました。\n`);
