const protocol = "T-lain Billing cryptography v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const recordKinds = ["entry", "settlement", "opening-balance", "audit", "month", "index"];
const maxRecordBytes = 128 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) return value;
  throw new Error("Invalid billing encryption data");
}

function encode(value) {
  return encoder.encode(JSON.stringify(canonical(value)));
}

function base64(bytes) {
  const data = new Uint8Array(bytes);
  if (data.toBase64) return data.toBase64({ alphabet: "base64url", omitPadding: true });
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += 8192) {
    chunks.push(String.fromCharCode(...data.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function bytes(text, maxLength) {
  if (typeof text !== "string" || text.length > Math.ceil(maxLength * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("Invalid billing ciphertext");
  const decoded = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), symbol => symbol.charCodeAt(0));
  if (decoded.length > maxLength || base64(decoded) !== text) throw new Error("Invalid billing ciphertext");
  return decoded;
}

function token(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error("Invalid billing key scope");
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid billing revision");
  return value;
}

function scopeParts(scope) {
  return [token(scope.ledgerId), version(scope.generation)];
}

async function derivedKey(material, purpose, algorithm, usages) {
  if (!(material instanceof Uint8Array) || material.length !== 32) throw new Error("A billing key must contain 32 bytes");
  const base = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode(protocol), info: encode(purpose)
  }, base, algorithm, false, usages);
}

const recordCipher = { name: "AES-GCM", length: 256 };
const recipientCipher = { name: "RSA-OAEP", hash: "SHA-256" };
const signatureAlgorithm = { name: "ECDSA", namedCurve: "P-256" };

async function seal(key, plaintext, binding) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: encode(binding), tagLength: 128
  }, key, plaintext);
  return { iv: base64(iv), ciphertext: base64(ciphertext) };
}

async function open(key, envelope, binding, limit) {
  const iv = bytes(envelope.iv, 12);
  if (iv.length !== 12) throw new Error("Invalid billing IV");
  const ciphertext = bytes(envelope.ciphertext, limit + 16);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", iv, additionalData: encode(binding), tagLength: 128
  }, key, ciphertext));
}

export async function billingLedgerKeys(material, scope) {
  const parts = scopeParts(scope);
  const [cipher, lookup] = await Promise.all([
    derivedKey(material, ["ledger", "cipher", ...parts], recordCipher, ["encrypt", "decrypt"]),
    derivedKey(material, ["ledger", "lookup", ...parts], { name: "HMAC", hash: "SHA-256" }, ["sign"])
  ]);
  return { cipher, lookup };
}

export async function billingRecordId(keys, kind, sourceId) {
  if (!recordKinds.includes(kind) || typeof sourceId !== "string" || !sourceId || sourceId.length > 160) {
    throw new Error("Invalid billing record identity");
  }
  return base64(await crypto.subtle.sign("HMAC", keys.lookup, encode([kind, sourceId])));
}

function recordBinding(scope, id, revision) {
  return [protocol, "record", ...scopeParts(scope), token(id), version(revision)];
}

export async function sealBillingRecord(keys, scope, revision, value) {
  if (!value || !Object.hasOwn(value, "data")) throw new Error("Invalid billing record");
  const { kind, sourceId, data } = value;
  const id = await billingRecordId(keys, kind, sourceId);
  const plaintext = encode({ kind, sourceId, data });
  try {
    if (plaintext.length > maxRecordBytes) throw new Error("Billing record too large");
    return { id, revision, ...await seal(keys.cipher, plaintext, recordBinding(scope, id, revision)) };
  } finally {
    plaintext.fill(0);
  }
}

export async function openBillingRecord(keys, scope, record) {
  const binding = recordBinding(scope, record.id, record.revision);
  const plaintext = await open(keys.cipher, record, binding, maxRecordBytes);
  try {
    const value = JSON.parse(decoder.decode(plaintext));
    if (await billingRecordId(keys, value.kind, value.sourceId) !== record.id) throw new Error("Billing record identity mismatch");
    return value;
  } finally {
    plaintext.fill(0);
  }
}

function recipientBinding(scope, recipient) {
  return [protocol, "grant", ...scopeParts(scope), ...(
    recipient === "recovery" ? ["recovery"] : [
      "credential", token(recipient.identityId), token(recipient.credentialId), token(recipient.serviceLinkId)
    ]
  )];
}

