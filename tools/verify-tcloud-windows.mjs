import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('T-Cloud native validation requires the dedicated Windows CI job.');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = args => {
  const result = spawnSync('dotnet', args, { cwd, stdio: 'inherit', shell: false,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
run(['build', 'tcloud-windows/TCloud.Sync.slnx', '--configuration', 'Release', '-warnaserror', '--nologo']);
run(['run', '--project', 'tcloud-windows/tests/TCloud.Sync.Tests/TCloud.Sync.Tests.csproj', '--configuration', 'Release', '--no-build', '--', '--native']);
