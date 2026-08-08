(() => {
  "use strict";

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const KDF_OPTIONS = Object.freeze({ iterations: 3, memorySize: 65536, parallelism: 1, hashLength: 32 });
  const ACCOUNT_SALT_CONTEXT = "T-ROOM Cloud Storage account key v1|tanaka-note.com|sub@a-tanaka.jp";
  const ACCOUNT_AUTH_CONTEXT = "T-ROOM Cloud Storage account authentication v1";
  const ADMIN_WRAP_CONTEXT = "T-ROOM Cloud Storage admin private key v1";
  const RECOVERY_WRAP_CONTEXT = "T-ROOM Cloud Storage emergency recovery v1";
  const FOLDER_AUTH_CONTEXT = "T-ROOM Cloud Storage folder authentication v1";
  const FOLDER_WRAP_CONTEXT = "T-ROOM Cloud Storage folder key v1";
  const PARENT_FOLDER_WRAP_CONTEXT = "T-ROOM Cloud Storage child folder key v1";
  const FOLDER_NAME_CONTEXT = "T-ROOM Cloud Storage folder name v1";
  const SHARE_AUTH_CONTEXT = "T-ROOM Cloud Storage share authentication v1";
  const SHARE_WRAP_CONTEXT = "T-ROOM Cloud Storage share key v1";
  const SHARE_TOKEN_CONTEXT = "T-ROOM Cloud Storage share token v1";
  const FILE_KEY_CONTEXT = "T-ROOM Cloud Storage file key v1";
  const FILE_METADATA_CONTEXT = "T-ROOM Cloud Storage file metadata v1";
  const FILE_CHUNK_CONTEXT = "T-ROOM Cloud Storage file chunk v1";
  const THUMBNAIL_CONTEXT = "T-ROOM Cloud Storage thumbnail v1";
  const FILE_CHUNK_SIZE = 8 * 1024 * 1024;

  async function deriveAccountCredentials(password) {
    ensureCryptoSupport();
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new Error("アカウントパスワードを確認してください。");
    const saltDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(ACCOUNT_SALT_CONTEXT)));
    const master = await hashwasm.argon2id({
      password,
      salt: saltDigest.slice(0, 16),
      ...KDF_OPTIONS,
      outputType: "binary"
    });
    try {
      const [accountKey, authBytes] = await Promise.all([
        deriveAesKey(master, ADMIN_WRAP_CONTEXT),
        deriveBytes(master, ACCOUNT_AUTH_CONTEXT, 32)
      ]);
      return { accountKey, authProof: toBase64Url(authBytes) };
    } finally {
      master.fill(0);
    }
  }

  async function deriveAccountKey(password) {
    return (await deriveAccountCredentials(password)).accountKey;
  }

  async function createVault(accountKey) {
    ensureCryptoSupport();
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
    const [publicKeyJwk, privatePkcs8] = await Promise.all([
      crypto.subtle.exportKey("jwk", keyPair.publicKey),
      crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
    ]);
    publicKeyJwk.alg = "RSA-OAEP-256";
    publicKeyJwk.key_ops = ["encrypt"];

    const adminWrapped = await encryptBytes(accountKey, new Uint8Array(privatePkcs8), textEncoder.encode(ADMIN_WRAP_CONTEXT));
    const recoveryBytes = crypto.getRandomValues(new Uint8Array(32));
    const recoveryKey = await deriveAesKey(recoveryBytes, RECOVERY_WRAP_CONTEXT);
    const recoveryWrapped = await encryptBytes(recoveryKey, new Uint8Array(privatePkcs8), textEncoder.encode(RECOVERY_WRAP_CONTEXT));
    const recoveryCode = formatRecoveryCode(recoveryBytes);
    recoveryBytes.fill(0);

    return {
      publicKeyJwk,
      privateKey: keyPair.privateKey,
      recoveryCode,
      payload: {
        publicKeyJwk,
        adminPrivateCipher: toBase64Url(adminWrapped.ciphertext),
        adminPrivateIv: toBase64Url(adminWrapped.iv),
        recoveryPrivateCipher: toBase64Url(recoveryWrapped.ciphertext),
        recoveryPrivateIv: toBase64Url(recoveryWrapped.iv)
      }
    };
  }

  async function unlockAdminPrivateKey(accountKey, config) {
    const bytes = await decryptBytes(
      accountKey,
      fromBase64Url(config.adminPrivateCipher),
      fromBase64Url(config.adminPrivateIv),
      textEncoder.encode(ADMIN_WRAP_CONTEXT)
    );
    try {
      return await crypto.subtle.importKey("pkcs8", bytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    } finally {
      bytes.fill(0);
    }
  }

  async function recoverAdminPrivateKey(recoveryCode, config) {
    const recoveryBytes = parseRecoveryCode(recoveryCode);
    const recoveryKey = await deriveAesKey(recoveryBytes, RECOVERY_WRAP_CONTEXT);
    recoveryBytes.fill(0);
    const bytes = await decryptBytes(
      recoveryKey,
      fromBase64Url(config.recoveryPrivateCipher),
      fromBase64Url(config.recoveryPrivateIv),
      textEncoder.encode(RECOVERY_WRAP_CONTEXT)
    );
    try {
      return await crypto.subtle.importKey("pkcs8", bytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    } finally {
      bytes.fill(0);
    }
  }

  async function createFolderPackage(name, password, publicKey, parentFolderKey = null) {
    const cleanName = validateFolderName(name);
    const inheritsProtection = Boolean(parentFolderKey && !password);
    if (!inheritsProtection) validateFolderPassword(password);
    const rawFolderKey = crypto.getRandomValues(new Uint8Array(32));
    const folderKey = await importFolderKey(rawFolderKey);
    const nameEncrypted = await encryptBytes(folderKey, textEncoder.encode(cleanName), textEncoder.encode(FOLDER_NAME_CONTEXT));
    const passwordPackage = inheritsProtection ? {} : await wrapFolderKeyWithPassword(rawFolderKey, password);
    const adminWrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawFolderKey));
    const parentPackage = parentFolderKey
      ? await wrapRawKey(rawFolderKey, parentFolderKey, PARENT_FOLDER_WRAP_CONTEXT, "parentWrappedKey", "parentWrapIv")
      : {};
    rawFolderKey.fill(0);
    return {
      folderKey,
      name: cleanName,
      payload: {
        cryptoVersion: 1,
        encryptedName: toBase64Url(nameEncrypted.ciphertext),
        nameIv: toBase64Url(nameEncrypted.iv),
        adminWrappedKey: toBase64Url(adminWrapped),
        inheritsProtection,
        ...parentPackage,
        ...passwordPackage
      }
    };
  }

  async function unlockFolderAsAdmin(folder, privateKey) {
    if (Number(folder.cryptoVersion) !== 1) throw new Error("このフォルダは暗号化形式に対応していません。");
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, fromBase64Url(folder.adminWrappedKey)));
    try { return await importFolderKey(raw); }
    catch { throw new Error("管理者用のフォルダ鍵を解除できません。"); }
    finally { raw.fill(0); }
  }

  async function unlockFolderWithPassword(folder, password) {
    validateFolderPassword(password);
    const salt = fromBase64Url(folder.passwordSalt);
    const master = await deriveFolderMaster(password, salt);
    try {
      const authProof = await makeAuthProof(master);
      const wrapKey = await deriveAesKey(master, FOLDER_WRAP_CONTEXT);
      const raw = await decryptBytes(
        wrapKey,
        fromBase64Url(folder.passwordWrappedKey),
        fromBase64Url(folder.passwordWrapIv),
        textEncoder.encode(FOLDER_WRAP_CONTEXT)
      );
      try { return { folderKey: await importFolderKey(raw), authProof }; }
      finally { raw.fill(0); }
    } finally {
      master.fill(0);
    }
  }

  async function unlockFolderFromParent(folder, parentFolderKey) {
    if (!folder.parentWrappedKey || !folder.parentWrapIv) throw new Error("共有フォルダの暗号化鍵を確認してください。");
    const raw = await decryptBytes(
      parentFolderKey,
      fromBase64Url(folder.parentWrappedKey),
      fromBase64Url(folder.parentWrapIv),
      textEncoder.encode(PARENT_FOLDER_WRAP_CONTEXT)
    );
    try { return await importFolderKey(raw); }
    finally { raw.fill(0); }
  }

  async function decryptFolderName(folder, folderKey) {
    if (Number(folder.cryptoVersion) !== 1) return folder.name;
    const bytes = await decryptBytes(
      folderKey,
      fromBase64Url(folder.encryptedName),
      fromBase64Url(folder.nameIv),
      textEncoder.encode(FOLDER_NAME_CONTEXT)
    );
    try { return validateFolderName(textDecoder.decode(bytes)); }
    finally { bytes.fill(0); }
  }

  async function encryptFolderName(name, folderKey) {
    const cleanName = validateFolderName(name);
    const encrypted = await encryptBytes(folderKey, textEncoder.encode(cleanName), textEncoder.encode(FOLDER_NAME_CONTEXT));
    return { name: cleanName, encryptedName: toBase64Url(encrypted.ciphertext), nameIv: toBase64Url(encrypted.iv) };
  }

  async function rewrapFolderPassword(folderKey, password) {
    validateFolderPassword(password);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", folderKey));
    try { return await wrapFolderKeyWithPassword(raw, password); }
    finally { raw.fill(0); }
  }

  async function createSharePackage(targetKey, password) {
    validateSharePassword(password);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", targetKey));
    const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
    const master = await deriveFolderMaster(password, passwordSalt);
    try {
      const authProof = await makeContextAuthProof(master, SHARE_AUTH_CONTEXT);
      const wrapKey = await deriveAesKey(master, SHARE_WRAP_CONTEXT);
      const wrapped = await encryptBytes(wrapKey, raw, textEncoder.encode(SHARE_WRAP_CONTEXT));
      return {
        authProof,
        passwordSalt: toBase64Url(passwordSalt),
        passwordWrappedKey: toBase64Url(wrapped.ciphertext),
        passwordWrapIv: toBase64Url(wrapped.iv)
      };
    } finally {
      raw.fill(0);
      master.fill(0);
    }
  }

  async function unlockShareKey(share, password) {
    validateSharePassword(password);
    const salt = fromBase64Url(share.passwordSalt);
    const master = await deriveFolderMaster(password, salt);
    try {
      const authProof = await makeContextAuthProof(master, SHARE_AUTH_CONTEXT);
      const wrapKey = await deriveAesKey(master, SHARE_WRAP_CONTEXT);
      const raw = await decryptBytes(
        wrapKey,
        fromBase64Url(share.passwordWrappedKey),
        fromBase64Url(share.passwordWrapIv),
        textEncoder.encode(SHARE_WRAP_CONTEXT)
      );
      try { return { targetKey: await importFolderKey(raw), authProof }; }
      finally { raw.fill(0); }
    } finally {
      master.fill(0);
    }
  }

  async function deriveShareAuthProof(share, password) {
    validateSharePassword(password);
    const salt = fromBase64Url(share.passwordSalt);
    const master = await deriveFolderMaster(password, salt);
    try { return await makeContextAuthProof(master, SHARE_AUTH_CONTEXT); }
    finally { master.fill(0); }
  }

  async function encryptShareToken(token, targetKey) {
    const value = String(token || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("共有URLのトークンを確認してください。");
    const encrypted = await encryptBytes(targetKey, textEncoder.encode(value), textEncoder.encode(SHARE_TOKEN_CONTEXT));
    return { encryptedToken: toBase64Url(encrypted.ciphertext), tokenIv: toBase64Url(encrypted.iv) };
  }

  async function decryptShareToken(share, targetKey) {
    const bytes = await decryptBytes(
      targetKey,
      fromBase64Url(share.encryptedToken),
      fromBase64Url(share.tokenIv),
      textEncoder.encode(SHARE_TOKEN_CONTEXT)
    );
    try {
      const token = textDecoder.decode(bytes);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
      return token;
    } catch {
      throw new Error("共有URLを復号できません。");
    } finally {
      bytes.fill(0);
    }
  }

  async function createFilePackage(file, folderKey, mediaKind) {
    const rawFileKey = crypto.getRandomValues(new Uint8Array(32));
    const fileKey = await crypto.subtle.importKey("raw", rawFileKey, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    const metadata = textEncoder.encode(JSON.stringify({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      mediaKind,
      lastModified: Number(file.lastModified || 0)
    }));
    const encryptedMetadata = await encryptBytes(fileKey, metadata, textEncoder.encode(FILE_METADATA_CONTEXT));
    const wrappedFileKey = await encryptBytes(folderKey, rawFileKey, textEncoder.encode(FILE_KEY_CONTEXT));
    rawFileKey.fill(0);
    const chunkCount = Math.ceil(file.size / FILE_CHUNK_SIZE);
    return {
      fileKey,
      payload: {
        cryptoVersion: 1,
        sizeBytes: file.size,
        encryptedMetadata: toBase64Url(encryptedMetadata.ciphertext),
        metadataIv: toBase64Url(encryptedMetadata.iv),
        wrappedFileKey: toBase64Url(wrappedFileKey.ciphertext),
        fileKeyIv: toBase64Url(wrappedFileKey.iv),
        chunkSizeBytes: FILE_CHUNK_SIZE,
        chunkCount,
        encryptedSizeBytes: file.size + chunkCount * 32
      }
    };
  }

  async function unlockFileKey(file, folderKey) {
    const raw = await decryptBytes(
      folderKey,
      fromBase64Url(file.wrappedFileKey),
      fromBase64Url(file.fileKeyIv),
      textEncoder.encode(FILE_KEY_CONTEXT)
    );
    try { return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); }
    finally { raw.fill(0); }
  }

  async function decryptFileMetadata(file, fileKey) {
    const bytes = await decryptBytes(
      fileKey,
      fromBase64Url(file.encryptedMetadata),
      fromBase64Url(file.metadataIv),
      textEncoder.encode(FILE_METADATA_CONTEXT)
    );
    try {
      const metadata = JSON.parse(textDecoder.decode(bytes));
      if (!metadata || typeof metadata.name !== "string" || metadata.name.length > 240) throw new Error();
      return metadata;
    } catch {
      throw new Error("ファイル情報を復号できません。");
    } finally {
      bytes.fill(0);
    }
  }

  async function encryptFileMetadata(metadata, fileKey) {
    if (!metadata || typeof metadata.name !== "string" || !metadata.name.trim() || metadata.name.length > 240) throw new Error("ファイル名を確認してください。");
    const encrypted = await encryptBytes(fileKey, textEncoder.encode(JSON.stringify(metadata)), textEncoder.encode(FILE_METADATA_CONTEXT));
    return { encryptedMetadata: toBase64Url(encrypted.ciphertext), metadataIv: toBase64Url(encrypted.iv) };
  }

  async function encryptFileChunk(fileKey, bytes, index) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = textEncoder.encode(`${FILE_CHUNK_CONTEXT}|${index}`);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, fileKey, bytes));
    const envelope = new Uint8Array(4 + iv.length + ciphertext.length);
    envelope.set([0x54, 0x52, 0x43, 0x31], 0);
    envelope.set(iv, 4);
    envelope.set(ciphertext, 16);
    return envelope;
  }

  async function decryptFileChunk(fileKey, envelope, index) {
    const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
    if (bytes.length < 32 || bytes[0] !== 0x54 || bytes[1] !== 0x52 || bytes[2] !== 0x43 || bytes[3] !== 0x31) {
      throw new Error("暗号化ファイルの形式を確認してください。");
    }
    return decryptBytes(fileKey, bytes.subarray(16), bytes.subarray(4, 16), textEncoder.encode(`${FILE_CHUNK_CONTEXT}|${index}`));
  }

  async function encryptThumbnail(blob, fileKey) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const encrypted = await encryptBytes(fileKey, bytes, textEncoder.encode(THUMBNAIL_CONTEXT));
    bytes.fill(0);
    const envelope = new Uint8Array(4 + 12 + encrypted.ciphertext.length);
    envelope.set([0x54, 0x52, 0x54, 0x48], 0);
    envelope.set(encrypted.iv, 4);
    envelope.set(encrypted.ciphertext, 16);
    return new Blob([envelope], { type: "application/octet-stream" });
  }

  async function decryptThumbnail(buffer, fileKey) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 32 || bytes[0] !== 0x54 || bytes[1] !== 0x52 || bytes[2] !== 0x54 || bytes[3] !== 0x48) {
      throw new Error("サムネイルの暗号化形式を確認してください。");
    }
    return decryptBytes(fileKey, bytes.subarray(16), bytes.subarray(4, 16), textEncoder.encode(THUMBNAIL_CONTEXT));
  }

  async function wrapFolderKeyWithPassword(rawFolderKey, password) {
    const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
    const master = await deriveFolderMaster(password, passwordSalt);
    try {
      const authProof = await makeAuthProof(master);
      const wrapKey = await deriveAesKey(master, FOLDER_WRAP_CONTEXT);
      const wrapped = await encryptBytes(wrapKey, rawFolderKey, textEncoder.encode(FOLDER_WRAP_CONTEXT));
      return {
        authProof,
        passwordSalt: toBase64Url(passwordSalt),
        passwordWrappedKey: toBase64Url(wrapped.ciphertext),
        passwordWrapIv: toBase64Url(wrapped.iv)
      };
    } finally {
      master.fill(0);
    }
  }

  async function deriveFolderMaster(password, salt) {
    return hashwasm.argon2id({ password, salt, ...KDF_OPTIONS, outputType: "binary" });
  }

  async function makeAuthProof(master) {
    return makeContextAuthProof(master, FOLDER_AUTH_CONTEXT);
  }

  async function makeContextAuthProof(master, context) {
    const key = await crypto.subtle.importKey("raw", master, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(context))));
  }

  async function wrapRawKey(rawKey, wrappingKey, context, keyField, ivField) {
    const wrapped = await encryptBytes(wrappingKey, rawKey, textEncoder.encode(context));
    return { [keyField]: toBase64Url(wrapped.ciphertext), [ivField]: toBase64Url(wrapped.iv) };
  }

  async function importFolderKey(raw) {
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  async function deriveAesKey(material, context) {
    const hkdfKey = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(`${context}|salt`)));
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode(context) },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function deriveBytes(material, context, length) {
    const baseKey = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: textEncoder.encode(context) },
      baseKey,
      length * 8
    ));
  }

  async function encryptBytes(key, bytes, additionalData) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, bytes));
    return { iv, ciphertext };
  }

  async function decryptBytes(key, ciphertext, iv, additionalData) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, ciphertext));
    } catch {
      throw new Error("暗号化鍵を解除できません。パスワードまたは復旧鍵を確認してください。");
    }
  }

  function formatRecoveryCode(bytes) {
    const raw = toBase64Url(bytes);
    return `TRC1-${raw.match(/.{1,5}/g).join(".")}`;
  }

  function parseRecoveryCode(value) {
    const encoded = String(value || "").trim().replace(/^TRC1-/, "");
    let raw = encoded.replace(/[.\s]/g, "");
    // 初期のローカル試験版は「-」を5文字ごとの区切りにも使用していたため、
    // Base64URL本来の「-」と衝突していた。51文字なら固定位置の区切りだけを除く。
    if (!encoded.includes(".") && encoded.length === 51) {
      raw = [...encoded].filter((_character, index) => (index + 1) % 6 !== 0).join("");
    }
    const bytes = fromBase64Url(raw);
    if (bytes.length !== 32) throw new Error("緊急用復旧鍵を確認してください。");
    return bytes;
  }

  function toBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function fromBase64Url(value) {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
    try { return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); }
    catch { throw new Error("暗号化情報が破損しています。"); }
  }

  function ensureCryptoSupport() {
    if (!globalThis.crypto?.subtle || !globalThis.hashwasm?.argon2id) throw new Error("このブラウザは必要な暗号化機能に対応していません。");
  }

  function validateFolderName(value) {
    const name = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
    if (!name || name.length > 240 || name === "." || name === "..") throw new Error("フォルダ名を確認してください。");
    return name;
  }

  function validateFolderPassword(value) {
    if (typeof value !== "string" || value.length < 4 || value.length > 128) throw new Error("フォルダパスワードは4文字以上128文字以内で設定してください。");
  }

  function validateSharePassword(value) {
    if (typeof value !== "string" || value.length < 12 || value.length > 128) throw new Error("共有パスワードは12文字以上128文字以内で設定してください。");
  }

  globalThis.TRoomCrypto = Object.freeze({
    deriveAccountCredentials,
    deriveAccountKey,
    createVault,
    unlockAdminPrivateKey,
    recoverAdminPrivateKey,
    createFolderPackage,
    unlockFolderAsAdmin,
    unlockFolderWithPassword,
    unlockFolderFromParent,
    decryptFolderName,
    encryptFolderName,
    rewrapFolderPassword,
    createSharePackage,
    deriveShareAuthProof,
    unlockShareKey,
    encryptShareToken,
    decryptShareToken,
    createFilePackage,
    unlockFileKey,
    decryptFileMetadata,
    encryptFileMetadata,
    encryptFileChunk,
    decryptFileChunk,
    encryptThumbnail,
    decryptThumbnail,
    fileChunkSize: FILE_CHUNK_SIZE,
    toBase64Url,
    fromBase64Url,
    textEncoder,
    textDecoder,
    kdf: KDF_OPTIONS
  });
})();
