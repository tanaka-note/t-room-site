import {
  b64,
  encode,
  verifyDirectory,
  unlockVault,
  unwrapGrant,
  signed,
  verifySigned,
} from "./crypto.mjs";
import {validDeviceKeys} from './device.mjs';

const vaultBinding=(accountId,recipientId,vault)=>b64(encode({accountId,recipientId,publicKey:vault.publicKey,signPublicKey:vault.signPublicKey,privateEnvelope:vault.privateEnvelope}));
// Reuse only the non-extractable keys already unlocked by this login's
// preparation. The carrier is memory-only and consumed exactly once. Trust,
// directory, grants and both live session checks still run in unlockSession.
export function rememberPreparedVault(authentication,info,privateKeys) {
  authentication.diaryPreparedKeys={binding:vaultBinding(info.accountId,info.recipientId,info.vault),credentialId:info.webAuthnCredentialId,privateKeys};
}
export function takePreparedVault(authentication,profile) {
  const saved=authentication?.diaryPreparedKeys;
  if(authentication)authentication.diaryPreparedKeys=null;
  if(saved&&saved.credentialId===authentication.credentialId&&saved.credentialId===profile.webAuthnCredentialId&&saved.binding===vaultBinding(profile.actor.accountId,profile.actor.credentialId,profile.vault)&&validDeviceKeys(saved.privateKeys))return saved.privateKeys;
}
// Callers supply an externally pinned trust anchor and last known generation.
// PRF material is consumed and erased, including on validation failures.
export async function unlockSession({
  prf,
  profile,
  anchor,
  minimumGeneration,
  checkSession,
  cachedPrivateKeys,
}) {
  try {
    if(cachedPrivateKeys&&!validDeviceKeys(cachedPrivateKeys))throw new Error('InvalidDeviceKey');
    if (!(await checkSession())) throw new Error("SessionExpired");
    const directory = await verifyDirectory(
      profile.directory,
      anchor,
      minimumGeneration,
    );
    if (b64(encode(profile.epochs)) !== b64(encode(directory.epochs)))
      throw new Error("InvalidEpochRegistry");
    const member = directory.members.find(
      (m) =>
        m.accountId === profile.actor.accountId &&
        m.credentialId === profile.actor.credentialId,
    );
    if (!member || !member.households.includes(profile.household))
      throw new Error("GrantDenied");
    const privateKeys = cachedPrivateKeys || await unlockVault(
      prf,
      profile.actor.credentialId,
      profile.vault,
    );
    await verifySigned(
      await signed({ credentialId: member.credentialId }, privateKeys.sign),
      member.signPublicKey,
    );
    const keys = new Map(),recordKeys=new Map();
    for (const grant of profile.grants) {
      const value = grant.value;
      if (keys.has(value.scope)) throw new Error("DuplicateGrant");
      keys.set(
        value.scope,
        await unwrapGrant(grant, {
          directory,
          anchor,
          accountId: member.accountId,
          credentialId: member.credentialId,
          household: value.household,
          scope: value.scope,
          epoch: profile.epochs[value.scope],
          privateKey: privateKeys.rsa,
        }),
      );
    }
    if((profile.recordGrants||[]).length>5000)throw new Error("GrantLimit");
    for(const packet of profile.recordGrants||[]){const value=packet.value;if(value.kind!=="record"||!Number.isSafeInteger(value.revision)||value.revision<1||!value.id)throw new Error("InvalidRecordGrant");const id=`${value.id}:${value.revision}`;if(recordKeys.has(id))throw new Error("DuplicateGrant");recordKeys.set(id,await unwrapGrant(packet,{directory,anchor,accountId:member.accountId,credentialId:member.credentialId,household:value.household,scope:value.scope,epoch:profile.epochs[value.scope],privateKey:privateKeys.rsa}));}
    if (member.scopes.some((scope) => !keys.has(scope)))
      throw new Error("IncompleteGrants");
    if (!(await checkSession())) throw new Error("SessionExpired");
    return {directory,keys,privateKeys,recordKeys};
  } finally {
    prf?.fill(0);
  }
}
