import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

globalThis.window = globalThis;
await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8796";
const varsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(varsText
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
  .filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")]));
const sessionSecret = process.env.TEST_SESSION_SECRET || vars.SESSION_SECRET;
if (!sessionSecret) throw new Error("ローカル用SESSION_SECRETがありません。");

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const testRunId = webcrypto.randomUUID();
const sessionIds = {
  admin: `recursive-search-admin-${testRunId}`,
  subadmin: `recursive-search-subadmin-${testRunId}`
};
async function cookie(role) {
  const payload = {
    role,
    label: role === "admin" ? "管理者" : "副管理者",
    sessionId: sessionIds[role],
    exp: Math.floor(Date.now() / 1000) + 3600,
    version: "5"
  };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", key, encoder.encode(encoded))));
  return `troom_cloud_session=${encoded}.${signature}`;
}
const cookies = { admin: await cookie("admin"), subadmin: await cookie("subadmin") };
async function api(path, role, options = {}) {
  return fetch(`${origin}/cloud/api${path}`, {
    ...options,
    headers: {
      Cookie: cookies[role],
      Origin: origin,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}
async function jsonApi(path, role, options = {}, expected = 200) {
  const response = await api(path, role, options);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  false,
  ["encrypt", "decrypt"]
);

async function createFolder(name, password, parent, parentKey) {
  const bundle = await TRoomCrypto.createFolderPackage(name, password, keyPair.publicKey, parentKey);
  const result = await jsonApi("/folders", "admin", {
    method: "POST",
    body: JSON.stringify({ ...bundle.payload, name, parentId: parent || null })
  }, 201);
  return { id: Number(result.id), ...bundle };
}

async function uploadFile(folder, name, mimeType, mediaKind, fastDisplay = false) {
  const bytes = encoder.encode(`recursive-search-test:${name}`);
  const source = { name, type: mimeType, size: bytes.byteLength, lastModified: 1720000000000 };
  const bundle = await TRoomCrypto.createFilePackage(source, folder.folderKey, mediaKind);
  const payload = { ...bundle.payload, folderId: folder.id };
  if (fastDisplay) {
    payload.fastDisplay = {
      signature: mediaKind === "image" ? "jpeg" : "pdf",
      name,
      mimeType,
      mediaKind,
      lastModified: source.lastModified
    };
  }
  const upload = await jsonApi("/uploads", "admin", {
    method: "POST",
    body: JSON.stringify(payload)
  }, 201);
  const encryptedChunk = await TRoomCrypto.encryptFileChunk(bundle.fileKey, bytes, 0);
  const part = await jsonApi(`/uploads/${upload.id}/parts/1`, "admin", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: encryptedChunk
  });
  await jsonApi(`/uploads/${upload.id}/complete`, "admin", {
    method: "POST",
    body: JSON.stringify({ parts: [part] })
  });
  return { id: Number(upload.id), ...bundle };
}

async function allFilePages(path, role) {
  const result = await jsonApi(path, role);
  let nextOffset = result.nextFileOffset;
  while (nextOffset != null) {
    const page = await jsonApi(`${path}&filesOnly=1&fileOffset=${nextOffset}`, role);
    result.files.push(...page.files);
    nextOffset = page.nextFileOffset;
  }
  return result;
}

const rootA = await createFolder("検索テスト家A", "root-a-password", null, null);
const rootB = await createFolder("検索テスト家B", "root-b-password", null, null);
const documents = await createFolder("資料", "", rootA.id, rootA.folderKey);
const nested = await createFolder("検索対象の深い階層", "", documents.id, documents.folderKey);
const locked = await createFolder("検索対象の個別ロック", "child-lock-password", rootA.id, rootA.folderKey);
const outside = await createFolder("別家庭の検索対象", "", rootB.id, rootB.folderKey);
const directMatch = await createFolder("検索対象", "", rootA.id, rootA.folderKey);
const deeperMatch = await createFolder("検索対象", "", nested.id, nested.folderKey);
for (let index = 1; index <= 5; index += 1) {
  await createFolder(`検索対象ページ${index}`, "", documents.id, documents.folderKey);
}

const image = await uploadFile(nested, "月次・検索対象.jpg", "image/jpeg", "image", true);
const video = await uploadFile(documents, "秘密動画・検索対象.mp4", "video/mp4", "video", false);
const audio = await uploadFile(nested, "音楽・検索対象.mp3", "audio/mpeg", "audio", false);
const lockedFile = await uploadFile(locked, "個別ロック・検索対象.mp4", "video/mp4", "video", false);
const outsideFile = await uploadFile(outside, "別家庭・検索対象.jpg", "image/jpeg", "image", true);
await uploadFile(nested, "一致しない資料.pdf", "application/pdf", "document", true);

const adminRoot = await allFilePages("/items?q=検索対象&recursive=1&pageSize=100", "admin");
assert(adminRoot.folders.some((item) => Number(item.id) === nested.id), "管理者の全体検索で深い階層が見つかりません。");
assert(adminRoot.files.some((item) => Number(item.id) === image.id), "管理者の全体検索で深い階層の画像が見つかりません。");
assert(adminRoot.files.some((item) => Number(item.id) === video.id), "暗号化動画が検索候補へ含まれていません。");
assert(adminRoot.files.some((item) => Number(item.id) === outsideFile.id), "管理者の全体検索で別の最上位フォルダを横断できません。");
assert(adminRoot.files.every((item) => item.searchPath), "検索結果に保存場所がありません。");

const scopedAdmin = await jsonApi(`/items?folderId=${rootA.id}&q=検索対象&recursive=1&pageSize=100`, "admin");
assert.equal(Number(scopedAdmin.folders[0]?.id), directMatch.id, "直下の一致フォルダが深い階層より先に表示されません。");
assert(scopedAdmin.folders.findIndex((item) => Number(item.id) === directMatch.id) < scopedAdmin.folders.findIndex((item) => Number(item.id) === deeperMatch.id), "深い階層のフォルダが直下フォルダより先に表示されています。");
assert(scopedAdmin.files.some((item) => Number(item.id) === image.id), "現在地以下の深いファイルが見つかりません。");
assert(!scopedAdmin.files.some((item) => Number(item.id) === outsideFile.id), "現在地外のファイルが検索結果へ混入しました。");
assert.equal(scopedAdmin.canTrashContents, true, "管理者の検索結果で既存の削除権限が失われました。");

const beforeUnlock = await jsonApi("/items?q=検索対象&recursive=1&pageSize=100", "subadmin");
assert.equal(beforeUnlock.files.length, 0, "未解除の最上位フォルダ内が副管理者へ漏れています。");
await jsonApi(`/player/media?rootFolderId=${rootA.id}`, "subadmin", {}, 423);

const adminPlayer = await jsonApi(`/player/media?rootFolderId=${rootA.id}&pageSize=1`, "admin");
assert.equal(adminPlayer.files.length, 1, "Player media indexのページ件数が不正です。");
assert.notEqual(adminPlayer.nextOffset, null, "Player media indexの続き位置がありません。");
const adminPlayerNext = await jsonApi(`/player/media?rootFolderId=${rootA.id}&pageSize=1&offset=${adminPlayer.nextOffset}`, "admin");
assert(adminPlayerNext.files.length > 0, "Player media indexの続きが取得できません。");
assert(![...adminPlayer.files, ...adminPlayerNext.files].some((item) => Number(item.id) === lockedFile.id), "管理者のPlayerへ未解除の子PW領域が混入しました。");
assert(adminPlayer.keyFolders.every((folder, index, folders) => !folder.parentId || folders.findIndex((candidate) => Number(candidate.id) === Number(folder.parentId)) < index), "Player鍵フォルダが親子順ではありません。");
await jsonApi(`/folders/${rootA.id}/unlock`, "subadmin", {
  method: "POST",
  body: JSON.stringify({ authProof: rootA.payload.authProof })
});

const afterRootUnlock = await jsonApi("/items?q=検索対象&recursive=1&pageSize=100", "subadmin");
assert(afterRootUnlock.files.some((item) => Number(item.id) === image.id), "解除済み範囲の深いファイルが副管理者検索に出ません。");
assert(!afterRootUnlock.files.some((item) => Number(item.id) === lockedFile.id), "未解除の個別ロック内が副管理者へ漏れています。");
assert(!afterRootUnlock.files.some((item) => Number(item.id) === outsideFile.id), "別の最上位フォルダが副管理者へ漏れています。");
const playerAfterRootUnlock = await jsonApi(`/player/media?rootFolderId=${rootA.id}&pageSize=100`, "subadmin");
assert(playerAfterRootUnlock.files.some((item) => Number(item.id) === video.id), "解除済み範囲の動画がPlayerへ出ません。");
assert(playerAfterRootUnlock.files.some((item) => Number(item.id) === audio.id), "解除済み範囲の音楽がPlayerへ出ません。");
assert(!playerAfterRootUnlock.files.some((item) => Number(item.id) === lockedFile.id), "未解除の子PW領域がPlayerへ漏れています。");
assert(!playerAfterRootUnlock.files.some((item) => Number(item.id) === image.id), "画像がPlayer media indexへ混入しました。");

await jsonApi(`/folders/${locked.id}/unlock`, "subadmin", {
  method: "POST",
  body: JSON.stringify({ authProof: locked.payload.authProof })
});
const afterChildUnlock = await jsonApi(`/items?folderId=${rootA.id}&q=検索対象&recursive=1&pageSize=100`, "subadmin");
assert(afterChildUnlock.files.some((item) => Number(item.id) === lockedFile.id), "個別ロック解除後も検索できません。");
assert.equal(afterChildUnlock.canTrashContents, true, "副管理者の解除範囲内削除権限が検索時に失われました。");
const playerRootAfterChildUnlock = await jsonApi(`/player/media?rootFolderId=${rootA.id}&pageSize=100`, "subadmin");
assert(!playerRootAfterChildUnlock.files.some((item) => Number(item.id) === lockedFile.id), "別PW境界が親ルートのPlayer走査へ混入しました。");
const playerChildRoot = await jsonApi(`/player/media?rootFolderId=${locked.id}&pageSize=100`, "subadmin");
assert(playerChildRoot.files.some((item) => Number(item.id) === lockedFile.id), "個別解除した子PWルートがPlayerへ追加されません。");

const imageOnly = await jsonApi(`/items?folderId=${rootA.id}&q=検索対象&kind=image&recursive=1&pageSize=100`, "admin");
assert(imageOnly.files.some((item) => Number(item.id) === image.id), "写真絞り込みで画像が見つかりません。");
const encryptedVideoCandidate = imageOnly.files.find((item) => Number(item.id) === video.id);
assert.equal(Number(encryptedVideoCandidate?.displayMetadataVersion || 0), 0, "平文種別を持つ動画が写真候補へ混入しました。");
const decryptedCandidate = await TRoomCrypto.decryptFileMetadata(encryptedVideoCandidate, video.fileKey);
assert.notEqual(decryptedCandidate.mediaKind, "image", "端末復号後の写真絞り込みへ動画が混入しました。");

const encryptedVideo = afterRootUnlock.files.find((item) => Number(item.id) === video.id);
const decryptedVideo = await TRoomCrypto.decryptFileMetadata(encryptedVideo, video.fileKey);
assert.equal(decryptedVideo.name, "秘密動画・検索対象.mp4", "暗号化動画名を端末側で復号できません。");

const firstPage = await jsonApi(`/items?folderId=${rootA.id}&q=検索対象&recursive=1&pageSize=2`, "admin");
assert.equal(firstPage.folders.length, 2, "ページ分割の先頭件数が不正です。");
assert.notEqual(firstPage.nextFolderOffset, null, "フォルダ検索の続き位置がありません。");
const secondPage = await jsonApi(`/items?folderId=${rootA.id}&q=検索対象&recursive=1&pageSize=2&folderOffset=${firstPage.nextFolderOffset}&foldersOnly=1`, "admin");
assert(secondPage.folders.length > 0, "フォルダ検索の続きが取得できません。");
assert(!secondPage.folders.some((item) => firstPage.folders.some((first) => Number(first.id) === Number(item.id))), "ページをまたいで検索結果が重複しています。");

const noMatch = await jsonApi(`/items?folderId=${rootA.id}&q=絶対に存在しない語句&recursive=1&pageSize=100`, "admin");
assert.equal(noMatch.folders.length, 0, "0件検索へフォルダが混入しました。");
// 暗号化動画はサーバーで平文名を持たないため候補として返し、端末で復号後に除外する。
for (const item of noMatch.files) {
  assert.equal(Number(item.displayMetadataVersion || 0), 0, "0件検索へ平文不一致ファイルが混入しました。");
}

if (!vars.YOUTUBE_API_KEY) {
  await jsonApi("/player/youtube/metadata?videoId=dQw4w9WgXcQ", "admin", {}, 503);
}

console.log("recursive search HTTP with nested test data: ok");
