// Canonical copy. Diary/Billing copies are checked by password-login-client.test.js.
(() => {
  "use strict";
  function create({ service, apiBase, form, loginIdInput }) {
    const storageKey = `troom-password-audit-${service}`;
    const buildId = document.querySelector('meta[name="troom-app-build"]')?.content;
    const isPwa = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
    const metadata = () => ({ requestCorrelationId: crypto.randomUUID(), ...(buildId ? { buildId } : {}), isPwa });
    const reasons = { form_submit: ["submitted"], form_validation: ["login_id_invalid", "password_length_invalid", "input_invalid", "unexpected_client_error"],
      auth_mode: ["request_failed", "network_error", "unexpected_client_error"], credential_derivation: ["password_length_invalid", "login_id_invalid", "crypto_unavailable", "credential_derivation_failed"],
      login_request: ["network_error", "unexpected_client_error"], login_response: ["request_failed", "unexpected_client_error"] };
    function safeBody(body) {
      if (!body || !Object.hasOwn(reasons, body.stage) || !reasons[body.stage].includes(body.reason)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestCorrelationId || "")
        || typeof body.isPwa !== "boolean" || (body.buildId !== undefined && !new RegExp(`^${service}-[a-f0-9]{12}$`).test(body.buildId))) return null;
      return { eventType: body.stage === "form_submit" ? "password_login_submit" : "password_login_client_failure", stage: body.stage, reason: body.reason,
        requestCorrelationId: body.requestCorrelationId, ...(body.buildId ? {buildId:body.buildId} : {}), isPwa: body.isPwa };
    }
    const pending = () => {
      try { return JSON.parse(sessionStorage.getItem(storageKey) || "[]").filter(item => Number.isFinite(item.expires) && item.expires > Date.now())
        .map(item => ({expires:item.expires,body:safeBody(item.body)})).filter(item => item.body).slice(-20); } catch { return []; }
    };
    const save = items => { try { sessionStorage.setItem(storageKey, JSON.stringify(items.slice(-20))); } catch {} };
    async function send(body) {
      body = safeBody(body);
      if (!body) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await fetch(`${apiBase}/password-login-audit`, {
            method: "POST", credentials: "same-origin", signal: controller.signal,
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
          });
          if (response.ok) return true;
          if (response.status < 500) break;
        } catch {} finally { clearTimeout(timer); }
      }
      console.warn("Password login audit delivery unavailable");
      return false;
    }
    let flushing = false;
    async function flush() {
      if (flushing) return;
      flushing = true;
      try {
        for (const item of pending()) {
          if (!await send(item.body)) break;
          // Merge with events added while the request was in flight.
          save(pending().filter(p => JSON.stringify(p.body) !== JSON.stringify(item.body)));
        }
      } finally { flushing = false; }
    }
    function tracker(meta) {
      return { headers: meta ? { "X-Login-Correlation-ID": meta.requestCorrelationId } : {},
        async report(stage, reason) {
          if (!meta) return false;
          const body = { ...meta, eventType: stage === "form_submit" ? "password_login_submit" : "password_login_client_failure", stage, reason };
          if (await send(body)) return true;
          save([...pending(), { body, expires: Date.now() + 3600000 }]);
          return false;
        }
      };
    }
    const begin = () => {
      let meta; try { meta = metadata(); } catch { console.warn("Password login audit correlation unavailable"); }
      return tracker(meta);
    };
    // Native HTML validation prevents submit; capture that path as well.
    let invalidPending = false;
    form.addEventListener("invalid", event => {
      if (invalidPending) return;
      invalidPending = true;
      const reason = event.target === loginIdInput ? "login_id_invalid" : "input_invalid";
      queueMicrotask(async () => {
        try { const t = begin(); await t.report("form_submit", "submitted"); await t.report("form_validation", reason); }
        finally { invalidPending = false; }
      });
    }, true);
    addEventListener("online", () => { void flush(); });
    void flush();
    return { begin };
  }
  globalThis.TRoomPasswordLoginAudit = Object.freeze({ create });
})();
