globalThis.window = globalThis;

await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

const credentials = await TRoomCrypto.deriveAccountCredentials("temporary-local-test-4827", "test@example.com");
const repeatedCredentials = await TRoomCrypto.deriveAccountCredentials("temporary-local-test-4827", "test@example.com");
const legacyCredentialSalt = TRoomCrypto.toBase64Url(new Uint8Array(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode("T-ROOM Cloud Storage account key v1|tanaka-note.com|test@example.com")
)).slice(0, 16));
const renamedLoginCredentials = await TRoomCrypto.deriveAccountCredentials(
  "temporary-local-test-4827",
  "renamed@example.com",
  legacyCredentialSalt
);
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
const selectedFileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const selectedFileWrap = await TRoomCrypto.wrapFileForShare(selectedFileKey, filePackage.fileKey);
const selectedFileUnlocked = await TRoomCrypto.unlockFileFromShare(selectedFileWrap, filePackage.fileKey);
const selectedFileRaw = new Uint8Array(await crypto.subtle.exportKey("raw", selectedFileKey));
const selectedFileUnlockedRaw = new Uint8Array(await crypto.subtle.exportKey("raw", selectedFileUnlocked));
const unlockedFileKey = await TRoomCrypto.unlockFileKey(fileRecord, recoveredFolderKey);
const fileMetadata = await TRoomCrypto.decryptFileMetadata(fileRecord, unlockedFileKey);
const renamedMetadataPackage = await TRoomCrypto.encryptFileMetadata({ ...fileMetadata, name: "家族写真・変更後.jpg" }, unlockedFileKey);
const renamedMetadata = await TRoomCrypto.decryptFileMetadata({ ...fileRecord, ...renamedMetadataPackage }, unlockedFileKey);
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
const unprotectedRootFolder = await TRoomCrypto.createFolderPackage("PWなし最上位", "", publicKey);
const unprotectedRootRecord = { cryptoVersion: 1, ...unprotectedRootFolder.payload };
const unprotectedRootKey = await TRoomCrypto.unlockFolderAsAdmin(unprotectedRootRecord, vault.privateKey);
const unprotectedRootName = await TRoomCrypto.decryptFolderName(unprotectedRootRecord, unprotectedRootKey);
const protectedChildFolder = await TRoomCrypto.createFolderPackage("個別PW付き子フォルダ", "child-folder-password-2026", publicKey, adminKey);
const protectedChildRecord = { cryptoVersion: 1, ...protectedChildFolder.payload };
const protectedChildUnlocked = await TRoomCrypto.unlockFolderWithPassword(protectedChildRecord, "child-folder-password-2026");
const protectedChildName = await TRoomCrypto.decryptFolderName(protectedChildRecord, protectedChildUnlocked.folderKey);
const destinationFolder = await TRoomCrypto.createFolderPackage("移動先", "destination-test-8842", publicKey);
const movedFileWrap = await TRoomCrypto.rewrapFileForFolder(unlockedFileKey, destinationFolder.folderKey);
const movedFileKey = await TRoomCrypto.unlockFileKey({ ...fileRecord, ...movedFileWrap }, destinationFolder.folderKey);
const movedFileMetadata = await TRoomCrypto.decryptFileMetadata(fileRecord, movedFileKey);
const movedFolderWrap = await TRoomCrypto.rewrapFolderForParent(sharedChildKey, destinationFolder.folderKey);
const movedChildKey = await TRoomCrypto.unlockFolderFromParent({ ...childRecord, ...movedFolderWrap }, destinationFolder.folderKey);
const movedChildName = await TRoomCrypto.decryptFolderName(childRecord, movedChildKey);

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
if (credentials.authProof !== renamedLoginCredentials.authProof) {
  throw new Error("ログインID変更時に既存の認証値を維持できません。");
}
if (fileMetadata.name !== fileSource.name || renamedMetadata.name !== "家族写真・変更後.jpg" || new TextDecoder().decode(decryptedChunk) !== "encrypted file body" || decryptedThumbnail.join(",") !== "1,2,3,4") {
  throw new Error("ファイル暗号化の往復テストに失敗しました。");
}
if (childFolder.payload.passwordWrappedKey || childFolder.payload.authProof || !childFolder.payload.inheritsProtection || sharedChildName !== "共有対象の子フォルダ" || unprotectedRootFolder.payload.passwordWrappedKey || unprotectedRootFolder.payload.authProof || unprotectedRootName !== "PWなし最上位" || !protectedChildFolder.payload.passwordWrappedKey || protectedChildFolder.payload.inheritsProtection || protectedChildName !== "個別PW付き子フォルダ" || movedChildName !== sharedChildName || movedFileMetadata.name !== fileSource.name || shareFolderName !== adminName || decryptedShareToken !== shareToken || derivedShareProof !== sharePackage.authProof || sharedFileMetadata.name !== "家族写真.jpg" || selectedFileRaw.join(",") !== selectedFileUnlockedRaw.join(",") || !wrongSharePasswordRejected) {
  throw new Error("共有暗号化の往復テストに失敗しました。");
}

console.log("crypto round-trip: ok");
