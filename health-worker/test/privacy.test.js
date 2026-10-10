import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('public Health and Security HTML does not disclose participant names',()=>{
  for(const path of ['../public/index.html','../../security-worker/public/health.html','../../security-worker/public/index.html']){
    const html=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.doesNotMatch(html,/田中暢美|田中宏知|暢美さん|宏知さん/,path);
  }
});
test('Health login is limited to the service title and passkey login; private service is not on the public index',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const login=html.match(/<section id="login"[^>]*>([\s\S]*?)<\/section>/)[1];
  assert.match(html,/<h1>体調管理<\/h1>/);assert.match(login,/パスキーでログイン/);
  assert.doesNotMatch(login,/生理|周期|備考|復旧|<p|<a/);
  const index=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(index,/href=["'](?:\.\/|\/)health\//);
});
