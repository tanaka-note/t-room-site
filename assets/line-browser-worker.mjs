import { lineBrowserPolicy } from "./line-browser-policy.mjs";
import { LINE_BROWSER_BOOTSTRAP, LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from "./line-browser-csp.mjs";

const policy = lineBrowserPolicy(null);
export function lineBrowserResponse(request) {
  if (!policy.isLine(request.headers.get("User-Agent"))) return null;
  const url = new URL(request.url);
  // Asset Links remain available to Android verification, independently of UA.
  if (url.pathname === "/.well-known/assetlinks.json") return null;
  const isDocument = ["GET", "HEAD"].includes(request.method) && !/\/api(?:\/|$)/.test(url.pathname)
    && (request.headers.get("Sec-Fetch-Dest") === "document" || request.headers.get("Accept")?.includes("text/html")
      || !/\.[a-z0-9]+$/i.test(url.pathname) || /\.html$/i.test(url.pathname));
  const body = isDocument
    ? `<!doctype html><html lang="ja">${policy.contents(request.url, request.headers.get("User-Agent"))}<script data-tlain-browser-guard>${LINE_BROWSER_BOOTSTRAP}</script></html>`
    : JSON.stringify({ error: "LINE内ブラウザでは利用できません。通常のブラウザまたは対応アプリで開いてください。", code: "unsupported_browser" });
  return new Response(request.method === "HEAD" ? null : body, { status: 403, headers: {
    "Content-Type": isDocument ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "private, no-store", "Vary": "User-Agent", "X-Tlain-Browser-Policy": "line-blocked",
    "Content-Security-Policy": `default-src 'none'; script-src ${LINE_BROWSER_SCRIPT_CSP}; style-src ${LINE_BROWSER_STYLE_CSP}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  } });
}
