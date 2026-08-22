import assert from "node:assert/strict";
import test from "node:test";
import {
  DISABLE_GLOBAL_RUNTIME_SQL,
  ENABLE_GLOBAL_RUNTIME_SQL,
  READ_GLOBAL_RUNTIME_SQL,
  globalPasskeySwitchPlan,
  readRuntimeState,
  runGlobalPasskeySwitch
} from "../tools/global-passkey-switch.mjs";

function jsonState(state) {
  return JSON.stringify([{ results: [{
    passkey_session_epoch: state.epoch,
    switch_observed_enabled: state.runtimeEnabled ? 1 : 0
  }] }]);
}

function mockRunner(initial = {}, failures = {}) {
  const state = { epoch: 1, runtimeEnabled: true, secretEnabled: true, ...initial };
  const calls = [];
  const runner = (args, input) => {
    const call = { args, input };
    calls.push(call);
    if (args[0] === "secret") {
      const enabled = JSON.parse(input).PASSKEY_ENABLED === "true";
      if (failures.secret === String(enabled)) throw new Error(`secret ${enabled} failed`);
      state.secretEnabled = enabled;
      return { stdout: "" };
    }
    const sql = args.at(-1);
    if (sql === DISABLE_GLOBAL_RUNTIME_SQL) {
      if (failures.disableRuntime) throw new Error("runtime disable failed");
      if (state.runtimeEnabled) state.epoch += 1;
      state.runtimeEnabled = false;
    } else if (sql === ENABLE_GLOBAL_RUNTIME_SQL) {
      if (failures.enableRuntime) throw new Error("runtime enable failed");
      if (!state.runtimeEnabled) state.runtimeEnabled = true;
    } else if (sql !== READ_GLOBAL_RUNTIME_SQL) {
      throw new Error("unexpected SQL");
    }
    return { stdout: jsonState(state) };
  };
  return { state, calls, runner };
}

test("disable atomically advances the epoch and closes the runtime gate before changing the Secret", () => {
  const plan = globalPasskeySwitchPlan("disable");
  assert.deepEqual(plan.map((step) => step.kind), ["disable-runtime", "set-switch"]);
  assert.equal(plan[1].value, "false");
  assert.match(DISABLE_GLOBAL_RUNTIME_SQL, /passkey_session_epoch = passkey_session_epoch \+ 1/);
  assert.match(DISABLE_GLOBAL_RUNTIME_SQL, /switch_observed_enabled = 0/);
  assert.match(DISABLE_GLOBAL_RUNTIME_SQL, /WHERE id = 1 AND switch_observed_enabled = 1/);
  assert.doesNotMatch(DISABLE_GLOBAL_RUNTIME_SQL, /DELETE|DROP|TRUNCATE/i);

  const mock = mockRunner();
  assert.deepEqual(runGlobalPasskeySwitch("disable", mock.runner), { enabled: false, epoch: 2 });
  assert.deepEqual(mock.state, { epoch: 2, runtimeEnabled: false, secretEnabled: false });
  assert.equal(mock.calls[0].args.at(-1), DISABLE_GLOBAL_RUNTIME_SQL);
  assert.deepEqual(JSON.parse(mock.calls[1].input), { PASSKEY_ENABLED: "false" });
});

test("disable is idempotent and repeated OFF attempts do not keep advancing the epoch", () => {
  const mock = mockRunner();
  runGlobalPasskeySwitch("disable", mock.runner);
  runGlobalPasskeySwitch("disable", mock.runner);
  assert.equal(mock.state.epoch, 2);
  assert.equal(mock.state.runtimeEnabled, false);
  assert.equal(mock.state.secretEnabled, false);
});

test("a Secret failure leaves the runtime gate closed and requires disable recovery", () => {
  const mock = mockRunner({}, { secret: "false" });
  assert.throws(() => runGlobalPasskeySwitch("disable", mock.runner), /runtimeは停止済み.*enableせずpasskeys:disable/s);
  assert.deepEqual(mock.state, { epoch: 2, runtimeEnabled: false, secretEnabled: true });
  assert.equal(mock.state.runtimeEnabled && mock.state.secretEnabled, false,
    "the D1 runtime gate fails closed even if PASSKEY_ENABLED=false cannot be deployed");
});

