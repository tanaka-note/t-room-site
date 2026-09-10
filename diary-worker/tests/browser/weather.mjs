import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, serviceWorkers: "block" });
  const errors = [];
  const queries = [];
  let entries = [];
  page.on("pageerror", (error) => (errors.push(error.message), console.error(error)));
  await page.route("https://diary.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/diary/api/")) {
      let result = {};
      if (url.pathname.endsWith("/session")) result = {
        authenticated: true, role: "admin", accountName: "カレンダーテスト", householdId: "test",
        activeHouseholdId: "test", isGlobalOwner: false, canManageEntries: true, canViewTrash: true
      };
      if (url.pathname.endsWith("/meta")) result = { months: [], tags: [], draftCount: 0 };
      if (url.pathname.endsWith("/entries")) {
        queries.push(Object.fromEntries(url.searchParams));
        if (route.request().method() === 'POST') {
          const body=route.request().postDataJSON();
          const entry={...body,id:entries.length+1,revision:1,authorName:'テスト',photos:[],createdAt:'2026-09-10',updatedAt:'2026-09-10'};
          entries.unshift(entry); result={entry};
        } else result = { entries, hasMore: false };
      }
      const match=url.pathname.match(/\/entries\/(\d+)$/);
      if (match) {
        const index=entries.findIndex(entry=>entry.id===Number(match[1]));
        if (route.request().method()==='PUT') entries[index]={...entries[index],...route.request().postDataJSON(),revision:entries[index].revision+1};
        result={entry:entries[index]};
      }
      return route.fulfill({ json: result });
    }
    const shared = {
      "/assets/pwa-auto-update.js": "../../../assets/pwa-auto-update.js",
      "/security/passkey-client.js": "../../../security-worker/public/passkey-client.js"
    };
    const path = shared[url.pathname] || `../../public/${url.pathname === "/diary/" ? "index.html" : url.pathname.slice("/diary/".length)}`;
    const contentType = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
    try { await route.fulfill({ body: await readFile(new URL(path, import.meta.url)), contentType }); }
    catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("https://diary.test/diary/", { waitUntil: "networkidle" });
  await page.waitForSelector("#app-view:not([hidden])");

  const editor=page.locator('#editor-dialog');
  const menu=page.locator('#entry-weather-menu');
  const weather=page.locator('#entry-weather-button');
  const close=editor.locator('[data-close-dialog="editor-dialog"]');
  async function create() { await page.click('#new-entry-button'); await page.waitForSelector('#editor-dialog[open]'); }
  async function choose(id) { await weather.click(); await menu.locator('button[data-weather="'+id+'"]').click(); assert.equal(await menu.isHidden(),true); }
  async function closed() { await page.waitForFunction(()=>!document.querySelector('#editor-dialog').open); }
  async function save() { await page.click('#save-entry-button'); await closed(); await page.waitForLoadState('networkidle'); }
  async function editFirst() {
    await page.locator('.diary-entry-card .diary-entry-button').first().click();
    await page.waitForSelector('#entry-dialog[open]');
    await page.click('#edit-entry-button'); await page.waitForSelector('#editor-dialog[open]');
  }
  await create();
  assert.equal(await weather.textContent(),'天気');
  assert.equal(await weather.getAttribute('aria-label'),'天気を選択：未設定');
  assert.equal(await weather.getAttribute('aria-label'),'天気を選択：未設定');
  const a=await weather.boundingBox(),b=await close.boundingBox();
  assert.equal(a.width,b.width); assert.equal(a.height,b.height); assert.ok(a.x+a.width<=b.x);
  await weather.click();
  const labels=['晴れ','曇り','曇り晴れ','雨くもり','雨','大雨','雷','雪だるま','未設定に戻す'];
  assert.equal(await menu.locator('button').count(),9);
  for (const [index,label] of labels.entries()) {
    const option=menu.locator('button').nth(index);
    assert.equal(await option.textContent(),'');
    assert.equal(await option.getAttribute('aria-label'),label);
    assert.equal(await option.getAttribute('title'),label);
    assert.equal(await option.locator('svg').count(),1);
  }
  for (const width of [1100,390]) {
    await page.setViewportSize({width,height:844});
    const boxes=await menu.locator('button').evaluateAll(buttons=>buttons.map(button=>{
      const rect=button.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
    }));
    assert.ok(boxes.every(box=>box.width>=44 && box.height>=44));
    assert.equal(boxes[0].y,boxes[2].y);
    assert.ok(boxes[3].y>boxes[0].y && boxes[6].y>boxes[3].y);
    const rect=await menu.boundingBox();
    assert.ok(rect.x>=0 && rect.x+rect.width<=width && rect.height<180);
  }
  if (process.env.WEATHER_MENU_PREVIEW) await menu.screenshot({path:process.env.WEATHER_MENU_PREVIEW});
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator(':focus').getAttribute('aria-label'),'雨');
  await page.keyboard.press('Escape'); assert.equal(await menu.isHidden(),true); assert.equal(await editor.evaluate(e=>e.open),true);
  await choose('sunny');
  assert.equal(await weather.textContent(),'');
  assert.equal(await weather.locator('svg').count(),1);
  await weather.click();
  assert.equal(await menu.locator('button[data-weather="sunny"]').getAttribute('aria-checked'),'true');
  const backgrounds=await menu.locator('button').evaluateAll(buttons=>buttons.slice(0,2).map(button=>getComputedStyle(button).backgroundColor));
  assert.notEqual(backgrounds[0],backgrounds[1]);
  await page.keyboard.press('Escape');
  await close.click(); await page.waitForSelector('#editor-leave-dialog[open]');
  await page.click('#editor-leave-cancel'); assert.equal(await weather.getAttribute('aria-label'),'天気を選択：晴れ');
  await choose(''); assert.equal(await weather.textContent(),'天気'); await close.click(); await closed();
  await create(); await page.fill('#entry-title','天気なし'); await page.fill('#entry-content','本文'); await save();
  assert.equal(entries[0].weather,null); assert.equal(await page.locator('.diary-entry-card .weather-pictogram').count(),0);
  await create(); assert.equal(await weather.getAttribute('aria-label'),'天気を選択：未設定');
  await page.fill('#entry-title','長いタイトルの確認'.repeat(15)); await page.fill('#entry-content','検索用の本文'); await choose('sunny'); await save();
  assert.equal(entries[0].weather,'sunny');
  for (const width of [1100,390]) {
    await page.setViewportSize({width,height:844});
    const title=page.locator('.diary-entry-card h3').first();
    const icon=await title.locator('.weather-pictogram').boundingBox();const rect=await title.boundingBox();
    assert.ok(icon.width>=20);assert.ok(Math.abs(icon.x+icon.width-rect.x-rect.width)<2);
  }
  await page.locator('.diary-entry-card .diary-entry-button').first().click();
  await page.waitForSelector('#entry-dialog[open]');
  assert.equal(await page.locator('#detail-title .weather-pictogram').getAttribute('data-weather'),'sunny');
  await page.click('#edit-entry-button'); await page.waitForSelector('#editor-dialog[open]');
  assert.equal(await weather.getAttribute('aria-label'),'天気を選択：晴れ');
  await choose('rain'); await close.click(); await page.waitForSelector('#editor-leave-dialog[open]'); await page.click('#editor-leave-cancel');
  await choose('sunny'); await close.click(); await closed();
  await editFirst(); await choose('rain'); await save(); assert.equal(entries[0].weather,'rain');
  await editFirst(); await page.fill('#entry-title','本文だけ編集'); await page.fill('#entry-content','変更後'); await save(); assert.equal(entries[0].weather,'rain');
  await editFirst(); await choose(''); await save(); assert.equal(entries[0].weather,null);
  assert.equal(await page.locator('.diary-entry-card .weather-pictogram').count(),0);
  await page.setViewportSize({width:1100,height:844});
  await create(); assert.equal(await weather.getAttribute('aria-label'),'天気を選択：未設定'); await choose('snow');
  await page.mouse.click(1,1); await page.waitForSelector('#editor-leave-dialog[open]'); await page.click('#editor-leave-cancel');
  await page.keyboard.press('Escape'); await page.waitForSelector('#editor-leave-dialog[open]'); await page.click('#editor-leave-discard'); await closed();
  assert.deepEqual(errors,[]);
  console.log('Chromium weather: unset default, save/edit/clear, header size, dropdown/Escape, dirty revert/discard, title icons and desktop/mobile layout passed.');
} finally { await browser.close(); }
