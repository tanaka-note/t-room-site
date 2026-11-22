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
  recoveryWrappedBytes,
  newKey,
  openRecipientKey,
  wrapKeyForRecipients,
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
    !recoveryWrappedBytes(recoveryPublicKey)
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
    Object.keys(packet).sort().join(",") !== "authority,envelope,generation,recoveryFingerprint,version,wrappedKey" ||
    unb64(packet.wrappedKey, 684).length !== recoveryPrivateKey.algorithm.modulusLength / 8 ||
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
    packet.recoveryFingerprint !== directory.recoveryFingerprint ||
    recoveryWrappedBytes(directory.recoveryPublicKey) !== recoveryPrivateKey.algorithm.modulusLength / 8 ||
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

const delegationBinding = generation => ({
  household: "recovery", scope: "diary-delegation", id: "keyset", revision: generation, epoch: 1, kind: "recovery"
});
const rsa = { name: "RSA-OAEP", hash: "SHA-256" };
const signerAlgorithm = { name: "ECDSA", namedCurve: "P-256" };
export async function delegationInventoryDigest(entries) {
  const sorted = [...entries].sort(([left],[right]) => left.localeCompare(right,"en"));
  return b64(await crypto.subtle.digest("SHA-256",encode(sorted)));
}

export async function newDiaryDelegationKey() {
  const keys = await crypto.subtle.generateKey({ ...rsa, modulusLength: 3072,
    publicExponent: new Uint8Array([1,0,1]) }, true, ["encrypt","decrypt"]);
  return { publicKey: await crypto.subtle.exportKey("jwk",keys.publicKey), privateKey: keys.privateKey };
}

async function exportedKey(format,key) {
  const bytes = new Uint8Array(await crypto.subtle.exportKey(format,key));
  try { return b64(bytes); } finally { bytes.fill(0); }
}

export async function sealDiaryDelegation({ directory, authority, scopeKeys, legacy, delegation, members }) {
  const binding = delegationBinding(directory.generation);
  const key = await newKey();
  const secrets = {
    version: 1,
    signer: await exportedKey("pkcs8",authority),
    privateKey: await exportedKey("pkcs8",delegation.privateKey),
    scopes: Object.fromEntries(await Promise.all([...scopeKeys].map(async ([scope, value]) => [scope,await exportedKey("raw",value)]))),
    legacy: Object.fromEntries(await Promise.all([...legacy].map(async ([id,{signature,key}]) => [id,{signature,key:await exportedKey("raw",key)}])))
  };
  try {
    const envelope = await seal(key,secrets,binding);
    const wrapped = await wrapKeyForRecipients(key,binding,members);
    const legacyDigest=await delegationInventoryDigest([...legacy].map(([id,{signature}])=>[id,signature]));
    return signed({ generation:directory.generation,envelope,wrapped,legacyDigest },authority);
  } finally {
    secrets.signer=null; secrets.privateKey=null; secrets.scopes=null; secrets.legacy=null;
  }
}

async function importedKey(format,text,algorithm,usages,limit) {
  const bytes = unb64(text,limit);
  try { return await crypto.subtle.importKey(format,bytes,algorithm,true,usages); }
  finally { bytes.fill(0); }
}

export async function openDiaryDelegation({ packet, directory, anchor, recipientId, recipientKey }) {
  const value = await verifySigned(packet,anchor);
  if (value.generation !== directory.generation || !directory.delegationPublicKey || !value.wrapped[recipientId]) throw new Error("DiaryDelegationUnavailable");
  const binding = delegationBinding(directory.generation);
  const material = await openRecipientKey(value.wrapped,binding,recipientId,recipientKey);
  const data = await open(material,value.envelope,binding);
  if (data.version !== 1 || !data.legacy || Object.keys(data.legacy).length > 5000 ||
      Object.keys(data.scopes).sort().join() !== Object.keys(directory.epochs).sort().join()) throw new Error("InvalidDiaryDelegation");
  if(value.legacyDigest!==await delegationInventoryDigest(Object.entries(data.legacy).map(([id,{signature}])=>[id,signature]))) {
    throw new Error("InvalidDiaryDelegation");
  }
  const [authority,privateKey] = await Promise.all([
    importedKey("pkcs8",data.signer,signerAlgorithm,["sign"],512),
    importedKey("pkcs8",data.privateKey,rsa,["decrypt"],4096)
  ]);
  await verifySigned(await signed({generation:directory.generation},authority),anchor);
  const scopeKeys = new Map(await Promise.all(Object.entries(data.scopes).map(async ([scope,key]) =>
    [scope,await importedKey("raw",key,{name:"AES-GCM"},["encrypt","decrypt"],43)])));
  return {
    authority, scopeKeys, delegation:{publicKey:directory.delegationPublicKey,privateKey},
    openLegacyRecord: async record => {
      const saved = data.legacy[record.id];
      if (!saved || saved.signature !== record.attestation.signature) throw new Error("DiaryDelegationRecordChanged");
      return importedKey("raw",saved.key,{name:"AES-GCM"},["encrypt","decrypt"],43);
    }
  };
}
