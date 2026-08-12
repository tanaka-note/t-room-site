import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const origin = process.env.TEST_SHARE_ORIGIN || "http://localhost:8796";
const token = process.env.TEST_SHARE_TOKEN;
const shareId = Number(process.env.TEST_SHARE_ID || 0);
const rootId = Number(process.env.TEST_SHARE_ROOT_ID || 0);
const outsideId = Number(process.env.TEST_SHARE_OUTSIDE_ID || 0);
if (!token || token.length !== 43 || !shareId || !rootId || !outsideId) throw new Error("共有セキュリティ試験の入力値を確認してください。");

const varsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(varsText.split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")]));
if (!vars.SESSION_SECRET) throw new Error("ローカル用SESSION_SECRETがありません。");

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const tokenHash = b64(new Uint8Array(await webcrypto.subtle.digest("SHA-256", encoder.encode(token))));

async function sessionCookie(hash = tokenHash) {
  const payload = {
    type: "share",
    shareId,
    tokenHash: hash,
    sessionId: webcrypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    version: "5"
  };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", encoder.encode(vars.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", key, encoder.encode(encoded))));
  return `troom_cloud_share_session=${encoded}.${signature}`;
}

async function status(path, cookie = "") {
  const response = await fetch(`${origin}/cloud/api/public/shares/${token}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return response.status;
}

const cookie = await sessionCookie();
const results = {
  publicInfo: await status(""),
  unauthenticatedItems: await status(`/items?folderId=${rootId}`),
  authorizedRoot: await status(`/items?folderId=${rootId}`, cookie),
  outsideFolder: await status(`/items?folderId=${outsideId}`, cookie),
  wrongSessionHash: await status(`/items?folderId=${rootId}`, await sessionCookie("invalid-token-hash"))
};

const expected = { publicInfo: 200, unauthenticatedItems: 401, authorizedRoot: 200, outsideFolder: 403, wrongSessionHash: 401 };
for (const [name, wanted] of Object.entries(expected)) if (results[name] !== wanted) throw new Error(`${name}: expected ${wanted}, received ${results[name]}`);
console.log("share security routes: ok", results);
