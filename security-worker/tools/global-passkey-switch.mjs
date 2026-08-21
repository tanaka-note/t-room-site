import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ADVANCE_GLOBAL_EPOCH_SQL = `UPDATE security_runtime_state
SET passkey_session_epoch = passkey_session_epoch + 1,
    switch_observed_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
RETURNING passkey_session_epoch;`;

export function globalPasskeySwitchPlan(action) {
  if (action === "disable") {
    return [
      { kind: "advance-epoch", args: ["d1", "execute", "security-db", "--remote", "--json", "--command", ADVANCE_GLOBAL_EPOCH_SQL] },
      { kind: "set-switch", value: "false", args: ["secret", "bulk"] }
    ];
  }
  if (action === "enable") return [{ kind: "set-switch", value: "true", args: ["secret", "bulk"] }];
  throw new Error("Usage: node tools/global-passkey-switch.mjs <disable|enable>");
}

export function readAdvancedEpoch(output) {
  const commands = JSON.parse(output);
  const result = Array.isArray(commands) ? commands.find((item) => item?.results?.[0]?.passkey_session_epoch != null) : null;
  const epoch = Number(result?.results?.[0]?.passkey_session_epoch);
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error("Security DBのpasskey session epochを更新できませんでした。");
  return epoch;
}

export function runGlobalPasskeySwitch(action, runner = runWrangler) {
  const plan = globalPasskeySwitchPlan(action);
  let epoch = null;
  for (const step of plan) {
    if (step.kind === "advance-epoch") epoch = readAdvancedEpoch(runner(step.args).stdout);
    else runner(step.args, JSON.stringify({ PASSKEY_ENABLED: step.value }));
  }
  return { enabled: action === "enable", epoch };
}

function runWrangler(args, input) {
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = resolve(workerRoot, "node_modules/wrangler/bin/wrangler.js");
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: workerRoot,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Wrangler command failed.");
  return result;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const result = runGlobalPasskeySwitch(process.argv[2]);
    const message = result.enabled
      ? "Security global passkey switch: enabled (current epoch preserved)"
      : `Security global passkey switch: disabled (session epoch ${result.epoch})`;
    console.log(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Security global passkey switch failed.");
    process.exitCode = 1;
  }
}
