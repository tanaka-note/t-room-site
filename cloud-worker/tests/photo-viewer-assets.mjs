import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { context, env } from "./session-fixture.mjs";
import "../public/photo-viewer.js";

// Exercise the production allowlist rather than the permissive UI fixture.
for (const asset of ["photo-viewer.js", "photo-viewer.css", "photo-fullscreen.js"]) {
  let served;
  env.ASSETS = { fetch: async request => {
    served = new URL(request.url).pathname;
    return new Response(readFileSync(new URL("../public/" + asset, import.meta.url)));
  }};
  const response = await context.worker.fetch(new Request("https://fixture.invalid/cloud/" + asset + "?v=fixture"), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(served, "/" + asset);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
}
console.log("photo viewer assets are served by the Worker allowlist: ok");
