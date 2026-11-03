import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function verifyEntryType(browser,url,initial,chooseDate,screens){
 for(const role of ['owner','viewer'])for(const width of [1440,390]){
  const state=structuredClone(initial),category=type=>state.data.categories.find(c=>c.type===type).id;
  const entry=(type,n,date='2026-09-01')=>({id:`${type}-${n}`,type,date,categoryId:category(type),amount:type==='income'?20:10,description:`Sample ${type} ${n}`,notes:'',registrationOrder:n});
  state.data.transactions=Array.from({length:205},(_,n)=>[entry('income',n),entry('expense',n)]).flat();
  state.data.transactions.push(entry('income',999,'2026-08-01'),{id:'legacy',date:'2026-09-01',type:'transfer',amount:999,description:'Legacy transfer',notes:''});
  const context=await browser.newContext({viewport:{width,height:900},extraHTTPHeaders:{'X-Fixture-Role':role},...(width<700?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();
  try{
   const errors=[];page.on('pageerror',e=>errors.push(e.message));let writes=0;page.on('request',r=>{if(r.url().includes('/api/')&&r.method()!=='GET')writes++;});
   await page.route('**/household/api/data',route=>route.fulfill({json:state}));await page.goto(url);await page.locator('#app-view').waitFor({state:'visible'});await chooseDate(page,'period','2026-09');
   const income=page.locator('[data-entry-type=income]'),expense=page.locator('[data-entry-type=expense]');
   const ids=()=>page.locator('#entries tr').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
   async function selected(type,count){
    assert.equal(await page.locator(`[data-entry-type=${type}]`).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-entry-type][aria-pressed=true]').count(),1);
    const values=await ids();assert.equal(values.length,count);assert.ok(values.every(id=>id.startsWith(type+'-')));
   }
   const totals=await page.locator('#view-transactions .summary strong').allTextContents(),summary=await page.locator('#category-summary').textContent();
   await selected('expense',200);assert.equal(await page.locator('#entry-display').textContent(),'200 / 205件を表示');
   assert.equal(await page.locator('#net').evaluate(n=>n.closest('button,[role=button]')),null);
   assert.notEqual(await income.evaluate(n=>getComputedStyle(n).backgroundColor),await expense.evaluate(n=>getComputedStyle(n).backgroundColor));
   await page.locator('#net').click();await selected('expense',200);
   await page.locator('#more-entries').click();await selected('expense',205);assert.equal(await page.locator('#more-entries').isVisible(),false);
   await income.click();await selected('income',200);assert.equal(await page.locator('#more-entries').isVisible(),true);
   await page.locator('#more-entries').click();await selected('income',205);
   await expense.focus();await page.keyboard.press('Enter');await selected('expense',200);
   await income.focus();await page.keyboard.press('Space');await selected('income',200);
   assert.deepEqual(await page.locator('#view-transactions .summary strong').allTextContents(),totals);assert.equal(await page.locator('#category-summary').textContent(),summary);
   await page.locator('#refresh').click();await selected('income',200);
   await page.locator('#period-mode').selectOption('year');await selected('income',200);assert.equal(await page.locator('#entry-display').textContent(),'200 / 206件を表示');
   await expense.click();assert.equal(await page.locator('#period-mode').inputValue(),'year');await selected('expense',200);
   await page.locator('#period-mode').selectOption('month');await page.locator('#search').fill('Sample income 1');await selected('expense',0);assert.equal(await page.locator('#empty-entries').isVisible(),true);assert.equal(await page.locator('#more-entries').isVisible(),false);
   await income.click();assert.equal(await page.locator('#search').inputValue(),'Sample income 1');assert.equal(await page.locator('#period').inputValue(),'2026-09');assert.ok((await ids()).length>0);assert.equal(await page.locator('#empty-entries').isVisible(),false);
   await page.locator('#search').fill('');const parent=state.data.categories.find(c=>c.id===category('expense')).parent;
   await page.locator('#category-filter').selectOption(parent);await selected('income',0);await expense.click();assert.equal(await page.locator('#category-filter').inputValue(),parent);await selected('expense',200);
   await page.locator('#category-filter').selectOption('');await income.click();await page.locator('[data-view=accounts]').click();await page.goBack();await selected('income',200);
   if(width<700){await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await page.locator('#view-transactions .summary').screenshot({path:resolve(screens,`entry-type-${role}-${width}.png`)});
   await page.reload();await page.locator('#app-view').waitFor({state:'visible'});await chooseDate(page,'period','2026-09');await selected('expense',200);
   await income.click();await page.evaluate(()=>dispatchEvent(new Event('troom-session-expired')));await page.locator('#login-view').waitFor({state:'visible'});await selected('expense',0);
   assert.equal(writes,0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log('Entry type: expense default, income/expense taps and keyboard, net display, filters, pagination, totals, reload/session reset, owner/viewer and desktop/mobile passed.');
}
