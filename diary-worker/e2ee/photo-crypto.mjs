import {b64,unb64,encode} from './crypto.mjs';

// Keys and MIME types live only inside encrypted diary/staging metadata.
export const PHOTO_PREFIX='diary/encrypted-photos/v1/';
const MAGIC=new Uint8Array([84,68,80,72,1]);
export const PHOTO_OVERHEAD=MAGIC.length+12+16;
export const photoHeader=bytes=>bytes.length>=PHOTO_OVERHEAD&&MAGIC.every((byte,i)=>bytes[i]===byte);
const aad=(household,id,kind)=>encode({protocol:'T-lain diary photo',version:1,household,id,kind});
export async function encryptPhotoParts(parts,household,id) {
  const raw=crypto.getRandomValues(new Uint8Array(32));
  const descriptor={version:1,key:b64(raw),types:{}};
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);raw.fill(0);
  const encrypted={};
  // Keep peak memory to one original, rather than encrypting all parts together.
  for(const kind of ['original','display','thumbnail']) {
    const part=parts[kind];if(!(part instanceof Blob))throw new Error('InvalidPhotoPart');
    const iv=crypto.getRandomValues(new Uint8Array(12)),bytes=new Uint8Array(await part.arrayBuffer());
    try {
      const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(household,id,kind)},key,bytes);
      encrypted[kind]=new Blob([MAGIC,iv,ciphertext],{type:'application/octet-stream'});
      descriptor.types[kind]=part.type;
    } finally {bytes.fill(0);}
  }
  return {descriptor,parts:encrypted};
}
export async function decryptPhotoPart(bytes,descriptor,household,id,kind) {
  if(descriptor?.version!==1||!['original','display','thumbnail'].includes(kind)||!photoHeader(new Uint8Array(bytes)))throw new Error('InvalidPhotoCiphertext');
  const raw=unb64(descriptor.key,43);if(raw.length!==32)throw new Error('InvalidPhotoKey');
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);raw.fill(0);
  const value=new Uint8Array(bytes);
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:value.subarray(5,17),additionalData:aad(household,id,kind)},key,value.subarray(17));
  return new Blob([plaintext],{type:descriptor.types[kind]||'application/octet-stream'});
}
