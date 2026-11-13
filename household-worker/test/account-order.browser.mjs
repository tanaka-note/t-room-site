import assert from 'node:assert/strict';
import {mutateData} from '../src/domain.js';

export async function verifyAccountOrder(browser,url,initial,chooseDate){
 for(const role of ['owner','viewer'])for(const width of [1440,390]){
  const state=structuredClone(initial);
  const account=(name,amounts)=>{
   const items=amounts.map((amount,i)=>({id:crypto.randomUUID(),name:`Item ${i+1}`,amount}));
   return {id:crypto.randomUUID(),name,type:'bank',items,balances:[{date:'2026-09-28',items:structuredClone(items)}]};
  };
  state.data.accounts=[account('Debt',[-100000]),account('Small',[100]),account('Zero',[0]),account('Large',[9000,-1000]),account('Tie',[100]),account('Near zero',[-10])];
  const original=structuredClone(state.data.accounts),originalIds=original.map(a=>a.id),transactions=structuredClone(state.data.transactions);
  const context=await browser.newContext({viewport:{width,height:900},extraHTTPHeaders:{'X-Fixture-Role':role},...(width<700?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();
  try{
   const errors=[];page.on('pageerror',e=>errors.push(e.message));let writes=0;
   await page.route('**/household/api/data',route=>route.fulfill({json:state}));
   await page.route('**/household/api/mutate',async route=>{
    writes++;
    const body=route.request().postDataJSON();assert.equal(role,'owner');assert.equal(body.operation,'account.save');assert.equal(body.expectedRevision,state.revision);
    state.data=mutateData(state.data,body.operation,body.value);state.revision++;
    await route.fulfill({json:{revision:state.revision}});
   });
   await page.goto(url+'#accounts');await page.locator('#app-view').waitFor({state:'visible'});
   const names=()=>page.locator('#accounts .account-card h3').allTextContents();
   const expected=['Large','Small','Tie','Zero','Near zero','Debt'];
   assert.deepEqual(await names(),expected);
   assert.equal((await page.locator('#current-assets').textContent()).normalize('NFKC'),new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(-91810).normalize('NFKC'));
   assert.deepEqual(state.data.accounts,original);assert.equal(writes,0);
   await page.reload();await page.locator('#app-view').waitFor({state:'visible'});assert.deepEqual(await names(),expected);
   if(role==='owner'){
    const small=page.locator('#accounts .account-card').filter({has:page.getByRole('heading',{name:'Small',exact:true})});
    const save=async(amount,date)=>{
     await small.getByRole('button',{name:'編集',exact:true}).click();
     if(date)await chooseDate(page,'balance-as-of',date);
     await page.locator('#account-items [data-field=amount]').fill(String(amount));
     await page.locator('#account-form [type=submit]').click();await page.locator('#account-dialog').waitFor({state:'hidden'});
    };
    await save(20000);assert.deepEqual(await names(),['Small','Large','Tie','Zero','Near zero','Debt']);
    // An older record must not replace the latest balance or its display position.
    await save(-200000,'2026-09-01');assert.deepEqual(await names(),['Small','Large','Tie','Zero','Near zero','Debt']);
    await save(-200000);assert.deepEqual(await names(),['Large','Tie','Zero','Near zero','Debt','Small']);
    // Reload after dialog history traversal crashes macOS WebKit itself. A fresh
    // document still re-fetches saved balances using the same browser session.
    await page.goto('about:blank');await page.goto(url+'#accounts');await page.locator('#app-view').waitFor({state:'visible'});assert.deepEqual(await names(),['Large','Tie','Zero','Near zero','Debt','Small']);
    assert.deepEqual(state.data.accounts.map(a=>a.id),originalIds);
    for(const a of original.filter(a=>a.name!=='Small'))assert.deepEqual(state.data.accounts.find(row=>row.id===a.id),a);
    assert.deepEqual(state.data.transactions,transactions);assert.equal(writes,3);
   }else{
    assert.equal(await page.locator('#accounts button').count(),0);
    // Refresh picks up a balance changed by the owner for read-only users too.
    state.data.accounts[1].items[0].amount=20000;
    await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#accounts h3')?.textContent==='Small');
    assert.deepEqual(await names(),['Small','Large','Tie','Zero','Near zero','Debt']);assert.equal(writes,0);
   }
   state.data.accounts=[];await page.locator('#refresh').click();await page.locator('#empty-accounts').waitFor({state:'visible'});assert.deepEqual(await names(),[]);
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
}
