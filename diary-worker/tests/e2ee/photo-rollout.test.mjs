import assert from 'node:assert/strict';
import {test} from 'node:test';
import {systemFixture} from './system-fixture.mjs';

const id='11111111-1111-4111-8111-111111111111';
test('key preparation keeps existing and newly uploaded legacy photos readable on both origins until encrypted cutover',async()=>{
  const f=await systemFixture({phase:'legacy'}),bytes=new TextEncoder().encode('synthetic-photo-bytes');let reads=0;
  try {
    f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,revision) VALUES(900,'2026-11-16','Synthetic photo','Synthetic entry','main-admin','Synthetic owner','tanaka-household','published',1)");
    f.db.sqlite.prepare("INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name,created_at) VALUES(?,900,'synthetic.jpg','image/jpeg',21,'original','display','thumbnail','main-admin','Synthetic owner','2026-11-16')").run(id);
    for(const key of ['original','display','thumbnail'])f.r2.set(key,{bytes,metadata:{httpMetadata:{contentType:'image/jpeg'}}});
    f.env.MEDIA.get=async key=>{reads++;const object=f.r2.get(key);return object?{body:new Blob([object.bytes]).stream(),httpEtag:'"synthetic-photo"',writeHttpMetadata:headers=>headers.set('Content-Type',object.metadata?.httpMetadata?.contentType||'image/jpeg')}:null;};
    const request=async(origin,path,{account='main-admin',method='GET',body}={})=>f.worker.fetch(new Request(origin+'/diary/api'+path,{method,headers:{Cookie:f.cookie(account),...(method==='GET'?{}:{Origin:origin,'X-Diary-Request':'1',...(body instanceof FormData?{}:{'Content-Type':'application/json'})})},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})}),f.env,f.ctx);
    for(const origin of ['https://tanaka-note.com',f.env.DIARY_ENCRYPTION_ORIGIN]) {
      const unauthenticated=await f.worker.fetch(new Request(origin+`/diary/api/photos/${id}/thumbnail`),f.env,f.ctx);
      assert.equal(unauthenticated.status,401);
      for(const variant of ['original','display','thumbnail']) {
        const response=await request(origin,`/photos/${id}/${variant}`);
        assert.equal(response.status,200,origin+' '+variant);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
      }
      assert.equal((await request(origin,`/photos/${id}/thumbnail`,{account:'chiharu-admin'})).status,404);
    }
    // New staging uploads retain the same bytes when promoted into a diary.
    const origin=f.env.DIARY_ENCRYPTION_ORIGIN;
    const created=await request(origin,'/photo-upload-sessions',{method:'POST',body:{targetEntryId:900}});assert.equal(created.status,200);
    const session=(await created.json()).uploadSession.id,newId=crypto.randomUUID(),form=new FormData();
    form.set('id',newId);form.set('width','1');form.set('height','1');
    for(const name of ['original','display','thumbnail'])form.set(name,new File([bytes],name+'.jpg',{type:'image/jpeg'}));
    const upload=await request(origin,`/photo-upload-sessions/${session}/photos`,{method:'POST',body:form});assert.equal(upload.status,200);
    const staged=(await upload.json()).photo;
    assert.equal(staged.id,newId);
    assert.equal((await request(origin,`/photo-upload-sessions/${session}/photos/${newId}`)).status,200);
    const commit=await request(origin,`/photo-upload-sessions/${session}/commit`,{method:'POST',body:{entryId:900,photoIds:[newId]}});assert.equal(commit.status,200);
    const keys=[...f.r2.keys()].sort();
    const fresh=await request(origin,`/photos/${newId}/thumbnail`);assert.equal(fresh.status,200);assert.deepEqual(new Uint8Array(await fresh.arrayBuffer()),bytes);
    assert.deepEqual([...f.r2.keys()].sort(),keys,'display must never rewrite or delete photo objects');
    // While migration is frozen the old reader is still active, until cutover.
    f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='migrating'");
    assert.equal((await request(origin,`/photos/${id}/thumbnail`)).status,200);
    // Once encrypted, never fall through to old tables or another origin.
    f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='encrypted',ever_encrypted=1,generation=1");
    reads=0;
    assert.equal((await request('https://tanaka-note.com',`/photos/${id}/thumbnail`)).status,403);
    assert.equal((await request(origin,`/photos/${id}/thumbnail`)).status,404);
    assert.equal(reads,0);
  }finally{await f.close();}
});