export async function wrapBillingLedgerKey(material, scope, recipient, publicKey) {
  if (!(material instanceof Uint8Array) || material.length !== 32) throw new Error("Invalid billing ledger key");
  const label = encode(recipientBinding(scope, recipient));
  const key = await crypto.subtle.importKey("jwk", publicKey, recipientCipher, false, ["encrypt"]);
  if (key.algorithm.modulusLength < 3072) throw new Error("Invalid billing recipient key");
  return base64(await crypto.subtle.encrypt({ name: "RSA-OAEP", label }, key, material));
}

export async function unwrapBillingLedgerKey(ciphertext, scope, recipient, privateKey) {
  const label = encode(recipientBinding(scope, recipient));
  const material = new Uint8Array(await crypto.subtle.decrypt({
    name: "RSA-OAEP", label
  }, privateKey, bytes(ciphertext, 512)));
  if (material.length === 32) return material;
  material.fill(0);
  throw new Error("Invalid billing ledger key");
}

function vaultBinding(credentialId, kind) {
  return [protocol, "private-key", token(credentialId), kind];
}

async function createVaultKey(prf, credentialId, kind, algorithm, usages) {
  const binding = vaultBinding(credentialId, kind);
  const [pair, key] = await Promise.all([
    crypto.subtle.generateKey(algorithm, true, usages),
    derivedKey(prf, binding, recordCipher, ["encrypt"])
  ]);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  try {
    return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), ...await seal(key, privateBytes, binding) };
  } finally {
    privateBytes.fill(0);
  }
}

export async function createBillingVault(prf, credentialId, { signing = false } = {}) {
  const recipient = await createVaultKey(prf, credentialId, "recipient", {
    ...recipientCipher, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1])
  }, ["encrypt", "decrypt"]);
  const writer = signing ? await createVaultKey(prf, credentialId, "writer", signatureAlgorithm, ["sign", "verify"]) : null;
  return { recipient, writer };
}

async function openVaultKey(prf, credentialId, kind, envelope, algorithm, usage) {
  const binding = vaultBinding(credentialId, kind);
  const key = await derivedKey(prf, binding, recordCipher, ["decrypt"]);
  const plaintext = await open(key, envelope, binding, 4096);
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", plaintext, algorithm, false, [usage]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    if (usage === "sign") {
      const verificationKey = await crypto.subtle.importKey("jwk", envelope.publicKey, algorithm, false, ["verify"]);
      const signing = { name: "ECDSA", hash: "SHA-256" };
      const signature = await crypto.subtle.sign(signing, privateKey, challenge);
      if (!await crypto.subtle.verify(signing, verificationKey, signature, challenge)) throw new Error("Billing vault key mismatch");
    } else {
      const publicKey = await crypto.subtle.importKey("jwk", envelope.publicKey, algorithm, false, ["encrypt"]);
      const ciphertext = await crypto.subtle.encrypt("RSA-OAEP", publicKey, challenge);
      const opened = new Uint8Array(await crypto.subtle.decrypt("RSA-OAEP", privateKey, ciphertext));
      if (opened.length !== challenge.length || opened.some((value, index) => value !== challenge[index])) {
        throw new Error("Billing vault key mismatch");
      }
    }
    return privateKey;
  } finally {
    plaintext.fill(0);
  }
}

export async function unlockBillingVault(prf, credentialId, vault) {
  const [recipient, writer] = await Promise.all([
    openVaultKey(prf, credentialId, "recipient", vault.recipient, recipientCipher, "decrypt"),
    vault.writer ? openVaultKey(prf, credentialId, "writer", vault.writer, signatureAlgorithm, "sign") : null
  ]);
  return { recipient, writer };
}

export async function billingEncryptedDigest(records) {
  const ordered = [...records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (ordered.some((record, index) => index > 0 && ordered[index - 1].id === record.id)) {
    throw new Error("Duplicate billing ciphertext");
  }
  return base64(await crypto.subtle.digest("SHA-256", encode(ordered)));
}

function signedState(scope, revision, digest) {
  if (bytes(digest, 32).length !== 32) throw new Error("Invalid billing state digest");
  return encode([protocol, "state", ...scopeParts(scope), version(revision), digest]);
}

export async function signBillingState(privateKey, scope, revision, digest) {
  return base64(await crypto.subtle.sign({
    name: "ECDSA", hash: "SHA-256"
  }, privateKey, signedState(scope, revision, digest)));
}

export async function verifyBillingState(publicKey, scope, revision, digest, signature) {
  const key = await crypto.subtle.importKey("jwk", publicKey, signatureAlgorithm, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
    bytes(signature, 64), signedState(scope, revision, digest));
}
