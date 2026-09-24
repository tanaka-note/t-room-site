import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, installDirectories, targets } from './verify-plan.mjs';

export const installArgs = ['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--config.strict-dep-builds=false'];

export function dependencyInstallPlan(selected, workspace = root) {
  for (const target of selected) if (!targets.includes(target)) throw new Error(`Unknown verify target: ${target}`);
  return installDirectories(selected).map(directory => ({
    directory,
    cwd: resolve(workspace, directory),
    args: [...installArgs]
  }));
}

export function installVerifyDependencies(selected) {
  for (const step of dependencyInstallPlan(selected)) {
    if (!existsSync(resolve(step.cwd, 'package.json')) || !existsSync(resolve(step.cwd, 'pnpm-lock.yaml'))) {
      throw new Error(`Dependency manifest or lockfile is missing in ${step.directory}`);
    }
    console.log(`[install] ${step.directory}: pnpm ${step.args.join(' ')}`);
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', 'pnpm', ...step.args], { cwd: step.cwd, stdio: 'inherit', shell: false })
      : spawnSync('pnpm', step.args, { cwd: step.cwd, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Dependency install failed in ${step.directory} (${result.status})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'tools/install-verify-dependencies.mjs')) {
  const selected = process.argv.slice(2);
  if (!selected.length) throw new Error('Usage: install-verify-dependencies.mjs <verify target> [...]');
  installVerifyDependencies(selected);
}
