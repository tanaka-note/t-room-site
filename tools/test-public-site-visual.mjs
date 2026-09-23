import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, [resolve(root, "tools/prepare-static-assets.mjs")]);

const args = ["--dir", "diary-worker", "exec", "playwright", "test", "--config", "../tools/playwright.site.config.mjs"];
if (process.env.TROOM_UPDATE_VISUALS === "1") args.push("--update-snapshots");
if (process.platform === "win32") run("cmd.exe", ["/d", "/c", "pnpm", ...args]);
else run("pnpm", args);
