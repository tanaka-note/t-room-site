import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/share.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

if (!html.includes("<title>T-Cloud Secure Share</title>")) throw new Error("共有ページのタイトルがT-Cloudへ統一されていません。");
if ((html.match(/T-Cloud Storage/g) || []).length !== 2) throw new Error("共有ページのブランド表記を確認してください。");
if (/T-ROOM/.test(html)) throw new Error("共有ページにT-ROOM表記が残っています。");
if (/<a\b[^>]*href=["']\/?["']/i.test(html)) throw new Error("共有ページにT-ROOMトップへ戻るリンクがあります。");
if (!worker.includes('assetPath === "/share" || isAuthenticationAsset')) throw new Error("共有HTMLがno-storeに設定されていません。");

console.log("shared page isolation: ok");
