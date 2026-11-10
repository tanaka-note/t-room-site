import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function verifyCategoryManagement(browser,url,owner,chooseDate,screens){
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:950},...(width<700?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ordinary=`会食検証${width}`,removable=`手土産検証${width}`,renamed=`贈答検証${width}`,other=`その他会食検証${width}`;
  try{
   await page.goto(url+'#settings');await page.locator('#app-view').waitFor({state:'visible'});
   assert.equal(await page.locator('[name=archived]').count(),0);
   for(const name of [ordinary,other,removable]){
    await page.locator('#category-parent').selectOption('交際費');await page.locator('#category-form [name=name]').fill(name);
    await page.locator('#category-form [type=submit]').click();await page.locator('#categories').getByText(name,{exact:true}).waitFor({state:'visible'});
   }
   const group=page.locator('.category-group').filter({has:page.locator('strong',{hasText:'交際費'})});
   const names=()=>group.locator('.category-chip').allTextContents();
   let labels=await names();assert.ok(labels.indexOf(ordinary)<labels.indexOf('その他交際費'));assert.ok(labels.indexOf(removable)<labels.indexOf('その他交際費'));
   assert.equal(await page.locator('#categories button').count(),0);assert.equal(await page.locator('#categories .danger').count(),0);
   await page.reload();await page.locator('#categories').getByText(ordinary,{exact:true}).waitFor({state:'visible'});assert.equal(await page.locator('#categories button').count(),0);
   await group.screenshot({path:resolve(screens,`categories-normal-${width}.png`)});
   await page.locator('#edit-categories').click();assert.equal(await page.locator('#edit-categories').getAttribute('aria-pressed'),'true');
   assert.equal(await group.getByRole('button',{name:'その他交際費を編集',exact:true}).count(),0);
   await group.getByRole('button',{name:`${removable}を編集`,exact:true}).click();
   const dialog=page.locator('#category-edit-dialog'),nameField=page.locator('#category-edit-form [name=name]');
   await nameField.fill(renamed);await page.keyboard.press('Escape');await page.locator('#confirm-dialog').waitFor({state:'visible'});
   await page.locator('#confirm-cancel').click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(await nameField.inputValue(),renamed);
   await page.locator('#category-edit-form [type=submit]').click();await dialog.waitFor({state:'hidden'});await group.getByRole('button',{name:`${renamed}を編集`,exact:true}).waitFor({state:'visible'});
   assert.equal(await group.getByRole('button',{name:`${renamed}を編集`,exact:true}).evaluate(n=>document.activeElement===n),true);
   await group.getByRole('button',{name:`${renamed}を編集`,exact:true}).click();await page.locator('#category-delete').click();await page.locator('#confirm-dialog').waitFor({state:'visible'});
   await page.goBack();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(await dialog.isVisible(),true);assert.equal(await nameField.inputValue(),renamed);
   await page.locator('#category-delete').click();await page.locator('#confirm-dialog').waitFor({state:'visible'});await page.locator('#confirm-ok').click();await dialog.waitFor({state:'hidden'});
   assert.equal((await owner.state()).data.categories.some(c=>c.name===renamed),false);
   assert.equal(await page.locator('#edit-categories').evaluate(n=>document.activeElement===n),true);
   const state=await owner.state(),category=(parent,name)=>state.data.categories.find(c=>c.parent===parent&&c.name===name);
   const used=category('交際費',ordinary);
   for(const [c,amount] of [[used,100],[category('交際費','その他交際費'),100000],[category('交際費',other),1000],[category('その他','雑費'),200000]]){
    assert.equal((await owner.mutate('transaction.save',{id:crypto.randomUUID(),date:'2026-09-15',type:'expense',categoryId:c.id,amount,description:'Category ordering fixture'})).status,200);
   }
   await page.locator('#refresh').click();await group.getByRole('button',{name:`${ordinary}を編集`,exact:true}).click();
   assert.equal(await page.locator('#category-delete').isDisabled(),true);assert.match(await page.locator('#category-delete-reason').textContent(),/使用中/);
   // A failed save must not re-enable deletion of a used category.
   await nameField.fill('その他交際費');await page.locator('#category-edit-form [type=submit]').click();await page.locator('#category-edit-error').getByText('同じ分類が登録されています。',{exact:true}).waitFor({state:'visible'});
   assert.equal(await page.locator('#category-delete').isDisabled(),true);
   await page.keyboard.press('Escape');await page.locator('#confirm-dialog').waitFor({state:'visible'});await page.locator('#confirm-ok').click();await dialog.waitFor({state:'hidden'});
   await group.getByRole('button',{name:`${ordinary}を編集`,exact:true}).click();
   await dialog.screenshot({path:resolve(screens,`category-used-${width}.png`)});
   await page.mouse.click(2,2);await dialog.waitFor({state:'hidden'});
   await page.locator('#edit-categories').click();assert.equal(await page.locator('#categories button').count(),0);
   await page.locator('[data-view=transactions]').click();await page.locator('#add-entry').click();await page.locator('#entry-parent').selectOption('交際費');
   labels=await page.locator('#entry-form [name=categoryId] option').allTextContents();const firstOther=labels.findIndex(name=>name.startsWith('その他'));
   assert.ok(labels.indexOf(ordinary)<firstOther);assert.ok(labels.slice(firstOther).every(name=>name.startsWith('その他')));
   await page.locator('#entry-dialog [data-close]').first().click();await page.locator('#confirm-dialog').waitFor({state:'visible'});await page.locator('#confirm-ok').click();await page.locator('#entry-dialog').waitFor({state:'hidden'});
   await chooseDate(page,'period','2026-09');
   const summary=page.locator('.category-summary-group[data-type=expense]'),parents=await summary.locator('.category-stat>summary>.category-label').allTextContents();
   assert.equal(parents.at(-1),'その他');
   const social=summary.locator('.category-stat[data-category="交際費"]');await social.locator('summary').click();
   const children=await social.locator('.category-breakdown>li>.category-label').allTextContents(),firstOtherChild=children.findIndex(name=>name.startsWith('その他'));
   assert.ok(children.indexOf(ordinary)<firstOtherChild);assert.ok(children.slice(firstOtherChild).every(name=>name.startsWith('その他')));
   await page.locator('[data-view=settings]').click();
   if(width<700)await page.setViewportSize({width:320,height:950});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.locator('#edit-categories').click();await group.getByRole('button',{name:`${ordinary}を編集`,exact:true}).click();
   // Session clearing must also discard the new category editor and editing mode.
   await page.evaluate(()=>dispatchEvent(new Event('troom-session-expired')));await page.locator('#login-view').waitFor({state:'visible'});
   assert.equal(await dialog.isVisible(),false);assert.equal(await nameField.inputValue(),'');assert.equal(await page.locator('#edit-categories').getAttribute('aria-pressed'),'false');
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 const context=await browser.newContext({extraHTTPHeaders:{'X-Fixture-Role':'viewer'}}),page=await context.newPage();
 try{
  await page.goto(url+'#settings');await page.locator('#app-view').waitFor({state:'visible'});
  assert.equal(await page.locator('#edit-categories').isVisible(),false);assert.equal(await page.locator('#categories button').count(),0);
 }finally{await context.close();}
}
