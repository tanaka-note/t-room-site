import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/downloader2.js", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
test("owner Passkey authentication only", () => {
  assert.match(worker, /redeemHandoff\(String\(body\.handoffToken \|\| ""\), SERVICE\)/);
  assert.match(worker, /identityId !== "primary-admin"/); assert.match(worker, /validatePasskeySession/);
  assert.doesNotMatch(worker, /password_login|PASSWORD_HASH|\/api\/login/);
});
test("no Cloudflare video data plane binding", () => {
  for (const binding of ["r2_buckets", "queues", "containers", "durable_objects", "d1_databases"]) assert.equal(config[binding], undefined, binding);
  assert.doesNotMatch(worker, /DOWNLOADS|JOBS|R2Bucket|\.put\(/);
});
test("explicit capture and explicit download", () => {
  assert.match(html, /動画を検出/); assert.match(html, /Deep Capture Mode/); assert.match(html, /取得する/);
  assert.match(client, /capture\.start/); assert.match(client, /download\.start/);
  assert.doesNotMatch(client.slice(client.indexOf("function receiveExtensionMessage"), client.indexOf("function renderCandidates")), /download\.start/);
});
test("short-lived signed device-bound pairing challenge", () => {
  assert.match(worker, /PAIRING_TTL_SECONDS = 120/); assert.match(worker, /crypto\.getRandomValues/);
  assert.match(worker, /signPairingChallenge/); assert.match(worker, /pairing:\$\{encoded\}/);
  assert.match(worker, /value\.deviceChallenge !== deviceChallenge/); assert.match(client, /device\.pair\.prepare/);
  assert.doesNotMatch(worker, /pairing.*(?:DB|KV|insert)/i);
});
