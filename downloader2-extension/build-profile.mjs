import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw new Error("usage: node build-profile.mjs <profile.json> <output-directory>");
const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
const productionOrigin = "https://tanaka-note.com";

function exactHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Controller origin must be an exact HTTPS origin: ${value}`);
  }
  return url.origin;
}

if (!['production', 'e2e'].includes(config.profile)) throw new Error("Profile must be production or e2e");
const origins = (config.controllerOrigins || []).map(exactHttpsOrigin);
const allowlist = new Set((config.allowedControllerOrigins || []).map(exactHttpsOrigin));
if (!origins.length || origins.some((origin) => !allowlist.has(origin))) throw new Error("Every controller origin must be present in the explicit profile allowlist");
if (config.profile === "production" && (origins.length !== 1 || origins[0] !== productionOrigin)) throw new Error("Production profile is fixed to tanaka-note.com");
if (config.profile === "e2e" && origins.some((origin) => origin === productionOrigin)) throw new Error("E2E profile must not use the Production controller origin");

const output = resolve(outputPath);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const name of ["service-worker.js", "content-script.js"]) cpSync(resolve(root, name), resolve(output, name));
cpSync(resolve(root, "capture"), resolve(output, "capture"), { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches = origins.map((origin) => `${origin}/downloader2/*`);
writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(output, "profile.js"), `globalThis.TLAIN_DOWNLOADER2_PROFILE = Object.freeze(${JSON.stringify({ id: config.profile, controllerOrigins: origins })});\n`);
console.log(`Built Downloader 2 ${config.profile} extension profile for ${origins.join(", ")}`);
