import { readFile } from "node:fs/promises";

const [html, client, runtime, worker] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud-runtime-20260812-2.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

for (const source of [client, runtime]) {
  if (!source.includes("async function preflightBatchRename()")
    || !source.includes("async function executeBatchRename()")
    || !source.includes("TRoomCrypto.encryptFileMetadata")
    || !source.includes('api("/files/batch-metadata"')
    || !source.includes("missing.length || collisions.length")) {
    throw new Error("端末内照合・暗号化・事前停止を備えた一括名称変更処理がありません。");
  }
  if (!source.includes("after: cleanEditableName(applyBatchRenameVariantRules(item.after))")) {
    throw new Error("承認済み変更と伏せ字変更を同時適用する処理がありません。");
  }
  if (!source.includes("女子(?:高|校)生")
    || !source.includes("[●○〇◯・＊*]+学生")
    || !source.includes("(?<![A-Za-z0-9])J[SKC](?![A-Za-z0-9])")) {
    throw new Error("女子校生・伏せ字・英数字コード誤検出対策がありません。");
  }
}

if (!html.includes('id="batch-rename-dialog"')
  || !html.includes('id="batch-rename-preflight"')
  || !html.includes('id="batch-rename-execute"')) {
  throw new Error("管理者が確認できる一括名称変更画面がありません。");
}

const start = worker.indexOf("async function updateFileMetadataBatch(");
const end = worker.indexOf("async function moveFileToTrash(", start);
const body = worker.slice(start, end);
if (start < 0
  || !body.includes("requireAdmin(session)")
  || !body.includes("entries.length > 50")
  || !body.includes("new Set(ids).size !== ids.length")
  || !body.includes("crypto_version = 1")
  || !body.includes("env.DB.batch")
  || body.includes("original_name =")) {
  throw new Error("一括名称変更APIの管理者限定・暗号化専用・重複防止が不完全です。");
}

console.log("encrypted batch rename: ok");
