import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCE_GLOBAL_EPOCH_SQL,
  globalPasskeySwitchPlan,
  readAdvancedEpoch,
  runGlobalPasskeySwitch
} from "../tools/global-passkey-switch.mjs";

test("global disable advances the persistent epoch before changing the Worker switch", () => {
  const plan = globalPasskeySwitchPlan("disable");
  assert.deepEqual(plan.map((step) => step.kind), ["advance-epoch", "set-switch"]);
  assert.equal(plan[1].value, "false");
  assert.match(ADVANCE_GLOBAL_EPOCH_SQL, /passkey_session_epoch = passkey_session_epoch \+ 1/);
  assert.match(ADVANCE_GLOBAL_EPOCH_SQL, /switch_observed_enabled = 0/);
  assert.doesNotMatch(ADVANCE_GLOBAL_EPOCH_SQL, /DELETE|DROP|TRUNCATE/i);
});

test("global enable preserves the epoch and only changes the Worker switch", () => {
  const plan = globalPasskeySwitchPlan("enable");
  assert.deepEqual(plan.map((step) => step.kind), ["set-switch"]);
  assert.equal(plan[0].value, "true");
});

test("the production switch runner cannot omit the disable epoch step", () => {
  const calls = [];
  const result = runGlobalPasskeySwitch("disable", (args, input) => {
    calls.push({ args, input });
    if (args[0] === "d1") return { stdout: JSON.stringify([{ results: [{ passkey_session_epoch: 2 }] }]) };
    return { stdout: "" };
  });
  assert.deepEqual(result, { enabled: false, epoch: 2 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], "d1");
  assert.equal(calls[1].args.join(" "), "secret bulk");
  assert.deepEqual(JSON.parse(calls[1].input), { PASSKEY_ENABLED: "false" });
});

test("invalid D1 output stops before the switch can change", () => {
  let switchCalled = false;
  assert.throws(() => runGlobalPasskeySwitch("disable", (args) => {
    if (args[0] === "d1") return { stdout: "[]" };
    switchCalled = true;
    return { stdout: "" };
  }), /epoch/);
  assert.equal(switchCalled, false);
  assert.equal(readAdvancedEpoch('[{"results":[{"passkey_session_epoch":7}]}]'), 7);
});
