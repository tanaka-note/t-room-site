import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
