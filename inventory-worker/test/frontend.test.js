import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/inventory.js', import.meta.url), 'utf8');
const unavailable = '一時的に接続できません。時間を置いて再試行してください。';
function frontend(fetch) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', dataset: {}, hidden: false, open: false, disabled: false, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      replaceChildren() { this.textContent = ''; }, append() {}, close() { this.open = false; }, reset() { this.resets = (this.resets || 0) + 1; }, focus() {} });
    return nodes.get(id);
  };
  const location = { href: 'https://example.test/inventory/?item=old-item&year=2025' };
  const history = { state: { inventory: { itemId: 'old-item' }, inventoryDialog: 'old-token' }, replaceState(state, _, url) { this.state = state; location.href = String(url); } };
  const window = { addEventListener() {} };
  const document = { getElementById: node, createElement: tag => ({ tagName: tag, textContent: '' }), hidden: false, body: { dataset: {} }, addEventListener() {}, dispatchEvent() {} };
  // Inspect lexical state only in this synthetic VM; production has no debug hooks.
  const hooks = `window.fixture = { api, loginView, loadItems, localTimestamp,
    itemNames() { return items.map(item => item.name); },
    seed() { items = [{name:'private item'}]; detail = editedItem = {name:'private item'}; cursor = 'private cursor'; retry = {fingerprint:'private input'};
      listAnchors = [{id:'private id'}]; detailPositions.set('private id',123); listScroll=123; listYear=2025;
      openToken='private token'; mode='adjust'; dirty=busy=approvedClose=true; opener=$('items'); backgroundPointer=7;
      for (const id of ['name','unit','quantity','occurred-at','search','quantity-label','form-message','item-name','items']) { $(id).value='private input'; $(id).textContent='private data'; }
      $('login').setAttribute('aria-busy', 'true'); $('passkey-login-label').textContent='確認中…';
      $('editor').open=true; $('record-form').dataset.troomDirty='true'; },
    state() { return {items:items.length,detail,cursor,editedItem,retry,listAnchors:listAnchors.length,positions:detailPositions.size,listScroll,listYear,
      mode,openToken,dirty,busy,approvedClose,opener,backgroundPointer,pending:pendingRequests.size,sessionGeneration}; }
  };`;
  runInNewContext(source.replace(/\}\)\(\);\s*$/, `${hooks}\n})();`), { window, document, history, location, URL, AbortController, Event, fetch });
  return { ...window.fixture, node, history, location, document };
}
function assertCleared(f) {
  const s=f.state();
  for (const key of ['detail','cursor','editedItem','retry','opener','backgroundPointer']) assert.equal(s[key],null,key);
  for (const key of ['items','listAnchors','positions','listScroll','pending']) assert.equal(s[key],0,key);
  for (const key of ['mode','openToken']) assert.equal(s[key],'',key);
  for (const key of ['dirty','busy','approvedClose']) assert.equal(s[key],false,key);
  for (const id of ['name','unit','quantity','occurred-at','search']) assert.equal(f.node(id).value,'',id);
  for (const id of ['form-message','item-name','items','editor-title']) assert.equal(f.node(id).textContent,'',id);
  assert.equal(f.node('login').attributes['aria-busy'],undefined);
  assert.equal(f.node('passkey-login-label').textContent,'パスキーでログイン');
  assert.equal(f.node('record-form').resets,1);
  assert.equal(f.node('record-form').dataset.troomDirty,'false');
  assert.equal(f.document.body.dataset.troomUpdateBlock,'false');
  assert.equal(f.node('editor').open,false); assert.equal(f.node('fields').disabled,false);
  assert.equal(f.node('quantity-label').textContent,'数量');
  assert.equal(new URL(f.location.href).searchParams.has('item'),false);
  assert.equal(f.history.state.inventoryDialog,undefined); assert.equal(f.history.state.inventory,undefined);
}

test('logout reset removes sensitive form, view, navigation and operation state', () => {
  const f=frontend(); f.seed(); f.loginView(); assertCleared(f);
});

