import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function build(config) {
  const temp = mkdtempSync(resolve(tmpdir(), "downloader2-extension-profile-"));
  const configPath = resolve(temp, "profile.json");
  const output = resolve(temp, "out");
  writeFileSync(configPath, JSON.stringify(config));
  execFileSync(process.execPath, [resolve(root, "build-profile.mjs"), configPath, output]);
  return { temp, output };
}

test("Production profile remains fixed to the Downloader 2 Production page", () => {
  const { temp, output } = build({ profile: "production", controllerOrigins: ["https://tanaka-note.com"], allowedControllerOrigins: ["https://tanaka-note.com"] });
  try {
    const manifest = JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://tanaka-note.com/downloader2/*"]);
    assert.match(readFileSync(resolve(output, "profile.js"), "utf8"), /"production"/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("E2E profile embeds only an explicitly allowlisted isolated HTTPS origin", () => {
  const origin = "https://isolated-downloader2-preview.example.invalid";
  const { temp, output } = build({ profile: "e2e", controllerOrigins: [origin], allowedControllerOrigins: [origin] });
  try {
    const manifest = JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.content_scripts[0].matches, [`${origin}/downloader2/*`]);
    assert.match(readFileSync(resolve(output, "profile.js"), "utf8"), /"e2e"/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("E2E profile fails closed for Production, HTTP or a missing allowlist", () => {
  const cases = [
    { profile: "e2e", controllerOrigins: ["https://tanaka-note.com"], allowedControllerOrigins: ["https://tanaka-note.com"] },
    { profile: "e2e", controllerOrigins: ["http://localhost:8787"], allowedControllerOrigins: ["http://localhost:8787"] },
    { profile: "e2e", controllerOrigins: ["https://preview.example.invalid"], allowedControllerOrigins: [] }
  ];
  for (const config of cases) {
    const temp = mkdtempSync(resolve(tmpdir(), "downloader2-extension-reject-"));
    const configPath = resolve(temp, "profile.json");
    writeFileSync(configPath, JSON.stringify(config));
    try { assert.throws(() => execFileSync(process.execPath, [resolve(root, "build-profile.mjs"), configPath, resolve(temp, "out")], { stdio: "pipe" })); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
});