test("a runtime failure does not attempt to change the Secret", () => {
  const mock = mockRunner({}, { disableRuntime: true });
  assert.throws(() => runGlobalPasskeySwitch("disable", mock.runner), /runtime disable failed/);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.state, { epoch: 1, runtimeEnabled: true, secretEnabled: true });
});

test("enable verifies disabled state, forces a false baseline, then opens the gate last", () => {
  const plan = globalPasskeySwitchPlan("enable");
  assert.deepEqual(plan.map((step) => step.kind), [
    "require-disabled-runtime", "set-switch", "set-switch", "enable-runtime"
  ]);
  assert.deepEqual(plan.filter((step) => step.kind === "set-switch").map((step) => step.value), ["false", "true"]);
  assert.match(ENABLE_GLOBAL_RUNTIME_SQL, /switch_observed_enabled = 1/);
  assert.match(ENABLE_GLOBAL_RUNTIME_SQL, /WHERE id = 1 AND switch_observed_enabled = 0/);

  const mock = mockRunner({ epoch: 2, runtimeEnabled: false, secretEnabled: false });
  assert.deepEqual(runGlobalPasskeySwitch("enable", mock.runner), { enabled: true, epoch: 2 });
  assert.deepEqual(mock.state, { epoch: 2, runtimeEnabled: true, secretEnabled: true });
  assert.equal(mock.calls.at(-1).args.at(-1), ENABLE_GLOBAL_RUNTIME_SQL,
    "the runtime gate is opened only after PASSKEY_ENABLED=true succeeds");
});

test("enable refuses an uncompleted disable without touching the Secret", () => {
  const mock = mockRunner();
  assert.throws(() => runGlobalPasskeySwitch("enable", mock.runner), /停止完了状態ではありません/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.state.secretEnabled, true);
});

test("enable failures never roll back the epoch or revive the runtime gate", () => {
  const falseFailure = mockRunner({ epoch: 2, runtimeEnabled: false, secretEnabled: false }, { secret: "false" });
  assert.throws(() => runGlobalPasskeySwitch("enable", falseFailure.runner), /PASSKEY_ENABLED=false/);
  assert.deepEqual(falseFailure.state, { epoch: 2, runtimeEnabled: false, secretEnabled: false });

  const trueFailure = mockRunner({ epoch: 2, runtimeEnabled: false, secretEnabled: false }, { secret: "true" });
  assert.throws(() => runGlobalPasskeySwitch("enable", trueFailure.runner), /PASSKEY_ENABLED=true/);
  assert.deepEqual(trueFailure.state, { epoch: 2, runtimeEnabled: false, secretEnabled: false });

  const activationFailure = mockRunner({ epoch: 2, runtimeEnabled: false, secretEnabled: false }, { enableRuntime: true });
  assert.throws(() => runGlobalPasskeySwitch("enable", activationFailure.runner), /runtime enable failed/);
  assert.deepEqual(activationFailure.state, { epoch: 2, runtimeEnabled: false, secretEnabled: true });
  assert.equal(activationFailure.state.runtimeEnabled && activationFailure.state.secretEnabled, false,
    "PASSKEY_ENABLED=true cannot issue a session until the runtime gate opens");
});

test("runtime state parsing rejects incomplete or malformed D1 output", () => {
  assert.deepEqual(readRuntimeState('[{"results":[{"passkey_session_epoch":7,"switch_observed_enabled":0}]}]'), { epoch: 7, enabled: false });
  assert.throws(() => readRuntimeState("[]"), /runtime状態/);
  assert.throws(() => readRuntimeState('[{"results":[{"passkey_session_epoch":0,"switch_observed_enabled":1}]}]'), /runtime状態/);
});
