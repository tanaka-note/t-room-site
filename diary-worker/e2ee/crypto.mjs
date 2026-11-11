// Candidate protocol. No runtime secret or production binding is defined here.
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export const VERSION = 1;
export const RECOVERY_RECIPIENT = "__recovery__";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const encode = (value) =>
  encoder.encode(JSON.stringify(canonical(value)));
export const b64 = (value) => {
  const bytes = new Uint8Array(value);
  if (bytes.toBase64)
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
function base64Length(value, max) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    !/^[\w-]+$/.test(value) ||
    value.length % 4 === 1
  )
    throw new Error("InvalidEnvelope");
  return Math.floor((value.length * 3) / 4);
}
export function unb64(value, max = 2_000_000) {
  base64Length(value, max);
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(value, { alphabet: "base64url" });
  const text = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  const result = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
  return result;
}
// Fixed property order, with unknown fields rejected by the storage boundary.
export function context(value) {
  const { household, scope, id, revision, epoch, kind } = value;
  if (
    ![household, scope, id, kind].every(
      (v) => typeof v === "string" && /^[\w:-]{1,160}$/.test(v),
    ) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error("InvalidContext");
  return {
    protocol: "T-lain diary",
    version: VERSION,
    household,
    scope,
    id,
    revision,
    epoch,
    kind,
    state: value.state,
    author: value.author,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    retainedFor: value.retainedFor,
    photoIds: value.photoIds,
  };
}
export async function newKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(key, value, binding) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encode(context(binding)),
      tagLength: 128,
    },
    key,
    encode(value),
  );
  return { version: VERSION, iv: b64(iv), ciphertext: b64(ciphertext) };
}
export function validateEnvelope(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "ciphertext,iv,version" ||
    value.version !== VERSION ||
    unb64(value.iv, 16).length !== 12 ||
    base64Length(value.ciphertext, 2_000_000) < 16
  )
    throw new Error("InvalidEnvelope");
  return value;
}
export async function open(key, envelope, binding) {
  validateEnvelope(envelope);
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(envelope.iv),
        additionalData: encode(context(binding)),
        tagLength: 128,
      },
      key,
      unb64(envelope.ciphertext),
    ),
  );
  try {
    return JSON.parse(decoder.decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
export async function fingerprint(publicKey) {
  return b64(
    await crypto.subtle.digest(
      "SHA-256",
      encode({
        kty: publicKey.kty,
        crv: publicKey.crv,
        x: publicKey.x,
        y: publicKey.y,
        n: publicKey.n,
        e: publicKey.e,
      }),
    ),
  );
}
async function prfKey(prf, credentialId) {
  if (
    !(prf instanceof Uint8Array) ||
    prf.length !== 32 ||
    typeof credentialId !== "string" ||
    !/^[\w-]{1,2048}$/.test(credentialId)
  )
    throw new Error("PRFRequired");
  const material = await crypto.subtle.importKey("raw", prf, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("T-lain diary credential vault v1"),
      info: encoder.encode(credentialId),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function createVault(prf, credentialId) {
  const wrappingKey = await prfKey(prf, credentialId);
  const vaultId = b64(
    await crypto.subtle.digest("SHA-256", encoder.encode(credentialId)),
  );
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const signer = await signingKey();
  const signRaw = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", signer.privateKey),
  );
  try {
    return {
      publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
      signPublicKey: await crypto.subtle.exportKey("jwk", signer.publicKey),
      privateEnvelope: await seal(
        wrappingKey,
        { rsa: b64(raw), sign: b64(signRaw) },
        {
          household: "credential",
          scope: "vault",
          id: vaultId,
          revision: 1,
          epoch: 1,
          kind: "rsa-private",
        },
      ),
    };
  } finally {
    raw.fill(0);
    signRaw.fill(0);
  }
}
export async function unlockVault(prf, credentialId, vault) {
  const vaultId = b64(
    await crypto.subtle.digest("SHA-256", encoder.encode(credentialId)),
  );
  const value = await open(
    await prfKey(prf, credentialId),
    vault.privateEnvelope,
    {
      household: "credential",
      scope: "vault",
      id: vaultId,
      revision: 1,
      epoch: 1,
      kind: "rsa-private",
    },
  );
  const raw = unb64(value.rsa),
    signRaw = unb64(value.sign);
  try {
    return {
      rsa: await crypto.subtle.importKey(
        "pkcs8",
        raw,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["decrypt"],
      ),
      sign: await crypto.subtle.importKey(
        "pkcs8",
        signRaw,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    };
  } finally {
    raw.fill(0);
    signRaw.fill(0);
  }
}
export async function signingKey() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}
export async function signed(value, privateKey) {
  return {
    value,
    signature: b64(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        encode(value),
      ),
    ),
  };
}
export async function verifySigned(packet, publicKey) {
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unb64(packet.signature, 100),
      encode(packet.value),
    ))
  )
    throw new Error("InvalidSignature");
  return packet.value;
}
// The anchor MUST come from an already trusted device/recovery package, not the response being checked.
export async function verifyDirectory(packet, anchor, minimumGeneration = 1) {
  const value = await verifySigned(packet, anchor);
  if (
    value.protocol !== "T-lain diary directory" ||
    value.version !== VERSION ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < minimumGeneration ||
    !Array.isArray(value.members)
  )
    throw new Error("StaleDirectory");
  if (!value.epochs || !value.households || value.members.length > 100)
    throw new Error("InvalidDirectory");
  const token = (v) => typeof v === "string" && /^[\w:-]{1,160}$/.test(v);
  for (const [scope, epoch] of Object.entries(value.epochs))
    if (!token(scope) || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("InvalidDirectory");
  for (const [household, config] of Object.entries(value.households))
    if (
      !token(household) ||
      !token(config.owner) ||
      typeof config.independent !== "boolean"
    )
      throw new Error("InvalidDirectory");
  if (
    value.recoveryPublicKey?.kty !== "RSA" ||
    value.recoveryPublicKey.d ||
    unb64(value.recoveryPublicKey.n).length !== 512 ||
    value.recoveryPublicKey.e !== "AQAB" ||
    (await fingerprint(value.recoveryPublicKey)) !== value.recoveryFingerprint
  )
    throw new Error("InvalidDirectory");
  const ids = new Set();
  for (const member of value.members) {
    if (
      member.credentialId === RECOVERY_RECIPIENT ||
      ids.has(member.credentialId) ||
      !/^[\w-]{1,2048}$/.test(member.credentialId) ||
      !token(member.accountId) ||
      !Array.isArray(member.scopes) ||
      new Set(member.scopes).size !== member.scopes.length ||
      member.scopes.some((s) => !Object.hasOwn(value.epochs, s)) ||
      (await fingerprint(member.publicKey)) !== member.fingerprint ||
      typeof member.canManageEntries !== "boolean" ||
      !Array.isArray(member.households) ||
      member.households.some((h) => !Object.hasOwn(value.households, h))
    )
      throw new Error("InvalidDirectory");
    if (
      member.publicKey.kty !== "RSA" ||
      member.publicKey.d ||
      unb64(member.publicKey.n).length !== 384 ||
      member.publicKey.e !== "AQAB" ||
      member.signPublicKey?.kty !== "EC" ||
      member.signPublicKey?.crv !== "P-256" ||
      member.signPublicKey?.d
    )
      throw new Error("InvalidDirectory");
    await crypto.subtle.importKey(
      "jwk",
      member.signPublicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    ids.add(member.credentialId);
  }
  return value;
}
export async function recipientKeyBox(
  key,
  binding,
  members,
  recoveryPublicKey,
) {
  if (!recoveryPublicKey) throw new Error("RecoveryKeyRequired");
  members = [
    ...members,
    { credentialId: RECOVERY_RECIPIENT, publicKey: recoveryPublicKey },
  ];
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    const entries = await Promise.all(
      members.map(async (member) => {
        const recipient = await crypto.subtle.importKey(
          "jwk",
          member.publicKey,
          { name: "RSA-OAEP", hash: "SHA-256" },
          false,
          ["encrypt"],
        );
        return [
          member.credentialId,
          b64(
            await crypto.subtle.encrypt(
              { name: "RSA-OAEP", label: encode(context(binding)) },
              recipient,
              raw,
            ),
          ),
        ];
      }),
    );
    return Object.fromEntries(entries);
  } finally {
    raw.fill(0);
  }
}
export async function openRecipientKey(box, binding, credentialId, privateKey) {
  if (!box?.[credentialId]) throw new Error("GrantDenied");
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: encode(context(binding)) },
      privateKey,
      unb64(box[credentialId], credentialId === RECOVERY_RECIPIENT ? 684 : 512),
    ),
  );
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
}
export async function makeGrant(
  key,
  binding,
  member,
  directoryGeneration,
  signer,
) {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    member.publicKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const value = {
    version: VERSION,
    ...binding,
    accountId: member.accountId,
    credentialId: member.credentialId,
    fingerprint: member.fingerprint,
    directoryGeneration,
  };
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    const wrapped = b64(
      await crypto.subtle.encrypt(
        { name: "RSA-OAEP", label: encode(value) },
        publicKey,
        raw,
      ),
    );
    return signed({ ...value, wrapped }, signer);
  } finally {
    raw.fill(0);
  }
}
export async function unwrapGrant(
  grant,
  {
    directory,
    anchor,
    accountId,
    credentialId,
    household,
    scope,
    epoch,
    privateKey,
  },
) {
  const value = await verifySigned(grant, anchor);
  const member = directory.members.find(
    (m) => m.credentialId === credentialId && m.accountId === accountId,
  );
  if (
    !member ||
    !member.scopes.includes(scope) ||
    value.directoryGeneration !== directory.generation ||
    value.accountId !== accountId ||
    value.credentialId !== credentialId ||
    value.household !== household ||
    value.scope !== scope ||
    value.epoch !== epoch ||
    value.fingerprint !== member.fingerprint
  )
    throw new Error("GrantDenied");
  const { wrapped, ...label } = value;
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: encode(label) },
      privateKey,
      unb64(wrapped, 512),
    ),
  );
  try {
    if (raw.length !== 32) throw new Error("InvalidKey");
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
}
