import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = (await readFile(new URL("../public/billing.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
function source(name) {
  const match = script.match(new RegExp("(?:async )?function " + name + "\\([^]*?\n  \}"));
  assert.ok(match, name + " must exist");
  return match[0];
}

function setup(entry = null, settlement = null) {
  const ids = ["entry-id", "entry-record-type", "entry-account", "entry-document-type", "entry-date", "entry-category",
    "entry-amount", "entry-description", "entry-note", "other-direction", "settlement-direction", "settlement-method"];
  const el = Object.fromEntries(ids.map((id) => [id, { id, type: "text", value: "" }]));
  const fields = ids.map((id) => el[id]);
  el["entry-form"] = { reset: () => fields.forEach((field) => { field.value = ""; }), querySelectorAll: () => fields };
  el["entry-error"] = {};
  el["entry-dialog-title"] = {};
  el["document-filter"] = { value: "invoice" };
  el["entry-category"].replaceChildren = (option) => { el["entry-category"].value = option.value; };
  const dialog = el["entry-dialog"] = {
    open: false, closeCount: 0,
    showModal() { this.open = true; },
    close() { this.open = false; this.closeCount += 1; }
  };
  const confirmations = [];
  const context = {
    state: { summary: { account: { id: "account-1" } }, entryInitialSnapshot: null }, el,
    window: { matchMedia: () => ({ matches: true }) },
    DESKTOP_DIALOG_BACKDROP_MATCHER: "(min-width: 861px) and (hover: hover) and (pointer: fine)",
    confirm: (message) => { confirmations.push(message); return context.approve; }, approve: false,
    japanToday: () => "2026-09-06", formatInteger: (value) => value.toLocaleString("ja-JP"),
    updateCategoryOptions: (category) => { el["entry-category"].value = category; }, updateEntryMode: () => {},
    Option: function (label, value) { this.value = value; }
  };
  vm.createContext(context);
  vm.runInContext(["entryFormSnapshot", "openEntryDialog", "closeEntryDialog", "closeEntryFromDesktopBackdrop"].map(source).join("\n"), context);
  context.openEntryDialog(entry, settlement);
  return { context, el, dialog, confirmations };
}
const entry = { id: "entry-1", documentType: "invoice", entryDate: "2026-08-12", category: "purchase", amountYen: 1000, description: "買い物", note: "備考" };
const settlement = { id: "settlement-1", settlementDate: "2026-08-13", amountYen: 2000, direction: "incoming", method: "cash", note: "入金" };

test("unchanged new, existing and settlement forms close without confirmation", () => {
  for (const args of [[null, null], [entry, null], [null, settlement]]) {
    const { context, el, dialog, confirmations } = setup(...args);
    assert.ok(el["entry-date"].value && el["entry-category"].value, "initial date and category are populated");
    context.closeEntryDialog();
    assert.equal(dialog.closeCount, 1);
    assert.deepEqual(confirmations, []);
  }
});

test("changed values require confirmation; cancelling preserves the form", () => {
  for (const initial of [null, entry]) {
    for (const id of ["entry-description", "entry-date", "entry-account", "entry-document-type", "entry-category", "entry-amount", "entry-note"]) {
      const { context, el, dialog, confirmations } = setup(initial);
      const value = el[id].value + "変更";
      el[id].value = value;
      const before = context.entryFormSnapshot();
      context.closeEntryDialog();
      assert.deepEqual(confirmations, ["入力内容が保存されていません。破棄して閉じますか？"]);
      assert.equal(dialog.open, true);
      assert.equal(dialog.closeCount, 0);
      assert.equal(context.entryFormSnapshot(), before);
      assert.equal(el[id].value, value);
    }
  }
});

test("approving discard closes; reverting a change does not prompt", () => {
  const { context, el, dialog, confirmations } = setup(entry);
  el["entry-note"].value = "変更";
  context.approve = true;
  context.closeEntryDialog();
  assert.equal(dialog.closeCount, 1);
  assert.equal(confirmations.length, 1);
  context.openEntryDialog(entry);
  el["entry-note"].value = "変更";
  el["entry-note"].value = entry.note;
  context.closeEntryDialog();
  assert.equal(dialog.closeCount, 2);
  assert.equal(confirmations.length, 1);
});

test("buttons, desktop backdrop and Escape use the guard; successful saves close directly", () => {
  assert.match(script, /if \(button\.dataset\.closeDialog === "entry-dialog"\) \{\s*closeEntryDialog\(\);\s*return;/);
  assert.match(script, /el\["entry-dialog"\]\.addEventListener\("click", closeEntryFromDesktopBackdrop\)/);
  const cancelHandler = script.match(/el\["entry-dialog"\]\.addEventListener\("cancel", \(event\) => \{([^]*?)\n    \}\);/);
  assert.ok(cancelHandler);
  const { context, el, dialog, confirmations } = setup();
  context.closeEntryFromDesktopBackdrop({ target: {} });
  assert.equal(dialog.closeCount, 0);
  context.window.matchMedia = () => ({ matches: false });
  context.closeEntryFromDesktopBackdrop({ target: dialog });
  assert.equal(dialog.closeCount, 0, "touch backdrop remains unchanged");
  context.window.matchMedia = () => ({ matches: true });
  el["entry-note"].value = "入力中";
  context.closeEntryFromDesktopBackdrop({ target: dialog });
  assert.equal(dialog.closeCount, 0);
  assert.equal(confirmations.length, 1);
  let prevented = 0;
  context.event = { preventDefault() { prevented += 1; } };
  vm.runInContext(cancelHandler[1], context);
  assert.equal(prevented, 1);
  assert.equal(confirmations.length, 2);
  assert.equal(dialog.open, true);
  context.approve = true;
  vm.runInContext(cancelHandler[1], context);
  assert.equal(dialog.closeCount, 1);
  const save = source("saveEntry");
  assert.equal((save.match(/el\["entry-dialog"\]\.close\(\)/g) || []).length, 2, "entry and settlement success paths bypass discard confirmation");
  assert.doesNotMatch(save, /closeEntryDialog|confirm\(/);
});
