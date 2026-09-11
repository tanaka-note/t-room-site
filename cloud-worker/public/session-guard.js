(function (global) {
  "use strict";
  // Only public session metadata is stored; no Cookie, PRF or decryption key.
  const TAB_KEY = "tcloud-tab-session-v1";
  const SHARED_KEY = "tcloud-current-session-v1";
  const HEADER = "X-TCloud-Session";
  const nativeFetch = global.fetch.bind(global);
  const pending = new Set();
  let epoch = 0;
  let current = null;
  let blocked = false;
  let channel = null;
  try { const saved = JSON.parse(sessionStorage.getItem(TAB_KEY) || "null"); blocked = Boolean(saved?.blocked); current = saved?.sessionCacheId ? saved : null; } catch { blocked = true; }
  try { channel = new BroadcastChannel(SHARED_KEY); channel.onmessage = event => observe(event.data); } catch {}
  global.addEventListener("storage", event => { if (event.key === SHARED_KEY) observe(event.newValue); });
  global.addEventListener("pageshow", () => { if (current) { try { check(); } catch {} } });
  global.addEventListener("focus", () => { if (current) { try { check(); } catch {} } });
  function shared() { try { return localStorage.getItem(SHARED_KEY); } catch { return null; } }
  function save(value) { try { sessionStorage.setItem(TAB_KEY, JSON.stringify(value)); } catch { throw new Error("このタブのログイン状態を保存できません。"); } }
  function announce(value) { try { localStorage.setItem(SHARED_KEY, value); } catch {} channel?.postMessage(value); }
  function observe(value) { if (current && value && value !== current.sessionCacheId) invalidate(); }
  function error() { const result = new Error("別のタブでログイン状態が変わりました。利用するアカウントを選び直してください。"); result.status = 419; return result; }
  function abortPending() { epoch++; for (const controller of pending) controller.abort(); pending.clear(); }
  function invalidate() {
    if (blocked && !current) return;
    blocked = true; current = null; abortPending();
    try { save({blocked:true}); } catch {}
    global.dispatchEvent(new Event("tcloud-session-invalid"));
    // Unload closures holding decrypted keys and discard any already-running
    // asynchronous UI continuation, including work that did not perform fetch.
    global.location.replace("/cloud/?session-changed=1");
  }
  function check(snapshot = epoch) {
    if (blocked || snapshot !== epoch) throw error();
    if (current && shared() && shared() !== current.sessionCacheId) { invalidate(); throw error(); }
    return current;
  }
  function bind(session, publish = true) {
    if (!session?.sessionCacheId) throw error();
    current = {sessionCacheId:session.sessionCacheId, authMethod:session.authMethod, serviceLinkId:session.serviceLinkId,
      serviceAccountId:session.serviceAccountId, role:session.role, rootFolderId:session.rootFolderId ?? null};
    blocked = false; save(current);
    if (publish) announce(current.sessionCacheId);
  }
  function beginSelection() { abortPending(); current = null; blocked = false; save(null); }
  function end() { announce(`logout:${crypto.randomUUID()}`); current = null; blocked = true; abortPending(); save({blocked:true}); }
  function headers(input = {}) {
    check(); const result = new Headers(input);
    if (current) result.set(HEADER, current.sessionCacheId);
    return result;
  }
  function scopedUrl(input) {
    check(); const url = new URL(input, global.location.href);
    if (current && privateApi(url)) url.searchParams.set("tcloudSession", current.sessionCacheId);
    return url.pathname + url.search;
  }
  function privateApi(url) { return url.origin === global.location.origin && url.pathname.startsWith("/cloud/api/") && !url.pathname.startsWith("/cloud/api/public/"); }
  async function scopedFetch(input, options = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, global.location.href);
    if (!privateApi(url) || url.pathname === "/cloud/api/app-version" || url.pathname === "/cloud/api/auth-mode") return nativeFetch(input, options);
    const selecting = ["/cloud/api/login", "/cloud/api/passkey/handoff"].includes(url.pathname);
    const snapshot = epoch;
    check(snapshot);
    const controller = new AbortController();
    const external = options.signal;
    const abort = () => controller.abort();
    if (external?.aborted) abort(); else external?.addEventListener("abort", abort, {once:true});
    pending.add(controller);
    const finish = () => { pending.delete(controller); external?.removeEventListener("abort", abort); };
    try {
      const response = await nativeFetch(input, {...options, headers:selecting ? options.headers : headers(options.headers), credentials:"same-origin", cache:"no-store", signal:controller.signal});
      check(snapshot);
      if (response.status === 419 || (response.status === 401 && current && !selecting)) { invalidate(); throw error(); }
      if (selecting && response.ok) bind(await response.clone().json());
      const bodyEpoch = epoch;
      const reader = response.body?.getReader();
      if (!reader) { finish(); return response; }
      const body = new ReadableStream({
        async pull(target) {
          try { check(bodyEpoch); const result = await reader.read(); check(bodyEpoch); if (result.done) { finish(); target.close(); } else target.enqueue(result.value); }
          catch (failure) { finish(); controller.abort(); void reader.cancel().catch(()=>{}); target.error(failure); }
        },
        cancel(reason) { finish(); controller.abort(); return reader.cancel(reason); }
      });
      return new Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
    } catch (failure) { finish(); throw failure; }
  }
  function track(controller) { check(); pending.add(controller); return () => pending.delete(controller); }
  global.TCloudSession = Object.freeze({fetch:scopedFetch, headers, scopedUrl, bind, beginSelection, end, check, invalidate, track,
    context:()=>current, isBlocked:()=>blocked});
})(globalThis);
