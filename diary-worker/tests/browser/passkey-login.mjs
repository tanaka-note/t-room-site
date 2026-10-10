import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdir, readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {extname, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

// Shipped page, CSS, startup/login handlers and account chooser; synthetic RPC only.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicRoot = resolve(root, "diary-worker/public");
const requests = [];
const session = {authenticated:true, role:"user", accountName:"テスト利用者", accountDisplayName:"テスト利用者（一般ユーザー）",
  householdId:"fixture-household", activeHouseholdId:"fixture-household", canManageEntries:false,
  canViewTrash:false, canPermanentlyDelete:false, canViewInvestment:false, mustChangePassword:false};
const browserFixture = `
  window.TRoomPasskeys = {...TRoomPasskeys, authenticate: async (service, choose) => {
    if(service !== "diary") throw Error("Wrong service");
    if(window.fixtureFailure) {const message=window.fixtureFailure; window.fixtureFailure=null; throw Error(message);}
    const selected=await choose([
      {id:"admin-link",accountId:"main-admin",accountDisplayName:"テスト管理者",roleLabel:"管理者"},
      {id:"user-link",accountId:"main-user",accountDisplayName:"テスト利用者",roleLabel:"一般ユーザー"}
    ]);
    if(!selected) throw Error("パスキー認証をキャンセルしました。");
    return {handoff:{handoffToken:"fixture-"+selected.accountId}};
  }};`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1");
  const json=(body,status=200)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(body));};
  try {
    if(url.pathname.startsWith("/diary/api/")) {
      requests.push(url.pathname);
      if(url.pathname.endsWith("/session")) return json(req.headers.cookie?.includes("fixture-session=1") ? session : {authenticated:false});
      if(url.pathname.endsWith("/passkey/handoff")) {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks).toString());
        if(body.handoffToken!=="fixture-main-user") return json({error:"Unexpected account choice"},403);
        res.setHeader("Set-Cookie","fixture-session=1; Path=/diary; HttpOnly; SameSite=Strict");
        return json(session);
      }
      if(url.pathname.endsWith("/logout")) {res.setHeader("Set-Cookie","fixture-session=; Path=/diary; Max-Age=0");return json({ok:true});}
      if(url.pathname.endsWith("/meta")) return json({draftCount:0,months:[],tags:[]});
      if(url.pathname.endsWith("/entries")) return json({entries:[],hasMore:false});
      return json({error:"Unexpected API"},404);
    }
    let path;
    if(url.pathname==="/assets/pwa-auto-update.js") path=resolve(root,"assets/pwa-auto-update.js");
    else if(url.pathname==="/security/passkey-client.js") path=resolve(root,"security-worker/public/passkey-client.js");
    else if(url.pathname.startsWith("/diary/")) {
      path=resolve(publicRoot,url.pathname==="/diary/"?"index.html":url.pathname.slice(7));
      if(!path.startsWith(publicRoot+sep)) throw Error("Invalid asset");
    } else throw Error("Unknown asset");
    let content=await readFile(path);
    if(url.pathname==="/security/passkey-client.js") content=Buffer.concat([content,Buffer.from(browserFixture)]);
    res.writeHead(200,{"Content-Type":({".js":"text/javascript",".html":"text/html",".css":"text/css",".png":"image/png",".webmanifest":"application/manifest+json"})[extname(path)]||"application/octet-stream"});
    res.end(content);
  } catch {res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const origin=`http://127.0.0.1:${server.address().port}`;
const executablePath=process.env.TROOM_CHROMIUM_EXECUTABLE||[chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath});
  for(const [name,viewport] of [["desktop",{width:1440,height:900}],["mobile",{width:390,height:844}],["small-mobile",{width:320,height:640}]]) {
    const context=await browser.newContext({viewport,isMobile:name!=="desktop",hasTouch:name!=="desktop",serviceWorkers:"block"});
    context.setDefaultTimeout(10000);
    const page=await context.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`${origin}/diary/`);
    const button=page.locator("#passkey-login");
    await button.waitFor({state:"visible"});
    await page.waitForFunction(()=>document.activeElement?.id==="passkey-login");
    assert.equal(await page.locator('#login-view input, #initial-password-dialog, #login-form').count(),0);
    const geometry=await page.evaluate(()=>{
      const b=document.querySelector("#passkey-login").getBoundingClientRect();
      const c=document.querySelector("#login-view .login-card").getBoundingClientRect();
      return {button:{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom},
        card:{x:c.x,width:c.width},width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(geometry.overflow,false,name);
    assert.ok(geometry.button.height>=52&&geometry.button.width>=180,name);
    assert.ok(geometry.button.x>=24&&geometry.button.right<=geometry.width-24,name);
    assert.ok(geometry.button.y>=0&&geometry.button.bottom<=geometry.height,name);
    assert.ok(Math.abs(geometry.card.x+geometry.card.width/2-geometry.width/2)<1,name);
    if(process.env.TROOM_LOGIN_SCREENSHOTS&&name!=="small-mobile") {
      await mkdir(resolve(root,"tmp"),{recursive:true});
      await page.screenshot({path:resolve(root,`tmp/diary-passkey-login-${name}.png`),fullPage:true});
    }
    // Shared-client fallback text must not advise Diary password login.
    await page.evaluate(()=>{window.fixtureFailure="このブラウザではパスキーを使えません。ID・パスワードをご利用ください。";});
    await button.click();
    await page.waitForFunction(()=>document.querySelector("#login-message").textContent.includes("管理者へ"));
    assert.doesNotMatch(await page.locator("#login-message").innerText(),/ID・パスワード/);
    assert.equal(await button.isEnabled(),true);
    await button.click();
    console.log(`${name}: fallback checked; opening account chooser`);
    await page.locator(".troom-passkey-account-dialog").waitFor({state:"visible"});
    await page.locator(".troom-passkey-account-cancel").click();
    await page.waitForFunction(()=>document.querySelector("#login-message").textContent.includes("キャンセル"));
    assert.equal(await button.isEnabled(),true);
    assert.equal(await button.innerText(),"パスキーでログイン");
    await button.click();
    console.log(`${name}: cancellation checked; signing in`);
    await page.locator(".troom-passkey-account-list button").nth(1).click();
    await page.locator("#app-view").waitFor({state:"visible"});
    assert.equal(await page.locator("#login-view").isVisible(),false);
    assert.equal(await page.locator("#new-entry-button").isVisible(),false,"read-only account stays read-only");
    await page.reload();
    await page.locator("#app-view").waitFor({state:"visible"});
    await page.locator("#logout-button").click();
    await button.waitFor({state:"visible"});
    assert.deepEqual(errors,[],name);
    await context.close();
    console.log(`${name}: passkey-only layout, cancellation/retry, account choice, session resume and logout passed`);
  }
  assert.ok(requests.includes("/diary/api/passkey/handoff"));
  assert.ok(!requests.some(p=>/\/api\/(login|password\/initial)$/.test(p)),"shipped page never sends passwords");
} finally {await browser?.close();await new Promise(done=>server.close(done));}
