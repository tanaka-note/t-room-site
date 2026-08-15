import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing entry dialog dismisses only on desktop backdrop", async () => {
  const script = await readFile(new URL("../public/billing.js", import.meta.url), "utf8");

  assert.match(script, /document\.querySelectorAll\("\[data-close-dialog\]"\)\.forEach\(\(button\) => button\.addEventListener\("click", \(\) => \{\s*if \(button\.dataset\.closeDialog === "entry-dialog"\) \{\s*closeEntryDialog\(\);\s*return;\s*\}\s*document\.getElementById\(button\.dataset\.closeDialog\)\.close\(\);\s*\}\)\);/s);
  assert.match(script, /el\["entry-dialog"\]\.addEventListener\("click", closeEntryFromDesktopBackdrop\)/);
  assert.match(script, /const DESKTOP_DIALOG_BACKDROP_MATCHER = "\(min-width: 861px\) and \(hover: hover\) and \(pointer: fine\)"/);
  assert.match(script, /function closeEntryDialog\(\) \{\s*if \(el\["entry-dialog"\]\?\.open\) el\["entry-dialog"\]\.close\(\);\s*\}/);
  assert.match(script, /function closeEntryFromDesktopBackdrop\(event\) \{\s*if \(event\.target !== el\["entry-dialog"\]\) return;\s*if \(!window\.matchMedia\(DESKTOP_DIALOG_BACKDROP_MATCHER\)\.matches\) return;\s*closeEntryDialog\(\);\s*\}/);

  const backdropSource = script.match(/function closeEntryFromDesktopBackdrop\(event\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(backdropSource);
  const context = {
    el: {
      "entry-dialog": {
        open: true,
        close: () => {
          context.el["entry-dialog"].open = false;
          context.el["entry-dialog"].closeCount += 1;
        }
      }
    },
    window: {
      matchMedia: () => ({ matches: true })
    }
  };
  context.el["entry-dialog"].closeCount = 0;
  context.closeEntryDialog = () => {
    context.el["entry-dialog"].close();
  };

  vm.runInNewContext(
    `const DESKTOP_DIALOG_BACKDROP_MATCHER = "(min-width: 861px) and (hover: hover) and (pointer: fine)"; ${backdropSource}; globalThis.handleBackdrop = closeEntryFromDesktopBackdrop;`,
    context
  );
  context.handleBackdrop({ target: {} });
  assert.equal(context.el["entry-dialog"].closeCount, 0, "clicks inside the dialog content must not close billing entry");
  context.handleBackdrop({ target: context.el["entry-dialog"] });
  assert.equal(context.el["entry-dialog"].closeCount, 1, "one desktop backdrop click closes billing entry");

  context.el["entry-dialog"].open = true;
  context.el["entry-dialog"].closeCount = 0;
  context.window.matchMedia = () => ({ matches: false });
  context.handleBackdrop({ target: context.el["entry-dialog"] });
  assert.equal(context.el["entry-dialog"].closeCount, 0, "touch-like environments do not close on backdrop");
});
