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
const legacyId = await recordId(review.fixture.master, legacyDate);
const legacyValue = {date:legacyDate, start:false, end:false, symptoms:[0,5],flow:null,note:'旧形式の備考'};
const legacyCipher = await encryptRecord(review.fixture.master, legacyId, legacyValue);
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
  assert.equal(await page.locator('#login').innerText(),'パスキーでログイン');
  assert.equal(await page.locator('#app').isVisible(),false);
  await page.screenshot({path:new URL('../../tmp/health-review/login.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')}); await page.getByRole('button', { name: 'パスキーでログイン', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
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

  await page.screenshot({path:new URL('../../tmp/health-review/editor.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'});
  assert.match(await page.locator('#today-status').textContent(), /頭痛についての自由メモ/);
  assert.match(await page.locator('#today-status').textContent(), /今日の調子：良い/);
  assert.equal(await page.locator('#period-reminder').isVisible(), false);
  await page.locator('#record-today').click(); await page.locator('#period-details > summary').click();
  await page.getByRole('button',{name:'生理開始',exact:true}).click(); await page.getByRole('button',{name:'保存',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'});
  assert.ok(await page.locator('#period-reminder').isVisible());
  assert.notEqual(await page.locator('#prediction-window').textContent(), '開始日を記録すると表示');
  assert.ok(writes.length); assert.ok(writes.every(v => !/頭痛|自由メモ|symptoms|date/.test(v)));
  await other.goto(review.url); await other.locator('#review-person').selectOption('subject'); await other.getByRole('button',{name:'パスキーでログイン',exact:true}).click(); await other.locator('#app').waitFor({state:'visible'});
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
  // Opening/decrypting old records does not rewrite them; an explicit save upgrades only that row.
  await page.locator('#list-tab').click();
  await page.locator('.entry').filter({hasText:legacyDate}).click();
  assert.ok(await page.getByLabel('腹痛・生理痛',{exact:true}).isChecked());
  assert.ok(await page.getByLabel('気分の落ち込み',{exact:true}).isChecked());
  assert.equal(await page.locator('#conditions [aria-pressed="true"]').count(),0);
  await page.locator('#note').fill('旧形式を編集'); await page.locator('#save').click(); await page.locator('#editor').waitFor({state:'hidden'});
  const upgradedRow=review.fixture.db.prepare('SELECT iv,ciphertext,revision FROM health_records WHERE record_id=?').get(legacyId);
  const upgraded=await decryptRecord(review.fixture.master,legacyId,upgradedRow);
  assert.equal(upgraded.schemaVersion,2);assert.equal(upgraded.condition,null);assert.deepEqual(upgraded.symptoms.map(item=>item.id),['abdominal_pain','low_mood']);
  // Stronger optional symptom metadata survives a note-only edit.
  const intensityValue={...upgraded,symptoms:upgraded.symptoms.map(item=>({...item,intensity:'strong'}))};
  const intensityCipher=await encryptRecord(review.fixture.master,legacyId,intensityValue);
  review.fixture.db.prepare('UPDATE health_records SET iv=?,ciphertext=?,revision=revision+1 WHERE record_id=?').run(intensityCipher.iv,intensityCipher.ciphertext,legacyId);
  await page.locator('#refresh').click(); await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await page.locator('.entry').filter({hasText:legacyDate}).click(); await page.locator('#note').fill('強度は保持'); await page.locator('#save').click(); await page.locator('#editor').waitFor({state:'hidden'});
  const preserved=await decryptRecord(review.fixture.master,legacyId,review.fixture.db.prepare('SELECT iv,ciphertext FROM health_records WHERE record_id=?').get(legacyId));
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
  await page.route('**/health/api/passkey/handoff',async route=>{const response=await route.fetch();const value=await response.json();await route.fulfill({response,json:{...value,expiresAt:Date.now()/1000+2}});});
  await page.getByRole('button',{name:'パスキーでログイン',exact:true}).click(); await page.locator('#app').waitFor({state:'visible'}); await page.locator('#login').waitFor({state:'visible'}); assert.equal(await page.locator('#calendar').textContent(),'');
  review.fixture.revoke(); await other.getByRole('button',{name:'最新の記録を読み込む',exact:true}).click(); await other.locator('#login').waitFor({state:'visible'}); assert.equal(await other.locator('#records').textContent(),'');
  assert.deepEqual(failures,[]); console.log('Health conditions, insights 320/390/1280, legacy upgrade/intensity preservation, future rejection, OCC draft retention; mobile/desktop: daily health first, optional period fields, explicit end, shared encrypted CRUD, unsaved guard, Back/Esc, settings, CSV, logout and pagehide races passed.');
} finally { await browser.close(); await review.close(); }
