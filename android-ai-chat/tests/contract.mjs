import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const gradle = read("../app/build.gradle.kts");
const manifest = read("../app/src/main/AndroidManifest.xml");
const repository = read("../app/src/main/java/jp/tanaka/troom/ai/data/AiRepository.kt");
const store = read("../app/src/main/java/jp/tanaka/troom/ai/data/SecureSessionStore.kt");
const assetlinks = JSON.parse(read("../../.well-known/assetlinks.json"));

assert.match(gradle, /applicationId = "jp\.tanaka\.troom\.ai"/);
assert.match(gradle, /\.\.\/android-tcloud\/keystore\.properties/);
assert.doesNotMatch(gradle, /storePassword\s*=\s*"/);
assert.match(manifest, /android:name="asset_statements"/);
assert.match(repository, /security\/api\/auth\/options/);
assert.match(repository, /security\/api\/auth\/verify/);
assert.match(repository, /security\/api\/auth\/handoff/);
assert.match(repository, /ai\/api\/passkey\/handoff/);
assert.doesNotMatch(repository, /password|userId|identityId\s*=/i);
assert.match(store, /AndroidKeyStore/);
assert.match(store, /KEY_PENDING/);

const ai = assetlinks.find((entry) => entry.target?.package_name === "jp.tanaka.troom.ai");
assert.ok(ai, "AI Chat package must be published in Digital Asset Links");
assert.ok(ai.relation.includes("delegate_permission/common.get_login_creds"));
assert.deepEqual(ai.target.sha256_cert_fingerprints, ["34:C8:E9:61:CB:1D:35:31:66:7E:57:1C:C2:02:5A:3B:2E:1A:FC:48:1A:8C:74:12:DE:DE:12:88:FF:E5:05:56"]);

console.log("AI Chat Android contract: PASS");
