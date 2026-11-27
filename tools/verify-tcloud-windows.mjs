import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {readFileSync,existsSync,mkdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

if (process.platform !== 'win32') throw new Error('T-Cloud native validation requires the dedicated Windows CI job.');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (args, required = true) => {
  const result = spawnSync('dotnet', args, { cwd, stdio: 'inherit', shell: false,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  if (result.error) throw result.error;
  if (required && result.status !== 0) process.exit(result.status || 1);
  return result.status === 0;
};
run(['build', 'tcloud-windows/TCloud.Sync.slnx', '--configuration', 'Release', '-warnaserror', '--nologo']);
const nativePassed = run(['run', '--project', 'tcloud-windows/tests/TCloud.Sync.Tests/TCloud.Sync.Tests.csproj', '--configuration', 'Release', '--no-build', '--', '--native'], false);
const nativeBuild = spawnSync(process.execPath, ['tools/build-tcloud-shell-probe.mjs'], { cwd, stdio: 'inherit', shell: false });
if (nativeBuild.error) throw nativeBuild.error;
if (nativeBuild.status !== 0) process.exit(nativeBuild.status || 1);
const shellPassed = run(['run', '--project', 'tcloud-windows/tests/TCloud.Sync.Tests/TCloud.Sync.Tests.csproj', '--configuration', 'Release', '--no-build', '--', '--folder-view-probe'], false);
if (!nativePassed || !shellPassed) process.exit(1);
const packaged=spawnSync(process.execPath,['tools/build-tcloud-windows.mjs'],{cwd,stdio:'inherit',shell:false});
if(packaged.error)throw packaged.error;if(packaged.status!==0)process.exit(packaged.status||1);
const distribution=join(cwd,'tcloud-windows/artifacts/distribution');
const active=JSON.parse(readFileSync(join(distribution,'active.json'),'utf8'));
if(!/^[0-9a-f-]{36}$/.test(active.packageId))throw new Error('Invalid package build path.');
const executable=join(distribution,active.packageId,'payload/TCloud.Sync.Host.exe');
const ui=join(cwd,'tcloud-windows/artifacts/ui');mkdirSync(ui,{recursive:true});
for (const view of ['login', 'sync-status']) {
  const screenshot = join(ui, view + '-' + randomUUID() + '.png');
  const smoke = spawnSync(executable, ['--render-' + view, screenshot], { cwd, stdio: 'inherit', shell: false });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0 || !existsSync(screenshot) || statSync(screenshot).size < 1000) throw new Error('Self-contained UI smoke failed: ' + view);
  console.log('PASS self-contained UI smoke: ' + view);
}
