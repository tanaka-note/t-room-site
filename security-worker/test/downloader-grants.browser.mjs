import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(`${process.env.PLAYWRIGHT_PACKAGE}/index.mjs`));
const source=readFileSync(new URL('../public/security.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  function addLinkRow('),source.indexOf('  async function freshAdminAuthentication('));
const keyFunction=source.slice(source.indexOf('  function serviceLinkKey('),source.indexOf('  function openDetailLinkEditor('));
const css=readFileSync(new URL('../public/security.css',import.meta.url),'utf8');
const services=[{id:'diary',displayName:'日記',targets:[{service:'diary',accountId:'main-user',displayLabel:'田中宏知（一般ユーザー）'}]},{id:'downloader',displayName:'T-lain Downloader',targets:[{service:'downloader',accountId:'owner',displayLabel:'T-lain Downloader 管理者',privileged:true}]}];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:844}});
 await page.route('**/*',route=>route.abort());
 await page.setContent(`<style>${css}</style><main><section><h2>ユーザーを招待</h2><div id="link-rows"></div></section><section><h2>サービス連携を追加</h2><div id="detail-link-row"></div></section></main>`);
 await page.addScriptTag({content:`const state={services:${JSON.stringify(services)}};const $=s=>document.querySelector(s);${keyFunction}${functions};addLinkRow();addLinkRow(null,'#detail-link-row',false);`});
 assert.deepEqual(await page.locator('#link-rows [data-link-service] option').allTextContents(),['サービスを選択','日記']);
 assert.deepEqual(await page.locator('#detail-link-row [data-link-service] option').allTextContents(),['サービスを選択','日記','T-lain Downloader']);
 assert.equal(await page.locator('#detail-link-row [data-link-service]').inputValue(),'');
 await page.locator('#detail-link-row [data-link-service]').selectOption('downloader');
 assert.equal(await page.locator('#detail-link-row [data-link-target]').inputValue(),'');
 assert.equal(await page.evaluate(()=>selectedLink(document.querySelector('#detail-link-row .link-row'))),null);
 await page.locator('#detail-link-row [data-link-target]').selectOption('0');
 assert.deepEqual(await page.evaluate(()=>linkPayload(selectedLink(document.querySelector('#detail-link-row .link-row')))),{service:'downloader',accountId:'owner',rootFolderId:null});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log(`Downloader explicit selector: ${width}px passed`);await page.close();
}}finally{await browser.close()}
