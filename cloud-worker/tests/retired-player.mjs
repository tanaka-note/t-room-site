import assert from "node:assert/strict";
import { context, api, handoff, legacyPasswordSession } from "./session-fixture.mjs";

const retiredCode = "tcloud_player_retired";
const noBindings = new Proxy({}, { get() { throw new Error("Retired Player must not access bindings"); } });
const endpoints = [
  ["/session", "GET"], ["/auth-mode", "GET"], ["/login", "POST"],
  ["/passkey/handoff", "POST"], ["/items", "GET"], ["/player/media?rootFolderId=7", "GET"],
  ["/player/youtube/search?q=test", "GET"], ["/files/1/download", "GET"],
  ["/files/1/thumbnail", "GET"], ["/files/1/thumbnail", "PUT"],
  ["/uploads", "POST"], ["/uploads/1/parts/1", "PUT"], ["/uploads/1/complete", "POST"],
  ["/files/1", "PATCH"], ["/files/1", "DELETE"], ["/session", "HEAD"],
  ["/public/shares/" + "a".repeat(43), "GET"]
];

for (const userAgent of ["T-Cloud-Android/0.1", "T-Cloud-Android/0.3", "T-Cloud-Android/0.5", "T-Cloud-Android/1.4.2"]) {
  for (const [path, method] of endpoints) {
    const response = await context.worker.fetch(new Request(`https://example.test/cloud/api${path}`, {
      method, headers: { "User-Agent": userAgent, Cookie: legacyPasswordSession("admin").cookie,
        Range: "bytes=0-1023", Origin: "https://tanaka-note.com" }
    }), noBindings, {});
    assert.equal(response.status, 410, `${userAgent} ${method} ${path}`);
    const body = await response.json();
    assert.equal(body.code, retiredCode);
    assert.match(body.error, /廃止/);
    assert.match(body.error, /https:\/\/tanaka-note\.com\/cloud\//);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Set-Cookie"), null, "Retirement must not refresh sessions");
  }
}

// A valid passkey cookie must not bypass the client retirement gate.
const member = await handoff("folder-member");
const blockedMember = await api(member.cookie, "/items?folderId=7", "GET", undefined, {
  "User-Agent": "T-Cloud-Android/0.1", "X-TCloud-Session": member.body.sessionCacheId
});
assert.equal(blockedMember.status, 410);
assert.equal(blockedMember.body.code, retiredCode);

// Web/PWA/TWA remain on the ordinary authorization path, including Android Chrome.
for (const userAgent of ["", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36", "Other-T-Cloud-Android/0.1"]) {
  const response = await api(member.cookie, "/items?folderId=7", "GET", undefined, {
    "User-Agent": userAgent, "X-TCloud-Session": member.body.sessionCacheId
  });
  assert.equal(response.status, 200, userAgent);
  const anonymous = await api(null, "/items", "GET", undefined, { "User-Agent": userAgent });
  assert.equal(anonymous.status, 401, "Ordinary authorization must remain enforced");
}

console.log("Retired Android Player: API blocked before bindings; Web/PWA/TWA authorization preserved");
