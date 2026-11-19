import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The synthetic Shell probe requires Windows x64.');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'tcloud-windows/tests/native-shell');
const artifacts = join(root, 'tcloud-windows/artifacts/native-shell');
const inputs = ['probe-folder.cpp', 'exports.def', 'view-host.cpp', 'CMakeLists.txt'];
const hash = createHash('sha256');
for (const input of inputs) hash.update(input).update(readFileSync(join(source, input)));
hash.update(readFileSync(join(root,'tcloud-windows/src/TCloud.ShellExtension/folder.cpp')));
hash.update(readFileSync(fileURLToPath(import.meta.url)));
const buildId = hash.digest('hex');
const output = join(artifacts, buildId);
mkdirSync(output, { recursive: true });
const invoke = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native Shell probe build failed.');
};
if (!['TCloud.ShellProbe.dll', 'TCloud.ShellExtension.dll', 'TCloud.ShellViewHost.exe'].every(file => existsSync(join(output, file)))) {
  // An optional, locally provisioned official Zig distribution avoids global installation.
  // Nothing is downloaded or installed by this script. Windows CI uses its installed MSVC.
  const toolchains = join(root, 'tcloud-windows/artifacts/native-toolchain');
  const zig = existsSync(toolchains) ? readdirSync(toolchains)
    .filter(name => /^zig-x86_64-windows-[\d.]+$/.test(name))
    .map(name => join(toolchains, name, 'zig.exe')).find(path => existsSync(path)) : undefined;
  if (zig) {
    const common = ['c++', '-std=c++20', '-O2', '-target', 'x86_64-windows-gnu', '-DUNICODE', '-D_UNICODE', '-Wall', '-Wextra', '-Werror'];
    const libraries = ['-lshell32', '-lshlwapi', '-lole32', '-luuid', '-luser32', '-lcomctl32'];
    invoke(zig, [...common, join(source, 'probe-folder.cpp'), join(source, 'exports.def'), '-shared', '-o', join(output, 'TCloud.ShellProbe.dll'), ...libraries]);
    invoke(zig, [...common, join(root,'tcloud-windows/src/TCloud.ShellExtension/folder.cpp'), join(source,'exports.def'), '-shared', '-o', join(output,'TCloud.ShellExtension.dll'), ...libraries]);
    invoke(zig, [...common, join(source, 'view-host.cpp'), '-municode', '-Wl,--subsystem,windows', '-o', join(output, 'TCloud.ShellViewHost.exe'), ...libraries]);
  } else {
    const build = join(output, 'build');
    invoke('cmake', ['-S', source, '-B', build, '-A', 'x64', `-DTCLOUD_OUTPUT=${output.replaceAll('\\', '/')}`]);
    invoke('cmake', ['--build', build, '--config', 'Release']);
  }
}
const manifest = join(artifacts, 'active.json');
const staging = join(dirname(manifest), `active-${process.pid}.pending`);
writeFileSync(staging, JSON.stringify({ buildId }));
renameSync(staging, manifest);
console.log('Built isolated native Shell probe: ' + buildId.slice(0, 12));
