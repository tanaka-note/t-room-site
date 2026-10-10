import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { createClientVault, wrapMaster, unwrapMaster, unlockClient } from '../../health-worker/public/health-crypto.mjs';

test('Health setup uses the authenticated account for linking, initialization, recovery and delegation',async()=>{
  const accountId='fixture-account',prf=randomBytes(32),calls=[];
  const admin=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const publicKey=await crypto.subtle.exportKey('jwk',admin.publicKey),vault=await createClientVault(prf);
  const nodes=new Map(['prepare','owner-link','manage','members','status'].map(id=>[id,{textContent:'',children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}}]));
  let config=null,wrappedGrant,master;
  const fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url==='/security/api/services')return Response.json({services:[{id:'health',targets:[{accountId}]}]});
    if(url==='/security/api/identities/primary-admin/links')return Response.json({ok:true});
    if(url==='/security/api/health/own')return Response.json({accountId,prepared:true,ready:true});
    if(url==='/security/api/health/admin')return Response.json({accountId,config,recoveryPublicKey:publicKey,adminEnvelope:{},members:[{credentialId:'fixture-credential',serviceLinkId:'fixture-link',displayName:'fixture person',publicKey:vault.publicKey,granted:false}]});
    if(url==='/security/api/health/initialize'){config={recoveryWrappedKey:body.recoveryWrappedKey};return Response.json({ok:true});}
    if(url==='/security/api/health/grant'){wrappedGrant=body.wrappedKey;return Response.json({ok:true});}
    throw Error('unexpected endpoint');
  };
  const document={getElementById:id=>nodes.get(id),querySelectorAll:()=>['prepare','owner-link','manage'].map(id=>nodes.get(id)),createElement:()=>({children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}}),createTextNode:text=>({text})};
  runInNewContext(readFileSync(new URL('../public/health-setup.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/,''),{
    document,fetch,crypto,Uint8Array,createClientVault,wrapMaster,unwrapMaster,
    TRoomPasskeys:{authenticate:async()=>({prfOutput:new Uint8Array(prf)})},
    TRoomCrypto:{unlockAdminPrivateKeyWithPasskey:async()=>admin.privateKey},
  });
  try {
    await nodes.get('owner-link').onclick();
    assert.equal(calls.find(call=>call.url.endsWith('/links')).body.links[0].accountId,accountId);
    await nodes.get('manage').onclick();
    assert.ok(config);master=await unwrapMaster(admin.privateKey,config.recoveryWrappedKey,accountId);
    const grantButton=nodes.get('members').children[0].children[1];
    await grantButton.onclick();
    const delegated=await unwrapMaster(await unlockClient(prf,vault),wrappedGrant,accountId);
    assert.deepEqual(delegated,master);delegated.fill(0);
    await nodes.get('manage').onclick(); // Existing recovery branch, no reinitialization.
    assert.equal(calls.filter(call=>call.url.endsWith('/initialize')).length,1);
    assert.match(nodes.get('status').textContent,/鍵の状態/);
  } finally {master?.fill(0);prf.fill(0);}
});
