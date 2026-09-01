import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const candidates = [
  process.env.PYTHON,
  process.platform === "win32" ? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : null,
  "python3",
  "python"
].filter(Boolean);

let executable = null;
for (const candidate of candidates) {
  if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) continue;
  const check = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  if (!check.error && check.status === 0) {
    executable = candidate;
    break;
  }
}
if (!executable) {
  console.error("Python 3 runtime was not found. Set the PYTHON environment variable.");
  process.exit(1);
}

const result = spawnSync(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, PYTHONPATH: join(process.cwd(), "container") }
});
process.exit(result.status ?? 1);
