import { LINE_BROWSER_BOOTSTRAP } from "../assets/line-browser-csp.mjs";
export function ensureLineBrowserGuard(html) {
  if (!/^\s*(?:<!doctype\s+html|<html\b)/i.test(html)) return html;
  const newline = html.match(/\r?\n/)?.[0] || "\n";
  const bootstrap = LINE_BROWSER_BOOTSTRAP.replace(/\r\n?|\n/g, newline);
  const withoutOld = html.replace(/<script data-tlain-browser-guard>[\s\S]*?<\/script>\s*/g, "");
  return withoutOld.replace(/(<head\b[^>]*>\s*(?:<meta\s+charset=[^>]+>\s*)?)/i,
    `$1<script data-tlain-browser-guard>${bootstrap}</script>${newline}`);
}
