// Support policy only, never an authentication boundary. Kept self-contained so
// the exact same runtime can run at the edge and before any cached HTML scripts.
export function lineBrowserPolicy(scope) {
  function isLine(userAgent) {
    return /(?:^|[\s;(])Line\/\d+(?:\.|\b)/i.test(String(userAgent || ""));
  }
  function isApp() {
    return Boolean(scope?.navigator?.standalone === true || ["standalone", "fullscreen", "minimal-ui"]
      .some((mode) => scope?.matchMedia?.(`(display-mode: ${mode})`).matches));
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "tanaka-note.com" || url.port || url.username || url.password) return null;
      return url;
    } catch { return null; }
  }
  function externalUrl(value) {
    const url = safeUrl(value);
    if (!url) return null;
    url.searchParams.delete("openInAppBrowser");
    url.searchParams.set("openExternalBrowser", "1");
    return url.href;
  }
  function appUrl(value, userAgent) {
    const url = safeUrl(value);
    if (!url || !/Android/i.test(userAgent || "")) return null;
    const packageName = url.pathname.startsWith("/diary/") ? "jp.tanaka.troom.diary.twa"
      : url.pathname.startsWith("/cloud/") ? "jp.tanaka.tcloud.twa" : null;
    if (!packageName) return null;
    url.searchParams.delete("openExternalBrowser");
    url.searchParams.delete("openInAppBrowser");
    // HTTPS data + a fixed existing package, not a new application URL scheme.
    // Android parses the last #Intent block; URL fragments stay in the data URI.
    return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${encodeURIComponent(externalUrl(value))};end`;
  }
  const css = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;background:#f5f6f4;color:#293831}*{box-sizing:border-box}body{margin:0;padding:24px 20px;min-height:100svh;display:grid;place-items:center}main{width:min(100%,460px);padding:32px 24px;border:1px solid #dce3dd;border-radius:18px;background:#fff}p{line-height:1.8}h1{font-size:1.25rem;line-height:1.6;margin:24px 0 16px}.brand{font-size:1.4rem;font-weight:700;letter-spacing:.06em}.actions{display:grid;gap:12px;margin:28px 0}a{display:block;padding:15px 18px;min-height:52px;border-radius:10px;text-align:center;font-weight:600;text-decoration:none;border:1px solid #587061;color:inherit;overflow-wrap:anywhere}a.primary{background:#506b59;color:#fff}a:focus-visible{outline:3px solid #8ca895;outline-offset:3px}.help{font-size:.9rem;color:#536158}.help strong{display:block}#app-note{font-size:.85rem}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{background:#161c19;color:#e4eae5}main{background:#202923;border-color:#3b4b40}.help{color:#becbbf}a.primary{background:#536f5c}}@media(max-width:360px){main{padding:24px 18px}body{padding:16px}}`;
  function escape(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function contents(value, userAgent) {
    const external = externalUrl(value), app = appUrl(value, userAgent);
    return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>T-lain | ブラウザのご案内</title><style>${css}</style></head><body><main aria-labelledby="browser-title"><div class="brand">T-lain</div><h1 id="browser-title">このブラウザでは<br>T-lainを利用できません。</h1><p>安全なログイン・パスキー認証のため、T-lainアプリまたは通常のブラウザで開いてください。</p><div class="actions">${app ? `<a id="open-app" class="primary" href="${escape(app)}" rel="noreferrer">T-lainアプリで開く</a>` : ""}${external ? `<a id="open-browser" class="${app ? "" : "primary"}" href="${escape(external)}" rel="noreferrer">既定のブラウザで開く</a>` : ""}</div>${app ? '<p id="app-note">このページに対応する日記／T-Cloudアプリを開きます。開かない場合は、既定のブラウザをご利用ください。</p>' : ""}<p class="help"><strong>うまく開かない場合</strong>LINEのメニュー「…」から「デフォルトのブラウザで開く」を選択してください。<br>ホーム画面に追加したアプリは、ホーム画面からも開けます。</p></main></body>`;
  }
  function enforce() {
    if (!scope || isApp() || !isLine(scope.navigator.userAgent)) return false;
    scope.stop();
    scope.document.documentElement.lang = "ja";
    scope.document.documentElement.innerHTML = contents(scope.location.href, scope.navigator.userAgent);
    // Restoring this document must keep the gate, never resume the old UI.
    scope.addEventListener("pageshow", () => {
      if (!scope.document.getElementById("browser-title")) enforce();
    }, { once: true });
    return true;
  }
  return { isLine, isApp, externalUrl, appUrl, contents, css, enforce };
}
