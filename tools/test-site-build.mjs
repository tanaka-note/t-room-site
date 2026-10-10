import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('root build creates deployable static assets from a checkout without generated assets',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const fixture=await mkdtemp(join(tmpdir(),'tlain-site-build-'));
  try {
    for(const directory of ['.well-known','apps','asset-report-k7m4q9x2','assets','columns','diary','images','learning','pagefind','transfer','tools'])await mkdir(join(fixture,directory),{recursive:true});
    for(const path of ['package.json','web-apps.json','wrangler.jsonc','tools/prepare-static-assets.mjs','tools/web-app-registry.mjs','tools/line-browser-html.mjs','assets/line-browser-csp.mjs','assets/line-browser-worker.mjs','assets/line-browser-policy.mjs'])await cp(join(root,path),join(fixture,path));
    const registry=JSON.parse(await readFile(join(fixture,'web-apps.json'),'utf8'));
    for(const path of registry.apps.find(app=>app.id==='site').entrypoints){await mkdir(dirname(join(fixture,path)),{recursive:true});await cp(join(root,path),join(fixture,path));}
    await writeFile(join(fixture,'asset-report-k7m4q9x2/index.html'),'<!doctype html><html><head></head><body>fixture</body></html>');
    await mkdir(join(fixture,'site-worker'));await cp(join(root,'site-worker/index.mjs'),join(fixture,'site-worker/index.mjs'));
    await symlink(resolve(root,'node_modules'),join(fixture,'node_modules'),process.platform==='win32'?'junction':'dir');
    spawnSync('git',['init','--quiet'],{cwd:fixture});
    // Execute the actual root build script and the same Wrangler asset preflight used by deploy.
    const shell=process.platform==='win32'?'cmd.exe':'sh';
    const run=command=>spawnSync(shell,process.platform==='win32'?['/d','/c',command]:['-c',command],{cwd:fixture,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    const build=run('pnpm run build');assert.equal(build.status,0,build.stdout+build.stderr);
    assert.equal((await stat(join(fixture,'.site-assets/index.html'))).isFile(),true);
    assert.equal((await stat(join(fixture,'.site-assets/pagefind/pagefind.js'))).isFile(),true);
    const deploy=run('pnpm exec wrangler deploy --dry-run');assert.equal(deploy.status,0,deploy.stdout+deploy.stderr);
  } finally {
    assert.equal(dirname(resolve(fixture)),resolve(tmpdir()),'cleanup must remain inside the OS temporary directory');
    assert.match(fixture.split(/[\\/]/).at(-1),/^tlain-site-build-/);
    await rm(fixture,{recursive:true,force:true});
  }
});
