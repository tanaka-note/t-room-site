import {unb64} from './crypto.mjs';

// Read the EXISTING T-Cloud admin envelope. Keep its exact HKDF/AAD format;
// this neither changes the T-Cloud key nor creates a second recovery password.
export async function unlockCentralRecovery(prf,envelope) {
  if(!(prf instanceof Uint8Array)||prf.length!==32||!envelope)throw new Error('CentralRecoveryUnavailable');
  const encoder=new TextEncoder(),context='T-ROOM Cloud Storage passkey admin private key v1';
  const material=await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveKey']);
  const salt=await crypto.subtle.digest('SHA-256',encoder.encode(context+'|salt'));
  const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:encoder.encode(context)},material,{name:'AES-GCM',length:256},false,['decrypt']);
  const raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(envelope.payloadIv),additionalData:encoder.encode(context)},key,unb64(envelope.encryptedPayload)));
  try{return await crypto.subtle.importKey('pkcs8',raw,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);}
  finally{raw.fill(0);}
}
