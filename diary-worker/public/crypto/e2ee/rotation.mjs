import { b64,encode,newKey,open,seal,signed,fingerprint,makeGrant,openRecipientKey,verifyDirectory } from './crypto.mjs';
import { bindingOf,proofOf,verifyRecord } from './record.mjs';
import { canRead,preferencesScope } from './policy.mjs';
import { scopeDefinitions,assertKnownRecipientKeys } from './setup.mjs';
import { createRecoveryEnvelope,openRecoveryEnvelope,newDiaryDelegationKey,sealDiaryDelegation } from './recovery.mjs';

export const rotationDigest = async value => b64(await crypto.subtle.digest('SHA-256',encode(value)));
const equal = (a,b) => b64(encode(a)) === b64(encode(b));
export const rotationInventoryDigest = async items => rotationDigest([...items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
export const mediaBinding = row => ({household:row.household,scope:preferencesScope(row.household,row.account_id),id:row.id,revision:1,epoch:row.epoch,kind:'photo-staging',sourceId:row.session_id});

// Trusted-device operation only. The returned plan contains ciphertext and
// public certificates. It never contains the unlocked recovery/authority keys.
// The caller must freeze writes and supply the COMPLETE fixed inventory first.
export async function prepareRotation({status,recoveryPrivateKey,trustedAnchor,records,media=[]}) {
  if (!status.config || !trustedAnchor || records.length>5000 || new Set(records.map(r=>r.id)).size!==records.length || new Set(media.map(r=>r.id)).size!==media.length)
    throw new Error('InvalidRotationInventory');
  const previous=await verifyDirectory(status.config.directory,trustedAnchor,status.config.generation);
  assertKnownRecipientKeys(previous,status.members);
  if (!equal(previous.households,status.households) || await fingerprint(status.recoveryPublicKey)!==previous.recoveryFingerprint)
    throw new Error('RotationHouseholdOrRecoveryChangeUnsupported');
  const kit=await openRecoveryEnvelope({packet:status.config.recoveryEnvelope,recoveryPrivateKey,anchor:trustedAnchor,minimumGeneration:previous.generation});
  const scopeKeys=new Map();
  try {
    const definitions=new Map(scopeDefinitions(status.households,status.members).map(row=>[row.scope,row]));
    // Retain scopes needed by existing personal preferences and narrowed trash,
    // including scopes that now have only the central recovery recipient.
    for (const row of records) {
      await verifyRecord(row,previous);
      definitions.set(row.scope,row);
    }
    for (const row of media) {
      const binding=mediaBinding(row);
      definitions.set(binding.scope,{household:row.household,scope:binding.scope,state:'preferences',author:row.account_id,retainedFor:[]});
    }
    const epochs={};
    for (const scope of definitions.keys()) {
      epochs[scope]=(previous.epochs[scope]||0)+1;
      scopeKeys.set(scope,await newKey());
    }
    const generation=previous.generation+1,members=[];
    for (const candidate of status.members.filter(m=>m.active!==false)) {
      const {identityId,serviceLinkId,webAuthnCredentialId,accountId,credentialId,publicKey,signPublicKey,households,canManageEntries}=candidate;
      members.push({identityId,serviceLinkId,webAuthnCredentialId,accountId,credentialId,publicKey,signPublicKey,households,canManageEntries,
        fingerprint:await fingerprint(publicKey),scopes:[...definitions.values()].filter(row=>canRead({...candidate,active:true},row)).map(row=>row.scope)});
    }
    const value={protocol:'T-lain diary directory',version:1,generation,households:status.households,epochs,members,
      recoveryPublicKey:status.recoveryPublicKey,recoveryFingerprint:previous.recoveryFingerprint,recoveryAuthority:trustedAnchor};
    const delegation=previous.delegationPublicKey?await newDiaryDelegationKey():null;
    if(delegation)value.delegationPublicKey=delegation.publicKey;
    const directory=await signed(value,kit.authority),grants={},recordGrants={};
    for (const member of members) {
      grants[member.credentialId]=[];recordGrants[member.credentialId]=[];
      for (const scope of member.scopes) grants[member.credentialId].push(await makeGrant(scopeKeys.get(scope),
        {household:definitions.get(scope).household,scope,epoch:epochs[scope]},member,generation,kit.authority));
    }
    const rotated=[];
    for (const old of records) {
      const oldBinding=bindingOf(old),oldKey=Object.keys(old.keyBox).length
        ? await openRecipientKey(old.keyBox,{...oldBinding,kind:'record-key'},'__recovery__',recoveryPrivateKey)
        : kit.scopeKeys.get(old.scope);
      if (!oldKey) throw new Error('IncompleteRecoveryKit');
      const document=await open(oldKey,old.envelope,{...oldBinding,kind:'document'});
      const summary=await open(oldKey,old.summary,{...oldBinding,kind:'summary'});
      const row={...old,revision:old.revision+1,epoch:epochs[old.scope],keyBox:{},attestation:{writer:'__recovery__'}};
      const binding=bindingOf(row),key=scopeKeys.get(row.scope);
      row.envelope=await seal(key,document,{...binding,kind:'document'},{format:old.envelope.version});
      row.summary=await seal(key,summary,{...binding,kind:'summary'});
      // Check both decryptions before issuing a recovery-only attestation. No
      // plaintext hash is published: it could reveal low-entropy private values.
      if (!equal(document,await open(key,row.envelope,{...binding,kind:'document'})) ||
          !equal(summary,await open(key,row.summary,{...binding,kind:'summary'}))) throw new Error('RotationContentMismatch');
      row.attestation.recovery={operation:'rekey',previousDigest:await rotationDigest(old),previousGeneration:previous.generation,directoryGeneration:generation};
      row.attestation.signature=(await signed(proofOf(row),kit.authority)).signature;
      await verifyRecord(row,value);
      rotated.push(row);
    }
    const rotatedMedia=[];
    for (const old of media) {
      const binding=mediaBinding(old),key=kit.scopeKeys.get(binding.scope);
      if (!key) throw new Error('IncompleteRecoveryKit');
      const plain=await open(key,JSON.parse(old.metadata),binding);
      const row={...old,epoch:epochs[binding.scope]};
      row.metadata=JSON.stringify(await seal(scopeKeys.get(binding.scope),plain,mediaBinding(row)));
      if (!equal(plain,await open(scopeKeys.get(binding.scope),JSON.parse(row.metadata),mediaBinding(row)))) throw new Error('RotationContentMismatch');
      rotatedMedia.push(row);
    }
    const recoveryEnvelope=await createRecoveryEnvelope({scopeKeys,authority:kit.authority,directory,anchor:trustedAnchor,
      recoveryPublicKey:status.recoveryPublicKey,expectedRecoveryFingerprint:previous.recoveryFingerprint});
    const configuration={expectedGeneration:previous.generation,anchor:trustedAnchor,directory,recoveryEnvelope,grants,recordGrants};
    if(delegation)configuration.delegation=await sealDiaryDelegation({directory:value,authority:kit.authority,scopeKeys,
      legacy:new Map(),delegation,members:status.members.filter(member=>member.active!==false&&member.isGlobalOwner&&member.identityId==='primary-admin')});
    const manifest=await signed({protocol:'T-lain diary rotation',version:1,sourceGeneration:previous.generation,
      targetGeneration:generation,directoryDigest:await rotationDigest(directory),configurationDigest:await rotationDigest(configuration),
      records:{count:rotated.length,digest:await rotationInventoryDigest(await Promise.all(rotated.map(async row=>({id:row.id,digest:await rotationDigest(row),previousDigest:row.attestation.recovery.previousDigest}))))},
      media:{count:rotatedMedia.length,digest:await rotationInventoryDigest(await Promise.all(rotatedMedia.map(async (row,i)=>({id:row.id,digest:await rotationDigest(row),previousDigest:await rotationDigest(media[i])}))))}},kit.authority);
    return {configuration,manifest,records:rotated,media:rotatedMedia};
  } finally {kit.scopeKeys.clear();scopeKeys.clear();kit.authority=null;}
}
