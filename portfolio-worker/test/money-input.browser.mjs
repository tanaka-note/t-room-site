import assert from 'node:assert/strict';
import {fixture} from './fixture.js';
import {pickDate} from './date-picker.browser.mjs';
async function paste(input,text) {
  await input.evaluate((el,text)=>{const clipboardData=new DataTransfer();clipboardData.setData('text',text);el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));},text);
}
export async function verifyMoneyInputs(browser,url,routeApi) {
 for(const width of [1440,390,320]) {
  const f=fixture(),context=await browser.newContext({viewport:{width,height:1000}});
  try {
   await f.login();const page=await context.newPage();await routeApi(page,f);page.on('dialog',d=>d.accept());await page.goto(url);await page.locator('#report-app').waitFor({state:'visible'});await page.locator('#edit-toggle').click();
   const principal=page.locator('#base-principal'),amount=page.locator('[data-field=amount]').first();
   assert.equal(await principal.inputValue(),'1,000,000');assert.equal(await amount.inputValue(),'300,000');
   await amount.fill('');await amount.pressSequentially('1234567');assert.equal(await amount.inputValue(),'1,234,567');
   // Remove the digit before/after a separator, rather than trapping the caret on it.
   await amount.evaluate(el=>el.setSelectionRange(2,2));await amount.press('Backspace');assert.equal(await amount.inputValue(),'234,567');
   await amount.fill('1234567');await amount.evaluate(el=>el.setSelectionRange(1,1));await amount.press('Delete');assert.equal(await amount.inputValue(),'134,567');
   await amount.fill('1234567');await amount.evaluate(el=>el.setSelectionRange(4,4));await amount.press('9');assert.equal(await amount.inputValue(),'12,394,567');assert.equal(await amount.evaluate(el=>el.selectionStart),5);
   await amount.evaluate(el=>el.setSelectionRange(0,3));await amount.press('8');assert.equal(await amount.inputValue(),'8,394,567');
   await amount.fill('1');await paste(amount,'000');assert.equal(await amount.inputValue(),'1,000');
   await amount.fill('');await paste(amount,'1,234,567');assert.equal(await amount.inputValue(),'1,234,567');
   await amount.evaluate(el=>el.setSelectionRange(1,1));await paste(amount,'99');assert.equal(await amount.inputValue(),'199,234,567');
   const before=await amount.inputValue();await amount.evaluate(el=>el.setSelectionRange(0,el.value.length));await paste(amount,'12,34');assert.equal(await amount.inputValue(),before);assert.equal(await amount.evaluate(el=>el.checkValidity()),false);
   await amount.fill('12,34');await page.locator('#save-button').click();assert.equal((await f.state()).revision,0);assert.equal(await amount.evaluate(el=>el.checkValidity()),false);
   for(const invalid of ['-1','1.5','1e6','1000000000001']) {await amount.fill(invalid);assert.equal(await amount.evaluate(el=>el.checkValidity()),false,invalid);}
   await amount.fill('1000000000000');assert.equal(await amount.inputValue(),'1,000,000,000,000');
   await amount.fill('');assert.equal(await amount.inputValue(),'');assert.equal(await amount.evaluate(el=>el.checkValidity()),false);
   await amount.fill('0');assert.equal(await amount.inputValue(),'0');assert.equal(await amount.evaluate(el=>el.checkValidity()),true);
   await amount.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='１２３４５６７';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});assert.equal(await amount.inputValue(),'１２３４５６７');
   await amount.dispatchEvent('compositionend');assert.equal(await amount.inputValue(),'1,234,567');
   await principal.fill('2000000');assert.equal(await principal.inputValue(),'2,000,000');await amount.blur();assert.equal(await amount.inputValue(),'1,234,567');
   await page.locator('#save-button').click();await page.waitForFunction(()=>document.querySelector('#app-message').textContent.includes('保存しました'));
   const saved=await f.state();assert.equal(saved.metadata.basePrincipal,2000000);assert.equal(saved.record.assets[0].marketValue,1234567);
   await page.locator('#edit-toggle').click();assert.equal(await principal.inputValue(),'2,000,000');assert.equal(await amount.inputValue(),'1,234,567');await page.locator('#cancel-edit').click();
   await pickDate(page,'view-date','2026-10-30');await page.waitForFunction(()=>document.querySelector('.holdings-panel').hidden);await page.locator('#edit-toggle').click();
   const legacy=page.locator('#legacy-total');assert.equal(await legacy.inputValue(),'1,100,000');await legacy.fill('1234567');assert.equal(await legacy.inputValue(),'1,234,567');assert.match(await page.locator('#editor-total').textContent(),/1,234,567/);
   await page.locator('#save-button').click();await page.waitForFunction(()=>document.querySelector('#app-message').textContent.includes('保存しました'));assert.equal((await f.state()).history.find(r=>r.period==='2026-10-30').rawMarketValue,1234567);
  } finally {await context.close();f.close();}
 }
 console.log('Money input grouping, caret edits, deletion, paste validation, composition and integer saves passed at 1440/390/320px.');
}
