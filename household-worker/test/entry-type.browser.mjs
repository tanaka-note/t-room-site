import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function verifyEntryType(browser,url,initial,chooseDate,screens){
 for(const role of ['owner','viewer'])for(const width of [1440,390]){
  const state=structuredClone(initial),category=type=>state.data.categories.find(c=>c.type===type).id;
  const entry=(type,n,date='2026-09-01')=>({id:`${type}-${n}`,type,date,categoryId:category(type),amount:type==='income'?20:10,description:`Sample ${type} ${n}`,notes:'',registrationOrder:n});
  state.data.transactions=Array.from({length:205},(_,n)=>[entry('income',n),entry('expense',n)]).flat();
  state.data.transactions.push(
   entry('income',999,'2026-08-01'),
   {...entry('income',1000,'2026-01-01'),amount:50},
   {...entry('expense',1001,'2026-10-01'),amount:100},
   {...entry('expense',1002,'2025-09-30'),amount:500},
   {...entry('income',1003,'2025-12-31'),amount:1000},
   {id:'legacy',date:'2026-09-01',type:'transfer',amount:999,description:'Legacy transfer',notes:''},
   {id:'legacy-prior-year',date:'2025-01-10',type:'transfer',amount:999,description:'Legacy transfer',notes:''},
  );
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
   const cards=page.locator('#view-transactions>.summary>*');
   const comparisons=()=>cards.locator('strong').allTextContents().then(values=>values.slice(3));
   assert.deepEqual(await cards.locator('span').allTextContents(),['収入','支出','収支','対前月比','対前年比','年間累計収支']);
   assert.deepEqual(await comparisons(),['+2,030円','+2,550円','2,120円']);
   const totals=await cards.locator('strong').allTextContents(),summary=await page.locator('#category-summary').textContent();
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
   await page.locator('#period-mode').selectOption('year');await selected('income',200);assert.equal(await page.locator('#entry-display').textContent(),'200 / 207件を表示');
   assert.deepEqual(await comparisons(),['ー','+1,520円','2,020円']);
   await expense.click();assert.equal(await page.locator('#period-mode').inputValue(),'year');await selected('expense',200);
   await page.locator('#period-mode').selectOption('month');await page.locator('#search').fill('Sample income 1');await selected('expense',0);assert.equal(await page.locator('#empty-entries').isVisible(),true);assert.equal(await page.locator('#more-entries').isVisible(),false);
   await income.click();assert.equal(await page.locator('#search').inputValue(),'Sample income 1');assert.equal(await page.locator('#period').inputValue(),'2026-09');assert.ok((await ids()).length>0);assert.equal(await page.locator('#empty-entries').isVisible(),false);
   await page.locator('#search').fill('');const parent=state.data.categories.find(c=>c.id===category('expense')).parent;
   await page.locator('#category-filter').selectOption(parent);await selected('income',0);await expense.click();assert.equal(await page.locator('#category-filter').inputValue(),parent);await selected('expense',200);
   assert.deepEqual(await comparisons(),['-2,050円','-1,550円','-2,050円']);
   await page.locator('#search').fill('No matching sample');
   assert.deepEqual(await comparisons(),['0円','0円','0円']);
   await page.locator('#search').fill('');
   await page.locator('#category-filter').selectOption('');
   await chooseDate(page,'period','2026-01');
   assert.deepEqual(await comparisons(),['-950円','ー','50円']);
   await chooseDate(page,'period','2026-08');
   assert.deepEqual(await comparisons(),['ー','ー','70円']);
   await chooseDate(page,'period','2026-09');
   await page.locator('#category-filter').selectOption('');await income.click();await page.locator('[data-view=accounts]').click();await page.goBack();await selected('income',200);
   if(width<700){await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   const boxes=await cards.evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().toJSON()));
   for(const box of boxes){
    assert.ok(Math.abs(box.width-boxes[0].width)<1);
    assert.ok(Math.abs(box.height-boxes[0].height)<1);
   }
   assert.equal(boxes[0].y,boxes[2].y);
   assert.equal(boxes[3].y,boxes[5].y);
   assert.ok(boxes[3].y>boxes[0].bottom);
   for(let column=0;column<3;column++)assert.equal(boxes[column].x,boxes[column+3].x);
   await page.locator('#view-transactions .summary').screenshot({path:resolve(screens,`entry-type-${role}-${width}.png`)});
   await page.reload();await page.locator('#app-view').waitFor({state:'visible'});await chooseDate(page,'period','2026-09');await selected('expense',200);
   await income.click();await page.evaluate(()=>dispatchEvent(new Event('troom-session-expired')));await page.locator('#login-view').waitFor({state:'visible'});await selected('expense',0);
   assert.deepEqual(await comparisons(),['ー','ー','0円']);
   assert.equal(writes,0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log('Entry type: expense default, income/expense taps and keyboard, period comparisons, year-to-date, filters, pagination, reload/session reset, owner/viewer and desktop/mobile passed.');
}