test('API errors retain known Worker guidance and never reveal untrusted bodies or parser/network exceptions', async t => {
  const cases=[
    [400,'application/json',JSON.stringify({error:'数量は範囲内の整数で入力してください。',code:'request_failed'}),'数量は範囲内の整数で入力してください。'],
    [401,'application/json',JSON.stringify({error:'パスキーでログインしてください。',code:'request_failed'}),'パスキーでログインしてください。'],
    [409,'application/json; charset=utf-8',JSON.stringify({error:'同じ操作IDで異なる内容を送信できません。',code:'replay_conflict'}),'同じ操作IDで異なる内容を送信できません。'],
    [429,'text/html','<html>private request data</html>','アクセスが集中しています。少し時間を置いて再試行してください。'],
    [503,'text/html','<html>private request data</html>',unavailable],
    [502,'text/plain','private exception detail',unavailable],
    [503,'application/json','',unavailable],
    [200,'application/json','',unavailable],
    [204,null,null,unavailable],
    [200,'text/html','<html>private request data</html>',unavailable],
    [400,'application/json',JSON.stringify({error:'private exception detail',code:'request_failed'}),unavailable],
    [503,'application/json',JSON.stringify({error:'private database input',code:'unavailable'}),unavailable],
    [502,'application/json','<html>private exception detail</html>',unavailable],
    [401,'text/html','private expired request',unavailable]
  ];
  for (const [status,type,body,expected] of cases) await t.test(`${status} ${type || 'empty'}`,async()=>{
    const f=frontend(async()=>new Response(body,{status,headers:type?{'Content-Type':type}:{}}));
    if(status===401)f.seed();
    await assert.rejects(f.api('/items'),e=>e.message===expected && e.status===status);
    if(status===401)assertCleared(f);
  });
  const f=frontend(async()=>{throw new Error('private network exception');});
  await assert.rejects(f.api('/items'),e=>e.message===unavailable);
});

test('responses started before session invalidation cannot repopulate memory or DOM', async () => {
  let resolve;
  const f=frontend(()=>new Promise(done=>{resolve=done;})); f.seed();
  const request=f.loadItems(); f.loginView();
  resolve(Response.json({items:[{name:'private item'}]}));
  await assert.rejects(request,e=>e.discarded===true); assertCleared(f);
});

test('a delayed pre-deletion list cannot overwrite the newer list without the deleted item', async () => {
  const resolves=[];
  const f=frontend(()=>new Promise(resolve=>resolves.push(resolve)));
  const beforeDeletion=f.loadItems(), afterDeletion=f.loadItems();
  resolves[1](Response.json({items:[]})); await afterDeletion;
  resolves[0](Response.json({items:[{id:'deleted-item',name:'Deleted fixture'}]})); await beforeDeletion;
  assert.equal(f.itemNames().length,0);
});

test('JSON success and structured JSON media types remain supported', async () => {
  const f=frontend(async()=>new Response('{"ok":true}',{headers:{'Content-Type':'application/problem+json; charset=UTF-8'}}));
  assert.equal((await f.api('/session')).ok,true);
});

test('minute-only datetime-local values preserve zero seconds and JST without relaxing API validation', () => {
  const f=frontend();
  assert.equal(f.localTimestamp('2026-02-01T09:15'),'2026-02-01T09:15:00+09:00');
  assert.equal(f.localTimestamp('2026-02-01T09:15:30'),'2026-02-01T09:15:30+09:00');
});

test('all current fixed Worker HttpError messages survive the client error boundary', async () => {
  const runtime = ['../src/index.js','../src/domain.js','../../assets/session-secret.mjs'].map(path=>readFileSync(new URL(path,import.meta.url),'utf8')).join('\n');
  const messages = [...runtime.matchAll(/new HttpError\([^,]+,\s*(['"])(.*?)\1/g)].map(match=>match[2]);
  assert(messages.length>25);
  for (const error of messages) {
    const f=frontend(async()=>Response.json({error,code:'request_failed'},{status:400}));
    await assert.rejects(f.api('/items'),value=>value.message===error);
  }
});
