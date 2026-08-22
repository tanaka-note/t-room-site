import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const DISABLE_GLOBAL_RUNTIME_SQL = `INSERT INTO security_runtime_state
  (id, passkey_session_epoch, switch_observed_enabled)
VALUES (1, 1, 1)
ON CONFLICT(id) DO NOTHING;
UPDATE security_runtime_state
SET passkey_session_epoch = passkey_session_epoch + 1,
    switch_observed_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1 AND switch_observed_enabled = 1;
SELECT passkey_session_epoch, switch_observed_enabled
FROM security_runtime_state WHERE id = 1;`;

export const READ_GLOBAL_RUNTIME_SQL = `SELECT passkey_session_epoch, switch_observed_enabled
FROM security_runtime_state WHERE id = 1;`;

export const ENABLE_GLOBAL_RUNTIME_SQL = `UPDATE security_runtime_state
SET switch_observed_enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1 AND switch_observed_enabled = 0;
SELECT passkey_session_epoch, switch_observed_enabled
FROM security_runtime_state WHERE id = 1;`;

function d1Step(kind, sql) {
  return { kind, args: ["d1", "execute", "security-db", "--remote", "--json", "--command", sql] };
}

function switchStep(value) {
  return { kind: "set-switch", value, args: ["secret", "bulk"] };
}

export function globalPasskeySwitchPlan(action) {
  if (action === "disable") {
    return [
      d1Step("disable-runtime", DISABLE_GLOBAL_RUNTIME_SQL),
      switchStep("false")
    ];
  }
  if (action === "enable") {
    return [
      d1Step("require-disabled-runtime", READ_GLOBAL_RUNTIME_SQL),
      switchStep("false"),
      switchStep("true"),
      d1Step("enable-runtime", ENABLE_GLOBAL_RUNTIME_SQL)
    ];
  }
  throw new Error("Usage: node tools/global-passkey-switch.mjs <disable|enable>");
}

export function readRuntimeState(output) {
  const commands = JSON.parse(output);
  const rows = Array.isArray(commands)
    ? commands.flatMap((item) => Array.isArray(item?.results) ? item.results : [])
    : [];
  const result = rows.findLast((item) => item?.passkey_session_epoch != null && item?.switch_observed_enabled != null);
  const epoch = Number(result?.passkey_session_epoch);
  const enabled = Number(result?.switch_observed_enabled);
  if (!Number.isInteger(epoch) || epoch < 1 || ![0, 1].includes(enabled)) {
    throw new Error("Security DBのglobal passkey runtime状態を確認できませんでした。");
  }
  return { epoch, enabled: enabled === 1 };
}

export function runGlobalPasskeySwitch(action, runner = runWrangler) {
  const plan = globalPasskeySwitchPlan(action);
  let runtime = null;
  for (const step of plan) {
    if (step.kind === "set-switch") {
      try {
        runner(step.args, JSON.stringify({ PASSKEY_ENABLED: step.value }));
      } catch (error) {
        if (action === "disable") {
          throw new Error(`Global passkey runtimeは停止済みですが、PASSKEY_ENABLED=falseの反映に失敗しました。enableせずpasskeys:disableを再実行してください。\n${errorMessage(error)}`);
        }
        const state = runtime?.enabled === false ? `epoch ${runtime.epoch}のruntime gateは停止状態を維持しています。` : "runtime gateの状態を再確認してください。";
        throw new Error(`PASSKEY_ENABLED=${step.value}の反映に失敗しました。${state}\n${errorMessage(error)}`);
      }
      continue;
    }

    try {
      runtime = readRuntimeState(runner(step.args).stdout);
    } catch (error) {
      if (step.kind === "disable-runtime") {
        throw new Error(`Global passkey runtime停止の完了状態を確認できませんでした。PASSKEY_ENABLEDは変更していません。enableせずpasskeys:disableを再実行してください。\n${errorMessage(error)}`);
      }
      if (step.kind === "enable-runtime") {
        throw new Error(`Runtime gate有効化の完了状態を確認できませんでした。epochは巻き戻していません。旧sessionは失効したままです。状態確認後にpasskeys:enableを再実行してください。\n${errorMessage(error)}`);
      }
      throw error;
    }
    if (step.kind === "require-disabled-runtime" && runtime.enabled) {
      throw new Error("Global passkey runtimeが停止完了状態ではありません。先にpnpm run passkeys:disableを完了してください。");
    }
    if (step.kind === "disable-runtime" && runtime.enabled) {
      throw new Error("Global passkey runtime gateを停止できませんでした。PASSKEY_ENABLEDは変更していません。");
    }
    if (step.kind === "enable-runtime" && !runtime.enabled) {
      throw new Error("PASSKEY_ENABLEDは更新されましたがruntime gateを有効化できませんでした。旧sessionは失効したままです。passkeys:enableを再実行してください。");
    }
  }
  return { enabled: action === "enable", epoch: runtime?.epoch ?? null };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Wrangler command failed.";
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
      ? `Security global passkey switch: enabled (session epoch ${result.epoch})`
      : `Security global passkey switch: disabled (session epoch ${result.epoch})`;
    console.log(message);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
