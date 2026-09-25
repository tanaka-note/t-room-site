import assert from "node:assert/strict";
import test from "node:test";
import { LARGE_BYTES, startFixtureServer } from "../server.mjs";

test("fixture covers direct, range, HLS, DASH, protected context and errors", async () => {
  const second = await startFixtureServer();
  const fixture = await startFixtureServer({ redirectOrigin: second.origin });
  try {
    const range = await fetch(`${fixture.origin}/range-100mb.mp4`, { headers: { Range: "bytes=0-0" } });
    assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), `bytes 0-0/${LARGE_BYTES}`);
    assert.match(await (await fetch(`${fixture.origin}/master.m3u8`)).text(), /variant\.m3u8/);
    assert.match(await (await fetch(`${fixture.origin}/manifest.mpd`)).text(), /<MPD/);
    assert.match(await (await fetch(`${fixture.origin}/drm.mpd`)).text(), /edef8ba9/);
    assert.equal((await fetch(`${fixture.origin}/protected`)).status, 403);
    assert.equal((await fetch(`${fixture.origin}/protected`, { headers: { Cookie: "fixture=ok", Origin: fixture.origin, Referer: `${fixture.origin}/` } })).status, 200);
    assert.equal((await fetch(`${fixture.origin}/signed?sig=fixture`)).status, 200);
    assert.equal((await fetch(`${fixture.origin}/status/403`)).status, 403);
    assert.equal((await fetch(`${fixture.origin}/status/429`)).status, 429);
    assert.equal((await fetch(`${fixture.origin}/cross-origin-redirect`, { redirect: "manual", headers: { Cookie: "secret=yes" } })).status, 302);
    assert.equal((await fetch(`${fixture.origin}/generated`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: Buffer.from("fixture-webm") })).status, 204);
    const generated = await fetch(`${fixture.origin}/generated.webm?fixture=local`, { headers: { Range: "bytes=0-6" } });
    assert.equal(generated.status, 206); assert.equal(generated.headers.get("content-type"), "video/webm");
  } finally { await fixture.close(); await second.close(); }
});
