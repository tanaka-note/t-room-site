import {
  b64,
  unb64,
  encode,
  fingerprint,
  open,
  seal,
  signed,
  verifySigned,
  verifyDirectory,
} from "./crypto.mjs";

const binding = (generation) => ({
  household: "recovery",
  scope: "diary-recovery",
  id: "keyset",
  revision: generation,
  epoch: 1,
  kind: "recovery",
});
const wrappingLabel = (packet) =>
  encode({
    protocol: "T-lain diary recovery",
    version: 1,
    generation: packet.generation,
    authority: packet.authority,
    recoveryFingerprint: packet.recoveryFingerprint,
  });
const recoveryKey = (secret) =>
  crypto.subtle.importKey("raw", secret, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

// The existing Security Center/T-Cloud recovery RSA key wraps an independent
// diary kit key. No additional user-managed recovery secret is issued.
// expectedRecoveryFingerprint comes from a previously trusted device/checkpoint,
// not the same API response supplying recoveryPublicKey.
export async function createRecoveryEnvelope({
  scopeKeys,
  authority,
  directory,
  anchor,
  recoveryPublicKey,
  expectedRecoveryFingerprint,
}) {
  const verified = await verifyDirectory(directory, anchor);
  const recoveryFingerprint = await fingerprint(recoveryPublicKey);
  if (
    !expectedRecoveryFingerprint ||
    recoveryFingerprint !== expectedRecoveryFingerprint ||
    recoveryPublicKey.kty !== "RSA" ||
    recoveryPublicKey.d ||
    unb64(recoveryPublicKey.n).length !== 512 ||
    recoveryPublicKey.e !== "AQAB"
  )
    throw new Error("UntrustedRecoveryKey");
  if (verified.recoveryFingerprint !== recoveryFingerprint)
    throw new Error("RecoveryDirectoryMismatch");
  await verifySigned(
    await signed({ generation: verified.generation }, authority),
    anchor,
  );
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const signer = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", authority),
  );
  const rawKeys = [];
  try {
    const keys = {};
    for (const [scope, key] of scopeKeys) {
      if (!Object.hasOwn(verified.epochs, scope))
        throw new Error("UnknownScope");
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      rawKeys.push(raw);
      keys[scope] = b64(raw);
    }
    if (Object.keys(keys).length !== Object.keys(verified.epochs).length)
      throw new Error("IncompleteRecoveryKit");
    const envelope = await seal(
      await recoveryKey(secret),
      { version: 1, signer: b64(signer), keys, directory },
      binding(verified.generation),
    );
    const packet = {
      version: 1,
      generation: verified.generation,
      authority: await fingerprint(anchor),
      recoveryFingerprint,
      envelope,
    };
    const recipient = await crypto.subtle.importKey(
      "jwk",
      recoveryPublicKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    packet.wrappedKey = b64(
      await crypto.subtle.encrypt(
        { name: "RSA-OAEP", label: wrappingLabel(packet) },
        recipient,
        secret,
      ),
    );
    return packet;
  } finally {
    secret.fill(0);
    signer.fill(0);
    for (const raw of rawKeys) raw.fill(0);
  }
}

// recoveryPrivateKey is unlocked locally by the EXISTING Security Center flow.
// The server stores only this envelope; no PRF, password or plaintext key crosses
// the diary API. Scope/authority keys remain distinct from the T-Cloud RSA key.
export async function openRecoveryEnvelope({
  packet,
  recoveryPrivateKey,
  anchor,
  minimumGeneration = 1,
}) {
  if (
    packet?.version !== 1 ||
    packet.authority !== (await fingerprint(anchor)) ||
    !Number.isSafeInteger(packet.generation) ||
    packet.generation < minimumGeneration
  )
    throw new Error("InvalidRecoveryKit");
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: wrappingLabel(packet) },
      recoveryPrivateKey,
      unb64(packet.wrappedKey, 684),
    ),
  );
  let value;
  try {
    if (bytes.length !== 32) throw new Error("InvalidRecoveryKit");
    value = await open(
      await recoveryKey(bytes),
      packet.envelope,
      binding(packet.generation),
    );
  } finally {
    bytes.fill(0);
  }
  const directory = await verifyDirectory(
    value.directory,
    anchor,
    minimumGeneration,
  );
  if (
    directory.generation !== packet.generation ||
    value.version !== 1 ||
    Object.keys(value.keys).sort().join(",") !==
      Object.keys(directory.epochs).sort().join(",")
  )
    throw new Error("InvalidRecoveryKit");
  const raw = unb64(value.signer),
    scopeKeys = new Map();
  let authority;
  try {
    authority = await crypto.subtle.importKey(
      "pkcs8",
      raw,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
  } finally {
    raw.fill(0);
  }
  await verifySigned(
    await signed(
      { challenge: b64(crypto.getRandomValues(new Uint8Array(32))) },
      authority,
    ),
    anchor,
  );
  for (const [scope, encoded] of Object.entries(value.keys)) {
    const bytes = unb64(encoded, 43);
    try {
      if (bytes.length !== 32) throw new Error("InvalidRecoveryKit");
      scopeKeys.set(
        scope,
        await crypto.subtle.importKey("raw", bytes, "AES-GCM", true, [
          "encrypt",
          "decrypt",
        ]),
      );
    } finally {
      bytes.fill(0);
    }
  }
  // Recovery-only extractable keys enable grants for a newly approved passkey.
  // Dispose of this object immediately after rewrapping on the trusted device.
  return { directory, authority, scopeKeys };
}
