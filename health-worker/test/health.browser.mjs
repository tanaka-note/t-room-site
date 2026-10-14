import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startReview } from '../tools/review-server.mjs';
import { recordId, encryptRecord, decryptRecord } from '../public/health-crypto.mjs';
import { today, addDays } from '../public/health-domain.mjs';
const require = createRequire(new URL('../../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const review = await startReview();
const legacyDate = addDays(today(), -70);
const legacyId = await recordId(review.fixture.master, legacyDate, 'nobumi');
const legacyValue = {date:legacyDate, start:false, end:false, symptoms:[0,5],flow:null,note:'旧形式の備考'};
const legacyCipher = await encryptRecord(review.fixture.master, legacyId, legacyValue, 'nobumi');
review.fixture.db.prepare("INSERT INTO health_records(record_id,account_id,iv,ciphertext) VALUES(?,'nobumi',?,?)").run(legacyId,legacyCipher.iv,legacyCipher.ciphertext);
const browser = await chromium.launch({ headless: true });
try {
  const a = await browser.newContext({ viewport: { width: 390, height: 844 } }); const b = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await a.newPage(); const other = await b.newPage(); const failures = []; const writes = [];
  for (const surface of [page, other]) surface.on('pageerror', e => failures.push(e.message));
  page.on('console', message => { if (message.type()==='error' && /Content Security Policy|Refused to execute|Refused to load/.test(message.text())) failures.push(message.text()); });
  page.on('request', r => { if (r.method() === 'PUT') writes.push(r.postData()); });
  await mkdir(new URL('../../tmp/health-review/',import.meta.url),{recursive:true});
  const unauthenticated=await (await page.request.get(review.url)).text();
  assert.doesNotMatch(unauthenticated,/田中|暢美|宏知/);
  await page.goto(review.url);
  assert.equal(await page.locator('#review-person').count(),0);
  assert.equal(await page.locator('#login select, #login input').count(),0);
  assert.equal((await page.locator('main').innerText()).replace(/\s+/g,' ').trim(),'体調管理 パスキーでログイン');
  assert.equal(await page.locator('#login').innerText(),'パスキーでログイン');
  assert.equal(await page.locator('#app').isVisible(),false);
  await page.screenshot({path:new URL('../../tmp/health-review/login.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  // Unsupported PRF stops before any handoff or record request; no plaintext fallback.
  let handoffRequests=0;
  page.on('request',request=>{if(request.url().includes('/health/api/passkey/handoff'))handoffRequests++;});
  await page.evaluate(()=>{globalThis.fixtureAuthenticate=TRoomPasskeys.authenticate;TRoomPasskeys.authenticate=async()=>({handoff:{handoffToken:'unused-fixture'}});});
  await page.locator('#sign-in').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('暗号鍵'));
  assert.equal(handoffRequests,0);assert.equal(await page.locator('#app').isVisible(),false);
  await page.evaluate(()=>{TRoomPasskeys.authenticate=globalThis.fixtureAuthenticate;delete globalThis.fixtureAuthenticate;});
  // Exercise the real issued Cookie and logout handler during incomplete login.
  let logoutRequests=0;
  page.on('request',request=>{
    if(new URL(request.url()).pathname==='/health/api/logout') {
      logoutRequests++;
      assert.ok(/^[A-Za-z0-9_-]{16,128}$/.test(request.headers()['x-health-session']||''));
    }
  });
  const failedLoginMessage='暗号鍵を解除できませんでした';
  for(const phase of ['unlock','unwrap','bundle','load','cleanup-500','cleanup-network','cleanup-timeout']) {
    const beforeLogout=logoutRequests,beforeHandoff=handoffRequests;
    if(phase==='bundle')await page.route('**/health/api/passkey/handoff',async route=>{
      const response=await route.fetch(),value=await response.json();
      await route.fulfill({response,json:{...value,keyBundle:{...value.keyBundle,vault:null}}});
    });
    if(phase==='load')await page.route('**/health/api/records',route=>route.fulfill({status:500,json:{error:'初回記録を読み込めませんでした'}}));
    let blockedLogout;
    if(phase.startsWith('cleanup-'))await page.route('**/health/api/logout',route=>{
      if(phase==='cleanup-timeout'){blockedLogout=route;return;}
      return phase==='cleanup-500'?route.fulfill({status:500,json:{error:'cleanup failed'}}):route.abort('failed');
    });
    if(phase!=='bundle'&&phase!=='load')await page.evaluate(({phase,message})=>{
      const original=crypto.subtle.decrypt.bind(crypto.subtle);
      globalThis.fixtureDecrypt=original;
      crypto.subtle.decrypt=async(...args)=>{
        if(args[0].name===(phase==='unwrap'?'RSA-OAEP':'AES-GCM'))throw new Error(message);
        return original(...args);
      };
    },{phase,message:failedLoginMessage});
    await page.locator('#sign-in').click();
    await page.waitForFunction(()=>!document.getElementById('sign-in').disabled&&document.getElementById('message').textContent.length>0);
    assert.equal(handoffRequests-beforeHandoff,1,phase);assert.equal(logoutRequests-beforeLogout,1,phase);
    const expected=phase==='bundle'?'サーバーの応答を確認できませんでした。再度お試しください。':phase==='load'?'初回記録を読み込めませんでした':failedLoginMessage;
    assert.equal(await page.locator('#message').textContent(),expected,phase);
    assert.equal(await page.locator('#app').isVisible(),false,phase);assert.equal(await page.locator('#records').textContent(),'',phase);
    if(!phase.startsWith('cleanup-')) {
      assert.equal((await a.cookies()).some(cookie=>cookie.name==='troom_health_session'),false,phase);
      assert.equal(review.fixture.auditEvents.at(-1).eventType,'logout',phase);
    }
    if(blockedLogout)await blockedLogout.abort().catch(()=>{});
    await page.unroute('**/health/api/passkey/handoff');await page.unroute('**/health/api/records');await page.unroute('**/health/api/logout');
    await page.evaluate(()=>{if(globalThis.fixtureDecrypt){crypto.subtle.decrypt=globalThis.fixtureDecrypt;delete globalThis.fixtureDecrypt;}});
    await a.clearCookies();
  }
  const beforeSuccessfulLogin=logoutRequests;
  await page.getByRole('button', { name: 'パスキーでログイン', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(logoutRequests,beforeSuccessfulLogin,'successful login must not discard the new session');
  assert.equal(await page.locator('#insight-cycles').isVisible(),false);
  assert.equal(review.fixture.db.prepare('SELECT ciphertext FROM health_records WHERE record_id=?').get(legacyId).ciphertext,legacyCipher.ciphertext);
  await page.locator('#record-today').click();
  const good = page.locator('#conditions button[data-condition="good"]');
  await good.focus(); await page.keyboard.press('Space'); assert.equal(await good.getAttribute('aria-pressed'),'true');
  assert.ok(await good.evaluate(node => getComputedStyle(node).outlineStyle !== 'none'));
  await good.click(); assert.equal(await good.getAttribute('aria-pressed'),'false');
  await good.click();
  assert.ok(await good.evaluate(node=>node.getBoundingClientRect().height >= 44));
  assert.equal(await page.locator('#period-details').evaluate(element=>element.open), false);
  await page.locator('#note').fill('頭痛についての自由メモ'); await page.getByLabel('頭痛', { exact: true }).check();

  // Structurally invalid 200 JSON cannot close the editor or advance local revisions.
  for (const value of [{}, {ok:true}, {ok:true,revision:'1'}, {ok:true,revision:1.5}, {ok:true,revision:0}, {ok:true,revision:-1}, {ok:true,revision:Number.MAX_SAFE_INTEGER+1}]) {
    await page.route('**/health/api/records/*',route=>route.request().method()==='PUT' ? route.fulfill({status:200,json:value}) : route.continue());
    await page.locator('#save').click(); await page.waitForFunction(()=>document.getElementById('editor-error').textContent.length>0);
    assert.equal(await page.locator('#editor').isVisible(),true);
    assert.equal(await page.locator('#note').inputValue(),'頭痛についての自由メモ');
    assert.equal(await page.locator('#app').isVisible(),true);
    assert.equal(review.fixture.db.prepare('SELECT COUNT(*) AS n FROM health_records').get().n,1);
    await page.unroute('**/health/api/records/*');
  }
  for(const [body,contentType] of [['','application/json'],['<html>proxy</html>','text/html'],['unavailable','text/plain'],['{','application/json']]) {
    await page.route('**/health/api/records/*',route=>route.request().method()==='PUT'?route.fulfill({status:200,body,contentType}):route.continue());
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('editor-error').textContent.length>0);
    assert.equal(await page.locator('#note').inputValue(),'頭痛についての自由メモ');assert.equal(await page.locator('#editor').isVisible(),true);
    assert.equal(review.fixture.db.prepare('SELECT COUNT(*) AS n FROM health_records').get().n,1);
    await page.unroute('**/health/api/records/*');
  }
  for(const failure of ['server','network']) {
    await page.route('**/health/api/records/*',route=>route.request().method()!=='PUT'?route.continue():failure==='server'?route.fulfill({status:500,body:'<html>temporary failure</html>',contentType:'text/html'}):route.abort('failed'));
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('editor-error').textContent.length>0);
    assert.equal(await page.locator('#note').inputValue(),'頭痛についての自由メモ');assert.equal(await page.locator('#editor').isVisible(),true);
    assert.equal(review.fixture.db.prepare('SELECT COUNT(*) AS n FROM health_records').get().n,1);
    await page.unroute('**/health/api/records/*');
  }

  await page.screenshot({path:new URL('../../tmp/health-review/editor.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'});
  assert.match(await page.locator('#today-status').textContent(), /頭痛についての自由メモ/);
  assert.match(await page.locator('#today-status').textContent(), /今日の調子：良い/);
  assert.equal(await page.locator('#period-reminder').isVisible(), false);
  await page.locator('#record-today').click(); await page.locator('#period-details > summary').click();
  await page.getByRole('button',{name:'生理開始',exact:true}).click();
  for(const revision of [1,3]){
    await page.route('**/health/api/records/*',route=>route.request().method()==='PUT'?route.fulfill({status:200,json:{ok:true,revision}}):route.continue());
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('editor-error').textContent.includes('保存結果'));
    assert.equal(await page.locator('#editor').isVisible(),true);assert.equal(await page.locator('#start-period').getAttribute('aria-pressed'),'true');
    await page.unroute('**/health/api/records/*');
  }
  await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'});
  assert.ok(await page.locator('#period-reminder').isVisible());
  assert.notEqual(await page.locator('#prediction-window').textContent(), '開始日を記録すると表示');
  assert.ok(writes.length); assert.ok(writes.every(v => !/頭痛|自由メモ|symptoms|date/.test(v)));
  assert.ok(writes.every(value=>Object.keys(JSON.parse(value)).sort().join(',')==='ciphertext,expectedRevision,iv'));
  // Model a different credential in the test harness; the login UI stays identical.
  await other.route('**/review/auth',route=>route.fulfill({json:{prf:Array.from(review.fixture.users.subject.prf),handoffToken:review.fixture.issue('subject')}}));
  await other.goto(review.url); await other.getByRole('button',{name:'パスキーでログイン',exact:true}).click(); await other.locator('#app').waitFor({state:'visible'});
  assert.equal(review.fixture.auditEvents.filter(event=>event.eventType==='passkey_login_success').at(-1).identityId,'fixture-subject');
  await other.getByRole('button',{name:'記録一覧',exact:true}).click(); await other.locator('.entry').first().click(); assert.equal(await other.locator('#note').inputValue(),'頭痛についての自由メモ');
  await other.locator('#note').fill('共同編集後の備考'); await other.getByRole('button',{name:'保存',exact:true}).click(); await other.locator('#editor').waitFor({state:'hidden'});
  // The first person still has the old revision. A conflict keeps the draft and login.
  await page.locator('#record-today').click(); await page.locator('#note').fill('競合で残す入力');
  await page.locator('#save').click(); await page.waitForFunction(()=>document.getElementById('editor-error').textContent.includes('別の端末'));
  assert.equal(await page.locator('#note').inputValue(),'競合で残す入力'); assert.ok(await page.locator('#app').isVisible());
  page.once('dialog', dialog=>dialog.accept()); await page.locator('#editor-close').click(); await page.locator('#editor').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'最新の記録を読み込む',exact:true}).click(); await page.getByRole('button',{name:'記録一覧',exact:true}).click(); await page.locator('.entry').first().click(); assert.equal(await page.locator('#note').inputValue(),'共同編集後の備考');
  await page.locator('#note').fill('未保存'); page.once('dialog',dialog=>dialog.dismiss()); await page.locator('#editor-close').click(); assert.ok(await page.locator('#editor').isVisible()); assert.equal(await page.locator('#note').inputValue(),'未保存');
  page.once('dialog',dialog=>dialog.accept()); await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('.entry').first().click(); await page.goBack(); await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('#cycle-details > summary').click(); await page.getByRole('button',{name:'予測設定',exact:true}).click(); await page.locator('#cycle-days').fill('30'); await page.locator('#settings-form').getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#settings').waitFor({state:'hidden'}); await page.locator('#cycle-details > summary').click();
  await page.getByRole('button',{name:'CSV出力',exact:true}).click(); const download = page.waitForEvent('download'); await page.getByRole('button',{name:'ダウンロード',exact:true}).click(); assert.equal((await download).suggestedFilename(),'体調管理.csv'); await page.locator('#export').waitFor({state:'hidden'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'カレンダー',exact:true}).click();
  await page.locator('#record-end').click();
  assert.equal(await page.locator('#end-period').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#note').inputValue(), '共同編集後の備考');
  await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(await page.locator('#period-reminder').isVisible(), false);
  // Ordinary daily records remain available after an explicit period end.
  const previousDate = addDays(today(), -1);
  if (previousDate.slice(0, 7) !== today().slice(0, 7)) await page.locator('#previous').click();
  await page.locator(`.day[aria-label="${previousDate}"]`).click();
  assert.equal(await page.locator('#period-details').evaluate(element=>element.open), false);
  await page.locator('#note').fill('いつもの体調のメモ '+ '長い備考'.repeat(80));
  await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'}); await page.locator('#today').click();
  assert.equal(await page.locator('#period-reminder').isVisible(), false);
  for (const width of [320, 390]) {
    await page.setViewportSize({width, height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `${width}px layout`);
  }
  await page.locator('#insights-tab').click();
  assert.equal(await page.locator('#insight-recorded').textContent(),'2日 / 30日');
  assert.equal(await page.locator('#insight-cycles').isVisible(),true);
  await page.locator('#insights-panel > details').last().locator('summary').click();
  for (const width of [320,390,1280]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), width+'px insights');
    await page.screenshot({path:new URL('../../tmp/health-review/insights-'+width+'.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844}); await page.locator('#calendar-tab').click();
  // Delete and recreate the same date after refresh: the server preserves its counter.
  const dailyId=await recordId(review.fixture.master,previousDate,'nobumi');
  const dailyRow=()=>review.fixture.db.prepare('SELECT iv,ciphertext,revision FROM health_records WHERE record_id=?').get(dailyId);
  if(previousDate.slice(0,7)!==today().slice(0,7))await page.locator('#previous').click();
  const openDaily=()=>page.locator(`.day[aria-label~="${previousDate}"]`).click();
  await openDaily();await page.locator('#note').fill('再登録前の更新');await page.locator('#save').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(dailyRow().revision,2);
  await openDaily();page.once('dialog',dialog=>dialog.accept());await page.locator('#delete').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.deepEqual({...dailyRow()},{iv:'',ciphertext:'',revision:3});
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
  await page.reload();await page.locator('#sign-in').click();await page.locator('#app').waitFor({state:'visible'});
  if(previousDate.slice(0,7)!==today().slice(0,7))await page.locator('#previous').click();
  await openDaily();assert.equal(await page.locator('#delete').isVisible(),false);
  await page.locator('#note').fill('削除した日の再登録');await page.locator('#save').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(dailyRow().revision,4);assert.equal((await decryptRecord(review.fixture.master,dailyId,dailyRow(),'nobumi')).note,'削除した日の再登録');
  await openDaily();await page.locator('#note').fill('再登録後の更新');await page.locator('#save').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(dailyRow().revision,5);
  await page.reload();await page.locator('#sign-in').click();await page.locator('#app').waitFor({state:'visible'});
  if(previousDate.slice(0,7)!==today().slice(0,7))await page.locator('#previous').click();
  await openDaily();assert.equal(await page.locator('#note').inputValue(),'再登録後の更新');
  await page.locator('#editor-close').click();await page.locator('#editor').waitFor({state:'hidden'});await page.locator('#today').click();
  // Opening/decrypting old records does not rewrite them; an explicit save upgrades only that row.
  await page.locator('#list-tab').click();
  await page.locator('.entry').filter({hasText:legacyDate}).click();
  assert.ok(await page.getByLabel('腹痛・生理痛',{exact:true}).isChecked());
  assert.ok(await page.getByLabel('気分の落ち込み',{exact:true}).isChecked());
  assert.equal(await page.locator('#conditions [aria-pressed="true"]').count(),0);
  await page.locator('#note').fill('旧形式を編集'); await page.locator('#save').click(); await page.locator('#editor').waitFor({state:'hidden'});
  const upgradedRow=review.fixture.db.prepare('SELECT iv,ciphertext,revision FROM health_records WHERE record_id=?').get(legacyId);
  const upgraded=await decryptRecord(review.fixture.master,legacyId,upgradedRow, 'nobumi');
  assert.equal(upgraded.schemaVersion,2);assert.equal(upgraded.condition,null);assert.deepEqual(upgraded.symptoms.map(item=>item.id),['abdominal_pain','low_mood']);
  // Stronger optional symptom metadata survives a note-only edit.
  const intensityValue={...upgraded,symptoms:upgraded.symptoms.map(item=>({...item,intensity:'strong'}))};
  const intensityCipher=await encryptRecord(review.fixture.master,legacyId,intensityValue, 'nobumi');
  review.fixture.db.prepare('UPDATE health_records SET iv=?,ciphertext=?,revision=revision+1 WHERE record_id=?').run(intensityCipher.iv,intensityCipher.ciphertext,legacyId);
  await page.locator('#refresh').click(); await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await page.locator('.entry').filter({hasText:legacyDate}).click(); await page.locator('#note').fill('強度は保持'); await page.locator('#save').click(); await page.locator('#editor').waitFor({state:'hidden'});
  const preserved=await decryptRecord(review.fixture.master,legacyId,review.fixture.db.prepare('SELECT iv,ciphertext FROM health_records WHERE record_id=?').get(legacyId), 'nobumi');
  assert.ok(preserved.symptoms.every(item=>item.intensity==='strong'));
  await page.locator('#calendar-tab').click();
  // A future date can be inspected, but cannot be saved as actual history.
  const tomorrow=addDays(today(),1);
  if(tomorrow.slice(0,7)!==today().slice(0,7)) await page.locator('#next').click();
  await page.locator('.day[aria-label="'+tomorrow+'"]').click(); await page.locator('#note').fill('未来の実績は保存しない');
  const beforeWrites=writes.length; await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('editor-error').textContent.includes('未来'));
  assert.equal(writes.length,beforeWrites);
  page.once('dialog',dialog=>dialog.accept()); await page.locator('#editor-close').click(); await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('#today').click();
  await page.screenshot({path:new URL('../../tmp/health-review/mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
  await other.getByRole('button',{name:'カレンダー',exact:true}).click();
  await other.locator('#refresh').click(); await other.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await other.screenshot({path:new URL('../../tmp/health-review/desktop.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
  await page.getByRole('button',{name:'ログアウト',exact:true}).click(); await page.locator('#login').waitFor({state:'visible'}); assert.equal(await page.locator('#note').inputValue(),'');
  await page.getByRole('button',{name:'パスキーでログイン',exact:true}).click(); await page.locator('#app').waitFor({state:'visible'}); await page.locator('.day.current').click(); await page.locator('#note').fill('画面離脱と保存完了の競合');
  let releaseSave; const delayedSave=new Promise(resolve=>releaseSave=resolve); let saveReached; const saveRequest=new Promise(resolve=>saveReached=resolve);
  await page.route('**/health/api/records/*',async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();saveReached();await delayedSave;await route.fulfill({response});});
  await page.getByRole('button',{name:'保存',exact:true}).click(); await saveRequest; assert.ok(await page.locator('#note').isDisabled()); await page.evaluate(()=>dispatchEvent(new Event('pagehide'))); releaseSave(); await page.getByRole('button',{name:'パスキーでログイン',exact:true}).waitFor({state:'visible'}); await page.waitForFunction(()=>!document.getElementById('sign-in').disabled); assert.equal(await page.locator('#calendar').textContent(),''); assert.equal(await page.locator('#records').textContent(),''); assert.equal(await page.locator('#today-status').textContent(),''); assert.equal(await page.locator('#prediction-window').textContent(),''); await page.unroute('**/health/api/records/*');
  // Completion after pagehide must not restore a key or decrypted records.
  for (const phase of ['authenticate', 'unwrap', 'decrypt']) {
    if (phase === 'decrypt') { await page.locator('#sign-in').click(); await page.locator('#app').waitFor({state:'visible'}); }
    await page.evaluate(phase => {
      const target = phase === 'authenticate' ? TRoomPasskeys : crypto.subtle;
      const name = phase === 'authenticate' ? 'authenticate' : 'decrypt';
      const original = target[name].bind(target); let restore;
      window.healthRaceReady = false;
      const gate = new Promise(resolve => { window.releaseHealthRace = resolve; });
      target[name] = async (...args) => {
        const result = await original(...args);
        if (phase === 'authenticate' || args[0].name === (phase === 'unwrap' ? 'RSA-OAEP' : 'AES-GCM')) {
          target[name] = restore; window.healthRaceReady = true; await gate;
          if (phase === 'authenticate') window.healthRacePrf = result.prfOutput;
        }
        return result;
      };
      restore = original;
    }, phase);
    await page.locator(phase === 'decrypt' ? '#refresh' : '#sign-in').click();
    await page.waitForFunction(() => window.healthRaceReady);
    await page.evaluate(() => { dispatchEvent(new Event('pagehide')); window.releaseHealthRace(); });
    await page.waitForFunction(() => !document.getElementById('sign-in').disabled);
    assert.ok(await page.locator('#login').isVisible(), phase);
    assert.equal(await page.locator('#calendar').textContent(), '', phase);
    assert.equal(await page.locator('#records').textContent(), '', phase);
    assert.equal(await page.locator('#note').inputValue(), '', phase);
    assert.equal(await page.locator('#today-status').textContent(), '', phase);
    assert.equal(await page.locator('#last-period-start').textContent(), '', phase);
    if (phase === 'authenticate') assert.ok(await page.evaluate(() => window.healthRacePrf.every(byte => byte === 0)));
  }
  await page.route('**/health/api/passkey/handoff',async route=>{const response=await route.fetch();const value=await response.json();await route.fulfill({response,json:{...value,expiresAt:Math.floor(Date.now()/1000)+2}});});
  await page.getByRole('button',{name:'パスキーでログイン',exact:true}).click(); await page.locator('#app').waitFor({state:'visible'}); await page.locator('#login').waitFor({state:'visible'}); assert.equal(await page.locator('#calendar').textContent(),'');
  review.fixture.revoke(); await other.getByRole('button',{name:'最新の記録を読み込む',exact:true}).click(); await other.locator('#login').waitFor({state:'visible'}); assert.equal(await other.locator('#records').textContent(),'');
  assert.deepEqual(failures,[]); console.log('Health minimal passkey login, delete/recreate revisions 1-5, conditions, insights 320/390/1280, legacy upgrade/intensity preservation, future rejection, OCC draft retention; mobile/desktop: daily health first, optional period fields, explicit end, shared encrypted CRUD, unsaved guard, Back/Esc, settings, CSV, logout and pagehide races passed.');
} finally { await browser.close(); await review.close(); }
