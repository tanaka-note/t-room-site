import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await import("./prepare-static-assets.mjs");

const args = ["--dir", "diary-worker", "exec", "playwright", "test", "--config", "../tools/playwright.site.config.mjs"];
if (process.env.TROOM_UPDATE_VISUALS === "1") args.push("--update-snapshots");
const result = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/c", "pnpm", ...args], { cwd: root, stdio: "inherit", shell: false })
  : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
