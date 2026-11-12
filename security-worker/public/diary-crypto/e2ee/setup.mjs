import { b64,encode,newKey,signingKey,signed,fingerprint,makeGrant,openRecipientKey,verifyDirectory,validatePublicKey } from './crypto.mjs';
import { bindingOf,verifyRecord } from './record.mjs';
import { canRead,publishedScope,draftScope,preferencesScope,trashScope } from './policy.mjs';
import { createRecoveryEnvelope,openRecoveryEnvelope } from './recovery.mjs';

function scopeDefinitions(households,members) {
  const rows=new Map();
  const add=row=>rows.set(row.scope,row);
  for(const [household,config] of Object.entries(households)) {
    add({household,state:'published',scope:publishedScope(household),author:'',retainedFor:[]});
    add({household,state:'draft',scope:draftScope(household),author:'',retainedFor:[]});
    const accounts=[...new Set(members.filter(m=>m.households.includes(household)).map(m=>m.accountId))];
    for(const account of accounts) {
      add({household,state:'preferences',scope:preferencesScope(household,account),author:account,retainedFor:[]});
      if(!config.independent)for(const retainedFor of [[account],[...new Set([config.owner,account])].sort()])add({household,state:'trash',scope:trashScope(household,retainedFor),author:'',retainedFor});
    }
    add({household,state:'trash',scope:trashScope(household,[config.owner]),author:'',retainedFor:[config.owner]});
  }
  return [...rows.values()];
}

// Prove the API's recovery public key matches the locally unlocked EXISTING
// T-Cloud private key before releasing any diary key material to that recipient.
async function proveRecoveryKey(publicKey,privateKey) {
  validatePublicKey(publicKey,'recovery');
  const challenge=crypto.getRandomValues(new Uint8Array(32));let plain;
  try {
    const recipient=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP'},recipient,challenge);
    plain=new Uint8Array(await crypto.subtle.decrypt({name:'RSA-OAEP'},privateKey,wrapped));
    if(b64(plain)!==b64(challenge))throw new Error('RecoveryKeyMismatch');
  }finally{challenge.fill(0);plain?.fill(0);}
}

// Returns only public certificates and ciphertext. All authority/scope/record
// keys stay within this trusted-device operation. An existing anchor is pinned
// separately; never bootstrap trust from an existing API configuration.
export async function prepareKeyConfiguration({status,recoveryPrivateKey,trustedAnchor,recoveryRecords=[]}) {
  await proveRecoveryKey(status.recoveryPublicKey,recoveryPrivateKey);
  let authority,anchor,scopeKeys,previous;
  if(status.config) {
    if(!trustedAnchor)throw new Error('TrustedAnchorRequired');
    previous=await verifyDirectory(status.config.directory,trustedAnchor,status.config.generation);
    if(previous.members.some(old=>!status.members.some(m=>m.credentialId===old.credentialId&&m.canManageEntries===old.canManageEntries&&b64(encode(m.households))===b64(encode(old.households)))))throw new Error("RekeyRequired");
    const restored=await openRecoveryEnvelope({packet:status.config.recoveryEnvelope,recoveryPrivateKey,anchor:trustedAnchor,minimumGeneration:previous.generation});
    authority=restored.authority;scopeKeys=restored.scopeKeys;anchor=trustedAnchor;
  }else {
    const pair=await signingKey();authority=pair.privateKey;anchor=await crypto.subtle.exportKey('jwk',pair.publicKey);scopeKeys=new Map();
  }
  try {
    const candidates=new Map((previous?.members||[]).map(m=>[m.credentialId,m]));
    for(const member of status.members)candidates.set(member.credentialId,member);
    const definitions=scopeDefinitions(status.households,[...candidates.values()]);
    if(previous&&(b64(encode(previous.households))!==b64(encode(status.households))||previous.members.some(old=>{
      const live=status.members.find(m=>m.credentialId===old.credentialId);
      return old.scopes.some(scope=>{const row=definitions.find(d=>d.scope===scope);return !row||!canRead({...live,active:true},row);});
    })))throw new Error('RekeyRequired');
    const epochs={...previous?.epochs};
    for(const row of definitions){epochs[row.scope]??=1;if(!scopeKeys.has(row.scope))scopeKeys.set(row.scope,await newKey());}
    const members=[];
    for(const candidate of candidates.values()) {
      const claims={...candidate,active:true};
      members.push({identityId:candidate.identityId,serviceLinkId:candidate.serviceLinkId,webAuthnCredentialId:candidate.webAuthnCredentialId,accountId:candidate.accountId,credentialId:candidate.credentialId,publicKey:candidate.publicKey,signPublicKey:candidate.signPublicKey,fingerprint:await fingerprint(candidate.publicKey),households:candidate.households,canManageEntries:candidate.canManageEntries,scopes:definitions.filter(row=>canRead(claims,row)).map(row=>row.scope)});
    }
    const generation=(previous?.generation||0)+1;
    const directoryValue={protocol:'T-lain diary directory',version:1,generation,households:status.households,epochs,members,recoveryPublicKey:status.recoveryPublicKey,recoveryFingerprint:await fingerprint(status.recoveryPublicKey)};
    const directory=await signed(directoryValue,authority),grants={},recordGrants={};
    for(const member of members){grants[member.credentialId]=[];recordGrants[member.credentialId]=[];for(const scope of member.scopes){const row=definitions.find(d=>d.scope===scope);grants[member.credentialId].push(await makeGrant(scopeKeys.get(scope),{household:row.household,scope,epoch:epochs[scope]},member,generation,authority));}}
    for(const row of recoveryRecords) {
      if(!previous)throw new Error('UnexpectedRecoveryRecord');
      await verifyRecord(row,previous);
      const key=await openRecipientKey(row.keyBox,{...bindingOf(row),kind:'record-key'},'__recovery__',recoveryPrivateKey,{extractable:true});
      for(const member of members.filter(m=>m.scopes.includes(row.scope)&&!row.keyBox[m.credentialId]))recordGrants[member.credentialId].push(await makeGrant(key,{household:row.household,scope:row.scope,epoch:row.epoch,id:row.id,revision:row.revision,kind:'record'},member,generation,authority));
    }
    const recoveryEnvelope=await createRecoveryEnvelope({scopeKeys,authority,directory,anchor,recoveryPublicKey:status.recoveryPublicKey,expectedRecoveryFingerprint:directoryValue.recoveryFingerprint});
    return {expectedGeneration:previous?.generation||0,anchor,directory,recoveryEnvelope,grants,recordGrants};
  }finally{scopeKeys.clear();authority=null;}
}

export async function publicTrustPackage(configuration) {
  return {protocol:'T-lain diary public trust',version:1,anchor:configuration.anchor,fingerprint:await fingerprint(configuration.anchor),minimumGeneration:configuration.directory.value.generation};
}
