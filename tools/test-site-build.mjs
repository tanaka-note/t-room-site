import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installArgs } from './install-verify-dependencies.mjs';

test('Cloudflare install accepts a settings-only pnpm-workspace without packages',async()=>{
  const fixture=await mkdtemp(join(tmpdir(),'tlain-site-install-'));
  try {
    await writeFile(join(fixture,'package.json'),'{"private":true}\n');
    await writeFile(join(fixture,'pnpm-lock.yaml'),"lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
    const root=fileURLToPath(new URL('../',import.meta.url));
    await cp(join(root,'pnpm-workspace.yaml'),join(fixture,'pnpm-workspace.yaml'));
    assert.doesNotMatch(await readFile(join(fixture,'pnpm-workspace.yaml'),'utf8'),/^packages:/m);
    const command=`pnpm ${installArgs.join(' ')}`;
    const shell=process.platform==='win32'?'cmd.exe':'sh';
    const result=spawnSync(shell,process.platform==='win32'?['/d','/c',command]:['-c',command],{cwd:fixture,encoding:'utf8',timeout:60000});
    assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  } finally {
    assert.equal(dirname(resolve(fixture)),resolve(tmpdir()));
    assert.match(fixture.split(/[\\/]/).at(-1),/^tlain-site-install-/);
    await rm(fixture,{recursive:true,force:true});
  }
});

test('root build creates deployable static assets from a checkout without generated assets',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const fixture=await mkdtemp(join(tmpdir(),'tlain-site-build-'));
  try {
    for(const directory of ['.well-known','apps','asset-report-k7m4q9x2','assets','columns','diary','images','learning','pagefind','transfer','tools'])await mkdir(join(fixture,directory),{recursive:true});
    await mkdir(join(fixture,'site-worker'));
    for(const path of ['package.json','web-apps.json','wrangler.jsonc','tools/prepare-static-assets.mjs','tools/web-app-registry.mjs','tools/line-browser-html.mjs','site-worker/retired-services.mjs','assets/line-browser-csp.mjs','assets/line-browser-worker.mjs','assets/line-browser-policy.mjs'])await cp(join(root,path),join(fixture,path));
    const registry=JSON.parse(await readFile(join(fixture,'web-apps.json'),'utf8'));
    for(const path of registry.apps.find(app=>app.id==='site').entrypoints){await mkdir(dirname(join(fixture,path)),{recursive:true});await cp(join(root,path),join(fixture,path));}
    await writeFile(join(fixture,'asset-report-k7m4q9x2/index.html'),'<!doctype html><html><head></head><body>fixture</body></html>');
    await cp(join(root,'site-worker/index.mjs'),join(fixture,'site-worker/index.mjs'));
    await mkdir(join(fixture,'diary/entries'));
    await writeFile(join(fixture,'diary/entries/001.html'),'<html lang="ja"><body data-pagefind-body>日記の検索確認</body></html>');
    await writeFile(join(fixture,'investment.html'),'<html><body>Archived investment</body></html>');
    await writeFile(join(fixture,'learning/index.html'),'<html><body>Archived learning</body></html>');
    await writeFile(join(fixture,'pagefind/stale-fragment'), 'Archived search data');
    await symlink(resolve(root,'node_modules'),join(fixture,'node_modules'),process.platform==='win32'?'junction':'dir');
    await writeFile(join(fixture,'pnpm-workspace.yaml'),(await readFile(join(root,'pnpm-workspace.yaml'),'utf8'))+'\nverifyDepsBeforeRun: false\n');
    spawnSync('git',['init','--quiet'],{cwd:fixture});
    // Execute the actual root build script and the same Wrangler asset preflight used by deploy.
    const shell=process.platform==='win32'?'cmd.exe':'sh';
    // Dependencies are already supplied by the fixture junction. pnpm 11 must
    // not reinstall through it or change the source checkout during this test.
    const run=command=>spawnSync(shell,process.platform==='win32'?['/d','/c',command]:['-c',command],{cwd:fixture,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    const build=run('pnpm run build');assert.equal(build.status,0,build.stdout+build.stderr);
    assert.equal((await stat(join(fixture,'.site-assets/index.html'))).isFile(),true);
    await assert.rejects(stat(join(fixture,'.site-assets/asset-report-k7m4q9x2')), {code:'ENOENT'});
    assert.equal((await stat(join(fixture,'.site-assets/pagefind/pagefind.js'))).isFile(),true);
    const search = JSON.parse(await readFile(join(fixture,'.site-assets/pagefind/pagefind-entry.json'), 'utf8'));
    assert.equal(search.languages.ja.page_count, 1);
    for (const path of ['investment.html', 'learning', 'columns', 'transfer', 'pagefind/stale-fragment']) {
      await assert.rejects(stat(join(fixture,'.site-assets',path)), {code:'ENOENT'});
    }
    const deploy=run('pnpm exec wrangler deploy --dry-run');assert.equal(deploy.status,0,deploy.stdout+deploy.stderr);
  } finally {
    assert.equal(dirname(resolve(fixture)),resolve(tmpdir()),'cleanup must remain inside the OS temporary directory');
    assert.match(fixture.split(/[\\/]/).at(-1),/^tlain-site-build-/);
    await rm(fixture,{recursive:true,force:true});
  }
});

test('retired report redirects documents, denies old data and serves only its cleanup worker', async () => {
  const {default: worker, retirementWorker} = await import('../site-worker/index.mjs');
  const request = (path, method='GET') => worker.fetch(new Request(`https://tanaka-note.com${path}`, {method}), {ASSETS:{fetch:()=>new Response('unrelated')}});
  for (const path of ['/asset-report-k7m4q9x2', '/asset-report-k7m4q9x2/?source=pwa', '/asset-report-k7m4q9x2/index.html']) {
    const response=request(path);assert.equal(response.status,308);assert.equal(response.headers.get('Location'),'/asset-report/');assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  for(const path of ['data/portfolio-data.mjs?v=old','report.js','manifest.webmanifest','icons/icon-192.png']) assert.equal(request(`/asset-report-k7m4q9x2/${path}`).status,410);
  const sw=request('/asset-report-k7m4q9x2/service-worker.js?v=old');assert.equal(sw.status,200);assert.match(sw.headers.get('Content-Type'),/javascript/);assert.equal(await sw.text(),retirementWorker);
  assert.equal(request('/asset-report-k7m4q9x2/','POST').status,405);
  assert.equal(await request('/unrelated').text(),'unrelated');
  assert.equal(await request('/asset-report-k7m4q9x2-other').text(),'unrelated');
});

test('retired service URLs return 410 and other service paths fall through', async () => {
  const { default: worker } = await import('../site-worker/index.mjs');
  const env = { ASSETS: { fetch: request => new Response(new URL(request.url).pathname) } };
  for (const path of [
    '/investment', '/investment.html?old=1', '/investment-btc-four-year-cycle',
    '/investment-performance.html', '/learning.html', '/learning/index.html',
    '/learning/sharoushi/logs/001', '/thought', '/columns/music/002.html',
    '/transfer', '/transfer/index.html', '/health/api/records', '/%6cearning/',
  ]) {
    const response = worker.fetch(new Request(`https://tanaka-note.com${path}`, { method: 'HEAD' }), env);
    assert.equal(response.status, 410, path);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    assert.equal(await response.text(), '');
  }
  for (const path of ['/', '/asset-report/', '/diary/investment/', '/learning-tools/', '/transfer-tools/']) {
    const response = worker.fetch(new Request(`https://tanaka-note.com${path}`), env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), path);
  }
});
