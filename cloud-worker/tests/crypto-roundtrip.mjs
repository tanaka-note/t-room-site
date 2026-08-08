globalThis.window = globalThis;

await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

const credentials = await TRoomCrypto.deriveAccountCredentials("temporary-local-test-4827");
const repeatedCredentials = await TRoomCrypto.deriveAccountCredentials("temporary-local-test-4827");
const accountKey = credentials.accountKey;
const vault = await TRoomCrypto.createVault(accountKey);
const publicKey = await crypto.subtle.importKey(
  "jwk",
  vault.publicKeyJwk,
  { name: "RSA-OAEP", hash: "SHA-256" },
  false,
  ["encrypt"]
);
const folder = await TRoomCrypto.createFolderPackage("暗号化テスト", "folder-test-7319", publicKey);
const record = { cryptoVersion: 1, ...folder.payload };

const adminKey = await TRoomCrypto.unlockFolderAsAdmin(record, vault.privateKey);
const adminName = await TRoomCrypto.decryptFolderName(record, adminKey);
const subadmin = await TRoomCrypto.unlockFolderWithPassword(record, "folder-test-7319");
const subadminName = await TRoomCrypto.decryptFolderName(record, subadmin.folderKey);
const recoveredPrivateKey = await TRoomCrypto.recoverAdminPrivateKey(vault.recoveryCode, vault.payload);
const recoveredFolderKey = await TRoomCrypto.unlockFolderAsAdmin(record, recoveredPrivateKey);
const recoveredName = await TRoomCrypto.decryptFolderName(record, recoveredFolderKey);

const fileSource = { name: "家族写真.jpg", type: "image/jpeg", size: 19, lastModified: 1 };
const filePackage = await TRoomCrypto.createFilePackage(fileSource, adminKey, "image");
const fileRecord = { cryptoVersion: 1, ...filePackage.payload };
const fileSharePassword = "local-file-share-test-2026";
const fileSharePackage = await TRoomCrypto.createSharePackage(filePackage.fileKey, fileSharePassword);
const fileShareUnlocked = await TRoomCrypto.unlockShareKey(fileSharePackage, fileSharePassword);
const sharedFileMetadata = await TRoomCrypto.decryptFileMetadata(fileRecord, fileShareUnlocked.targetKey);
const unlockedFileKey = await TRoomCrypto.unlockFileKey(fileRecord, recoveredFolderKey);
const fileMetadata = await TRoomCrypto.decryptFileMetadata(fileRecord, unlockedFileKey);
const chunkSource = new TextEncoder().encode("encrypted file body");
const encryptedChunk = await TRoomCrypto.encryptFileChunk(unlockedFileKey, chunkSource, 0);
const decryptedChunk = await TRoomCrypto.decryptFileChunk(unlockedFileKey, encryptedChunk, 0);
const thumbnailSource = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" });
const encryptedThumbnail = await TRoomCrypto.encryptThumbnail(thumbnailSource, unlockedFileKey);
const decryptedThumbnail = await TRoomCrypto.decryptThumbnail(await encryptedThumbnail.arrayBuffer(), unlockedFileKey);

const childFolder = await TRoomCrypto.createFolderPackage("共有対象の子フォルダ", "", publicKey, adminKey);
const childRecord = { cryptoVersion: 1, ...childFolder.payload };
const sharedChildKey = await TRoomCrypto.unlockFolderFromParent(childRecord, adminKey);
const sharedChildName = await TRoomCrypto.decryptFolderName(childRecord, sharedChildKey);

const sharePassword = "local-share-test-9341-strong";
const sharePackage = await TRoomCrypto.createSharePackage(adminKey, sharePassword);
const derivedShareProof = await TRoomCrypto.deriveShareAuthProof(sharePackage, sharePassword);
const shareUnlocked = await TRoomCrypto.unlockShareKey(sharePackage, sharePassword);
const shareFolderName = await TRoomCrypto.decryptFolderName(record, shareUnlocked.targetKey);
const shareToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const encryptedShareToken = await TRoomCrypto.encryptShareToken(shareToken, adminKey);
const decryptedShareToken = await TRoomCrypto.decryptShareToken(encryptedShareToken, adminKey);
let wrongSharePasswordRejected = false;
try { await TRoomCrypto.unlockShareKey(sharePackage, "wrong-share-password-9999"); }
catch { wrongSharePasswordRejected = true; }

if (adminName !== "暗号化テスト" || subadminName !== adminName || recoveredName !== adminName) {
  throw new Error("暗号化の往復テストに失敗しました。");
}
if (!vault.recoveryCode.startsWith("TRC1-") || subadmin.authProof.length < 40) {
  throw new Error("鍵形式の検証に失敗しました。");
}
if (credentials.authProof !== repeatedCredentials.authProof || credentials.authProof.length < 40) {
  throw new Error("アカウント認証値の導出テストに失敗しました。");
}
if (fileMetadata.name !== fileSource.name || new TextDecoder().decode(decryptedChunk) !== "encrypted file body" || decryptedThumbnail.join(",") !== "1,2,3,4") {
  throw new Error("ファイル暗号化の往復テストに失敗しました。");
}
if (childFolder.payload.passwordWrappedKey || childFolder.payload.authProof || !childFolder.payload.inheritsProtection || sharedChildName !== "共有対象の子フォルダ" || shareFolderName !== adminName || decryptedShareToken !== shareToken || derivedShareProof !== sharePackage.authProof || sharedFileMetadata.name !== "家族写真.jpg" || !wrongSharePasswordRejected) {
  throw new Error("共有暗号化の往復テストに失敗しました。");
}

console.log("crypto round-trip: ok");
