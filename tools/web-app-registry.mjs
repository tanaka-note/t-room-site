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

export function normalizeTextForHash(text, app, contract) {
  let normalized = ensureHtmlContract(text, app, contract, "__TROOM_BUILD__");
  const managedBuildQuery = new RegExp(`(\\?v=)(?:__TROOM_BUILD__|${escapeRegExp(app.id)}-[a-f0-9]{12})`, "g");
  normalized = normalized.replace(managedBuildQuery, "$1__TROOM_BUILD__");
  normalized = normalized.replace(/const\s+(?:CACHE_NAME|APP_SHELL_CACHE)\s*=\s*["'][^"']+["']/g, (match) => (
    match.replace(/["'][^"']+["']$/, '"__TROOM_CACHE__"')
  ));
  normalized = normalized.replace(/const\s+APP_BUILD_ID\s*=\s*["'][^"']+["']/g, 'const APP_BUILD_ID = "__TROOM_BUILD__"');
  normalized = normalized.replace(/const\s+MEDIA_WORKER_BUILD_ID\s*=\s*["'][^"']+["']/g, 'const MEDIA_WORKER_BUILD_ID = "__TROOM_BUILD__"');
  return normalized;
}

function localShellReferences(html, publicUrl) {
  const references = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) references.push(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel=["'][^"']*(?:stylesheet|manifest)[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href) references.push(href);
  }
  const base = new URL(publicUrl);
  return references.flatMap((reference) => {
    const resolved = new URL(reference, base);
    if (resolved.origin !== base.origin || !/\.(?:css|js|webmanifest)$/i.test(resolved.pathname)) return [];
    return [`${resolved.pathname}${resolved.search}`];
  });
}

export async function collectEntrypointShellAssets(app, contract, build) {
  const assets = new Set();
  for (let index = 0; index < app.entrypoints.length; index += 1) {
    const html = ensureHtmlContract(
      await readFile(resolve(workspace, app.entrypoints[index]), "utf8"),
      app,
      contract,
      build
    );
    const publicUrl = app.publicUrls[Math.min(index, app.publicUrls.length - 1)];
    for (const asset of localShellReferences(html, publicUrl)) assets.add(asset);
  }
  return [...assets].sort();
}

function replaceStringConstant(source, name, value) {
  const pattern = new RegExp(`const\\s+${escapeRegExp(name)}\\s*=\\s*["'][^"']+["']\\s*;`);
  const replacement = `const ${name} = "${value}";`;
  const output = source.replace(pattern, replacement);
  if (output === source && !source.includes(replacement)) throw new Error(`${name}を更新できません。`);
  return output;
}

function precacheEntryPath(expression, publicUrl) {
  const match = expression.match(/^["'`]([\s\S]+)["'`]$/);
  if (!match) return "";
  const base = new URL(publicUrl);
  const value = match[1].replaceAll("${APP_PATH}", base.pathname);
  if (value.includes("${")) return "";
  try { return new URL(value, base).pathname; } catch { return ""; }
}

function syncHtmlPrecacheArray(source, app, shellAssets) {
  const name = app.precacheConstant;
  const pattern = new RegExp(`const\\s+${escapeRegExp(name)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`);
  const match = source.match(pattern);
  if (!match) throw new Error(`${app.id}: ${name}を確認できません。`);
  const shellPaths = new Set(shellAssets.map((asset) => new URL(asset, app.publicUrls[0]).pathname));
  const kept = match[1].split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .filter((expression) => !shellPaths.has(precacheEntryPath(expression, app.publicUrls[0])));
  const entries = [...kept, ...shellAssets.map((asset) => JSON.stringify(asset))];
  return source.replace(pattern, `const ${name} = [\n  ${entries.join(",\n  ")}\n];`);
}

export function syncServiceWorkerText(source, app, build, shellAssets = []) {
  let output = source.replace(/(\.(?:html|css|js|webmanifest)\?v=)[^"'`\s)]+/g, `$1${build}`);
  output = replaceStringConstant(output, app.cacheNameConstant || "CACHE_NAME", `${app.cachePrefix}${build}`);
  if (app.serviceWorkerBuildConstant) output = replaceStringConstant(output, app.serviceWorkerBuildConstant, build);
  if (app.precacheMode === "html") output = syncHtmlPrecacheArray(output, app, shellAssets);
  return output;
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
  const changed = new Set();
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const build = await expectedContentBuild(app, contract);
    for (const entrypoint of app.entrypoints) {
      const target = resolve(workspace, entrypoint);
      const before = await readFile(target, "utf8");
      const after = ensureHtmlContract(before, app, contract, build);
      if (after !== before) {
        await writeFile(target, after);
        changed.add(entrypoint);
      }
    }
    if (app.serviceWorker && app.cachePrefix) {
      const target = resolve(workspace, app.serviceWorker);
      const before = await readFile(target, "utf8");
      const shellAssets = app.precacheMode === "html" ? await collectEntrypointShellAssets(app, contract, build) : [];
      const after = syncServiceWorkerText(before, app, build, shellAssets);
      if (after !== before) {
        await writeFile(target, after);
        changed.add(app.serviceWorker);
      }
      for (const copy of app.serviceWorkerCopies || []) {
        const copyTarget = resolve(workspace, copy);
        const copyBefore = await readFile(copyTarget, "utf8");
        if (copyBefore !== after) {
          await writeFile(copyTarget, after);
          changed.add(copy);
        }
      }
    }
    for (const buildConstant of app.buildConstants || []) {
      const target = resolve(workspace, buildConstant);
      const before = await readFile(target, "utf8");
      const after = replaceStringConstant(before, "APP_BUILD_ID", build);
      if (after !== before) {
        await writeFile(target, after);
        changed.add(buildConstant);
      }
    }
    if (await expectedContentBuild(app, contract) === build) return { app: app.id, build, changed: [...changed] };
  }
  throw new Error(`${app.id}: build同期が安定しません。`);
}

export function validateAppDefinition(app) {
  const required = ["id", "name", "publicUrls", "entrypoints", "buildMode", "deployTarget", "deployCwd", "deployCommand"];
  const missing = required.filter((key) => app[key] == null || (Array.isArray(app[key]) && !app[key].length));
  if (missing.length) throw new Error(`${app.id || "unknown"}: registry項目が不足しています (${missing.join(", ")})`);
  if (!app.publicUrls.every((url) => url.startsWith("https://"))) throw new Error(`${app.id}: 公開URLはHTTPS必須です。`);
  if (!app.entrypoints.every((path) => path.endsWith(".html"))) throw new Error(`${app.id}: entrypointはHTMLで指定してください。`);
  if (!app.deployTarget.startsWith("t-room-")) throw new Error(`${app.id}: deploy targetが不正です。`);
  if (!app.buildMode) throw new Error(`${app.id}: 自動build方式がありません。`);
  if (app.serviceWorker && (!app.cachePrefix || !app.precacheConstant || !["html", "existing"].includes(app.precacheMode))) {
    throw new Error(`${app.id}: Service Workerのcache/precache定義が不足しています。`);
  }
  return true;
}
