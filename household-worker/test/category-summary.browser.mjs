import assert from 'node:assert/strict';
import {resolve} from 'node:path';

const yen=n=>new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(n).normalize('NFKC');

export async function verifyCategorySummary(browser,url,initial,chooseDate,screens){
 for(const role of ['owner','viewer'])for(const width of [1440,390]){
  const state=structuredClone(initial),category=(parent,name)=>state.data.categories.find(c=>c.parent===parent&&(!name||c.name===name)).id;
  const entry=(id,date,parent,amount,name,description='Sort sample')=>({id,date,categoryId:category(parent,name),type:parent==='収入'?'income':'expense',amount,description,notes:'',included:true});
  state.data.transactions=[entry('a','2026-09-30','食費',100,'食費'),entry('b','2026-09-29','交通費',3000),entry('c','2026-09-28','日用品',3000),entry('d','2026-09-20','食費',3900,'外食'),entry('e','2026-09-01','収入',5000,'給与'),entry('f','2026-08-01','交通費',10000),entry('g','2026-09-30','住宅',1000,undefined,'Other sample'),entry('h','2026-09-01','収入',1000,'賞与'),{id:'legacy-transfer',date:'2026-09-30',type:'transfer',amount:99999,description:'Legacy transfer',notes:''}];
  const context=await browser.newContext({viewport:{width,height:900},extraHTTPHeaders:{'X-Fixture-Role':role},...(width<700?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();
  try{
   const errors=[];page.on('pageerror',e=>errors.push(e.message));let writes=0;page.on('request',r=>{if(r.url().includes('/api/')&&r.method()!=='GET')writes++;});
   await page.route('**/household/api/data',route=>route.fulfill({json:state}));await page.goto(url);await page.locator('#app-view').waitFor({state:'visible'});await chooseDate(page,'period','2026-09');
   const names=(type='expense')=>page.locator(`.category-summary-group[data-type=${type}] .category-stat>summary>.category-label`).allTextContents();
   const amounts=async(type='expense')=>(await page.locator(`.category-summary-group[data-type=${type}] .category-stat>summary>strong`).allTextContents()).map(v=>v.normalize('NFKC'));
   const group=(name,type='expense')=>page.locator(`.category-summary-group[data-type=${type}] .category-stat`).filter({has:page.locator('summary>.category-label').filter({hasText:new RegExp(`^${name}$`)})});
   const children=name=>group(name).locator('.category-breakdown>li>.category-label').allTextContents();
   const childAmounts=async name=>(await group(name).locator('.category-breakdown .numeric').allTextContents()).map(v=>v.normalize('NFKC'));
   assert.deepEqual(await names('income'),['収入']);assert.deepEqual(await names(),['食費','交通費','日用品','住宅']);assert.deepEqual(await amounts(),[4000,3000,3000,1000].map(yen));
   assert.equal(await page.locator('#category-summary .category-summary-group').count(),2);assert.equal((await page.locator('.category-summary-group[data-type=income] .category-summary-heading>strong').textContent()).normalize('NFKC'),yen(6000));
   assert.equal((await page.locator('.category-summary-group[data-type=expense] .category-summary-heading>strong').textContent()).normalize('NFKC'),yen(11000));
   const food=group('食費'),summary=food.locator('summary');assert.equal(await food.getAttribute('open'),null);
   await summary.focus();await page.keyboard.press('Enter');assert.notEqual(await food.getAttribute('open'),null);assert.equal(await food.locator('ul').isVisible(),true);
   assert.deepEqual(await children('食費'),['外食','食費']);assert.deepEqual(await childAmounts('食費'),[3900,100].map(yen));
   assert.equal(await food.locator('summary .category-mark').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(223, 77, 78)');assert.equal(await food.locator('li .category-mark').first().evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(223, 77, 78)');
   await summary.focus();await page.keyboard.press('Space');assert.equal(await food.getAttribute('open'),null);await summary.click();
   await page.locator('#category-summary').screenshot({path:resolve(screens,`category-summary-${role}-${width}.png`)});
   await page.locator('#period-mode').selectOption('year');assert.deepEqual(await names(),['交通費','食費','日用品','住宅']);assert.equal((await amounts())[0],yen(13000));assert.notEqual(await food.getAttribute('open'),null);
   await page.locator('#period-mode').selectOption('month');await page.locator('#search').fill('外食');assert.deepEqual(await names(),['食費']);assert.deepEqual(await childAmounts('食費'),[yen(3900)]);assert.equal((await food.locator('summary>strong').textContent()).normalize('NFKC'),yen(3900));
   await page.locator('#search').fill('Other sample');assert.deepEqual(await names(),['住宅']);
   await page.locator('#search').fill('');await page.locator('#category-filter').selectOption('食費');assert.deepEqual(await names(),['食費']);assert.deepEqual(await amounts(),[yen(4000)]);
   await page.locator('#search').fill('No matching sample');assert.deepEqual(await names(),[]);assert.equal(await page.locator('#category-summary .category-empty').count(),2);
   await page.locator('#search').fill('');await page.locator('#category-filter').selectOption('');

   // Dates ascend (1 -> 2 -> 3 -> 5); backdated registrations append within their date.
   // Only unknown legacy records use their former ID order.
   state.data.transactions=[{...entry('a-new','2026-09-01','食費',10),registrationOrder:3},{...entry('z-first','2026-09-01','食費',10),registrationOrder:1},{...entry('middle','2026-09-03','食費',10),registrationOrder:2},entry('old-z','2026-09-01','食費',10),entry('old-a','2026-09-01','食費',10),{...entry('y-two-first','2026-09-02','食費',10),registrationOrder:4},{...entry('b-two-second','2026-09-02','食費',10),registrationOrder:5},{...entry('c-two-backdated','2026-09-02','食費',10),registrationOrder:6},{...entry('five','2026-09-05','食費',10),registrationOrder:7}];
   const expectedOrder=['old-a','old-z','z-first','a-new','y-two-first','b-two-second','c-two-backdated','middle','five'];
   await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#entry-count').textContent==='9件');
   assert.deepEqual(await page.locator('#entries tr').evaluateAll(nodes=>nodes.map(n=>n.dataset.id)),expectedOrder);
   await page.reload();await page.locator('#app-view').waitFor({state:'visible'});await chooseDate(page,'period','2026-09');
   assert.deepEqual(await page.locator('#entries tr').evaluateAll(nodes=>nodes.map(n=>n.dataset.id)),expectedOrder);

   // Every matching entry contributes even before pagination, including custom subcategories.
   state.data.categories.push({id:'sample-custom',parent:'食費',name:'検証用の長い独自カテゴリ名と外食の内訳',type:'expense',builtin:false});
   state.data.transactions=Array.from({length:205},(_,i)=>({...entry(`sample-${String(205-i).padStart(3,'0')}`,'2026-09-01','食費',10,'食費',`Sample ${i+1}`),categoryId:i%2?'sample-custom':category('食費','食費'),registrationOrder:i+1})).reverse();
   await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#entry-count').textContent==='205件');
   assert.equal(await page.locator('#entries tr').count(),200);assert.equal(await page.locator('#entries tr').first().locator('.description').textContent(),'Sample 1');assert.equal(await page.locator('#entries tr').last().locator('.description').textContent(),'Sample 200');
   await group('食費').locator('summary').click();assert.deepEqual(await amounts(),[yen(2050)]);assert.deepEqual(await childAmounts('食費'),[1030,1020].map(yen));
   await page.locator('#more-entries').click();assert.equal(await page.locator('#entries tr').count(),205);assert.equal(await page.locator('#entries tr').last().locator('.description').textContent(),'Sample 205');assert.deepEqual(await amounts(),[yen(2050)]);assert.notEqual(await group('食費').getAttribute('open'),null);
   if(width===390){await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#category-summary').screenshot({path:resolve(screens,`category-summary-long-${role}.png`)});}
   await page.locator('#refresh').click();assert.notEqual(await group('食費').getAttribute('open'),null);
   assert.equal(writes,0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
}
