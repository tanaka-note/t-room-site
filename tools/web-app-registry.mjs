import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(workspace, "web-apps.json");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".webmanifest"]);

export async function loadWebAppRegistry() {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

export function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

export function expectedSiteBuild() {
  return `site-${getGitCommit()}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertMeta(html, name, content) {
  const pattern = new RegExp(`<meta\\s+[^>]*name=["']${escapeRegExp(name)}["'][^>]*>`, "i");
  const tag = `<meta name="${name}" content="${content}">`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
}

function withVersion(url, build) {
  const [beforeHash, hash = ""] = url.split("#", 2);
  const [path, query = ""] = beforeHash.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("v", build);
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

function isLocalVersionedAsset(url) {
  if (!url || /^(?:[a-z]+:)?\/\//i.test(url) || /^(?:data|blob):/i.test(url)) return false;
  return /\.(?:css|js|webmanifest)(?:[?#]|$)/i.test(url);
}

function versionLocalAssets(html, build) {
  return html
    .replace(/(<script\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (match, start, url, end) => (
      isLocalVersionedAsset(url) ? `${start}${withVersion(url, build)}${end}` : match
    ))
    .replace(/(<link\b[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (match, start, url, end) => (
      isLocalVersionedAsset(url) ? `${start}${withVersion(url, build)}${end}` : match
    ));
}

export function ensureHtmlContract(html, app, contract, build) {
  let output = upsertMeta(html, contract.buildMeta, build);
  for (const meta of app.extraBuildMetas || []) output = upsertMeta(output, meta, build);
  output = upsertMeta(output, contract.autoUpdateMeta, contract.autoUpdateValue);
  if (app.serviceWorkerUrl) {
    output = upsertMeta(output, contract.serviceWorkerMeta, withVersion(app.serviceWorkerUrl, build));
  }
  const updaterPattern = /<script\b[^>]*\bsrc=["'][^"']*\/assets\/pwa-auto-update\.js[^"']*["'][^>]*><\/script>/i;
  const updaterTag = `<script src="${contract.updaterSource}?v=${build}" defer></script>`;
  if (updaterPattern.test(output)) output = output.replace(updaterPattern, updaterTag);
  else output = output.replace(/<\/body>/i, `  ${updaterTag}\n</body>`);
  return versionLocalAssets(output, build);
}

function normalizeTextForHash(text, app, contract) {
  let normalized = ensureHtmlContract(text, app, contract, "__TROOM_BUILD__");
  normalized = normalized.replace(/const\s+CACHE_NAME\s*=\s*["'][^"']+["']/g, 'const CACHE_NAME = "__TROOM_CACHE__"');
  normalized = normalized.replace(/const\s+APP_BUILD_ID\s*=\s*["'][^"']+["']/g, 'const APP_BUILD_ID = "__TROOM_BUILD__"');
  return normalized;
}

async function listFiles(root) {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".wrangler", "tmp"].includes(entry.name)) continue;
    const target = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

export async function filesForApp(app) {
  const paths = new Set([resolve(workspace, "assets/pwa-auto-update.js")]);
  for (const root of app.buildRoots || []) {
    for (const file of await listFiles(resolve(workspace, root))) paths.add(file);
  }
  for (const file of app.buildFiles || []) paths.add(resolve(workspace, file));
  return [...paths].sort((left, right) => relative(workspace, left).localeCompare(relative(workspace, right)));
}

export async function expectedContentBuild(app, contract) {
  const hash = createHash("sha256");
  for (const file of await filesForApp(app)) {
    const pathFromWorkspace = relative(workspace, file).replaceAll("\\", "/");
    const buffer = await readFile(file);
    hash.update(pathFromWorkspace);
    hash.update("\0");
    if (textExtensions.has(extname(file).toLowerCase())) {
      hash.update(normalizeTextForHash(buffer.toString("utf8"), app, contract));
    } else {
      hash.update(buffer);
    }
    hash.update("\0");
  }
  return `${app.id}-${hash.digest("hex").slice(0, 12)}`;
}

export async function expectedBuild(app, contract) {
  return app.buildMode === "prepared-commit" ? expectedSiteBuild() : expectedContentBuild(app, contract);
}

export async function syncContentHashApp(app, contract) {
  if (app.buildMode !== "content-hash") return { app: app.id, build: await expectedBuild(app, contract), changed: [] };
  const build = await expectedContentBuild(app, contract);
  const changed = [];
  for (const entrypoint of app.entrypoints) {
    const target = resolve(workspace, entrypoint);
    const before = await readFile(target, "utf8");
    const after = ensureHtmlContract(before, app, contract, build);
    if (after !== before) {
      await writeFile(target, after);
      changed.push(entrypoint);
    }
  }
  if (app.serviceWorker && app.cachePrefix) {
    const target = resolve(workspace, app.serviceWorker);
    const before = await readFile(target, "utf8");
    const after = before.replace(
      /const\s+CACHE_NAME\s*=\s*["'][^"']+["']\s*;/,
      `const CACHE_NAME = "${app.cachePrefix}${build}";`
    );
    if (after === before && !before.includes(`const CACHE_NAME = "${app.cachePrefix}${build}";`)) {
      throw new Error(`${app.id}: Service WorkerのCACHE_NAMEを更新できません。`);
    }
    if (after !== before) {
      await writeFile(target, after);
      changed.push(app.serviceWorker);
    }
  }
  for (const buildConstant of app.buildConstants || []) {
    const target = resolve(workspace, buildConstant);
    const before = await readFile(target, "utf8");
    const after = before.replace(
      /const\s+APP_BUILD_ID\s*=\s*["'][^"']+["']\s*;/,
      `const APP_BUILD_ID = "${build}";`
    );
    if (after === before && !before.includes(`const APP_BUILD_ID = "${build}";`)) {
      throw new Error(`${app.id}: APP_BUILD_IDを更新できません。`);
    }
    if (after !== before) {
      await writeFile(target, after);
      changed.push(buildConstant);
    }
  }
  return { app: app.id, build, changed };
}

export function validateAppDefinition(app) {
  const required = ["id", "name", "publicUrls", "entrypoints", "buildMode", "deployTarget", "deployCwd", "deployCommand"];
  const missing = required.filter((key) => app[key] == null || (Array.isArray(app[key]) && !app[key].length));
  if (missing.length) throw new Error(`${app.id || "unknown"}: registry項目が不足しています (${missing.join(", ")})`);
  if (!app.publicUrls.every((url) => url.startsWith("https://"))) throw new Error(`${app.id}: 公開URLはHTTPS必須です。`);
  if (!app.entrypoints.every((path) => path.endsWith(".html"))) throw new Error(`${app.id}: entrypointはHTMLで指定してください。`);
  if (!app.deployTarget.startsWith("t-room-")) throw new Error(`${app.id}: deploy targetが不正です。`);
  if (!app.buildMode) throw new Error(`${app.id}: 自動build方式がありません。`);
  return true;
}
