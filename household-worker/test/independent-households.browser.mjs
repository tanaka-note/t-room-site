import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export async function verifyIndependentHouseholds(browser,url,owner,chiharu){
  const context=await browser.newContext({extraHTTPHeaders:{'X-Fixture-Role':'owner'}});
  try{
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    const before=await owner.state();
    await page.goto(url+'#accounts');await page.locator('.account-card').first().getByRole('button',{name:'編集',exact:true}).click();
    await page.locator('#account-form [name=name]').fill('STALE-ORIGINAL-INPUT');
    // Simulate another tab replacing the login cookie, without relying on a
    // BroadcastChannel notification to protect the old tab's pending form.
    await context.setExtraHTTPHeaders({'X-Fixture-Role':'chiharu'});
    await page.locator('#account-form [type=submit]').click();
    await page.locator('#login-view').waitFor({state:'visible'});
    assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#account-form [name=name]').inputValue(),'');
    assert.deepEqual(await owner.state(),before);assert.equal((await chiharu.state()).revision,0);
    await page.reload();await page.locator('#app-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#account-name').textContent(),'田中千晴');assert.equal(await page.locator('#access-mode').textContent(),'編集可能');
    assert.equal(await page.locator('.account-card').count(),0);assert.ok(!(await page.locator('#app-view').textContent()).includes('減価償却'));
    await page.locator('[data-view=transactions]').click();await page.locator('#add-entry').click();
    await page.locator('#entry-form [name=amount]').fill('789');await page.locator('#entry-form [name=description]').fill('Independent Chiharu expense');
    await page.locator('#entry-form [type=submit]').click();await page.locator('#entry-dialog').waitFor({state:'hidden'});
    assert.ok((await page.locator('#entries').textContent()).includes('Independent Chiharu expense'));
    assert.equal((await chiharu.state()).data.transactions.length,1);assert.deepEqual(await owner.state(),before);
    await page.locator('[data-view=settings]').click();
    // CSV remains an authenticated fetch carrying the same session binding.
    const downloaded=page.waitForEvent('download');await page.locator('#export-csv').click();const csv=readFileSync(await (await downloaded).path(),'utf8');
    assert.ok(csv.includes('Independent Chiharu expense'));assert.ok(!csv.includes('減価償却'));assert.deepEqual(errors,[]);
    console.log('Independent household browser: empty Chiharu account, standard input, scoped CSV and stale-tab save rejection passed.');
  }finally{await context.close();}
}
