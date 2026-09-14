import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { root, targets, services, commands, affected, changedFiles, browserTests, installDirectories } from './verify-plan.mjs';

const argv = process.argv.slice(2).filter(a => a !== '--');
const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const selected = argv.includes('--changed') ? affected(changedFiles(value('--base'), value('--head'))) : value('--target') ? [value('--target')] : targets;
for (const t of selected) if (!targets.includes(t)) throw new Error(`Unknown target: ${t}`);
const plan = { targets: selected, install: installDirectories(selected), browser: selected.filter(t => browserTests(t).length),
  commands: selected.flatMap(t => commands(t).map(c => ({ target: t, ...c }))) };
if (argv.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
  if (value('--output')) writeFileSync(value('--output'), JSON.stringify(plan));
  process.exit(0);
}
function run(command, args, cwd = root, env = process.env, capture = false) {
  console.log(`[verify] ${basename(cwd)}: ${command === process.execPath ? 'node' : command} ${args.join(' ')}`);
  const r = spawnSync(command, args, { cwd, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: false });
  if (capture) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); }
  if (r.error) throw r.error;
  return r;
}
for (const t of selected) {
  for (const c of commands(t)) {
    const cwd = resolve(root, c.cwd);
    const command = c.gradle ? (process.platform === 'win32' ? 'cmd.exe' : 'sh') : c.script ? (process.platform === 'win32' ? 'cmd.exe' : 'npm') : process.execPath;
    const args = c.gradle ? (process.platform === 'win32' ? ['/d', '/c', 'gradlew.bat', ...c.args] : ['gradlew', ...c.args])
      : c.script ? (process.platform === 'win32' ? ['/d', '/c', 'npm', 'run', c.script] : ['run', c.script]) : c.args;
    if (run(command, args, cwd).status !== 0) process.exit(1);
  }
  if (argv.includes('--browser')) for (const script of browserTests(t)) {
    const scratch = mkdtempSync(join(tmpdir(), 't-lain-browser-'));
    try {
      const path = resolve(root, script);
      const r = run(process.execPath, ['--require', resolve(root, 'tools/browser-trace.cjs'), path], script.startsWith('tools/') ? root : resolve(root, script.split('/')[0]),
        { ...process.env, TROOM_BROWSER: process.env.TROOM_BROWSER || 'chromium', TROOM_TRACE_DIR: scratch }, true);
      if (r.status !== 0) {
        const dest = resolve(root, 'tmp/verify-artifacts', basename(script)); mkdirSync(dest, { recursive: true });
        cpSync(scratch, dest, { recursive: true });
        writeFileSync(join(dest, 'failure.log'), `${r.stdout || ''}\n${r.stderr || ''}`);
        console.error(`Failure artifacts: ${dest}`); process.exitCode = 1;
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    if (process.exitCode) process.exit(process.exitCode);
  }
  if (argv.includes('--build') && (services.includes(t) || t === 'site')) {
    if (t === 'site' && run(process.execPath, ['tools/prepare-static-assets.mjs']).status !== 0) process.exit(1);
    const cwd = t === 'site' ? root : resolve(root, `${t}-worker`);
    const cli = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
    if (!existsSync(cli)) throw new Error(`Install dependencies in ${cwd}`);
    // Wrangler dry-run bundles the Worker only; it does not build/deploy Container images.
    if (run(process.execPath, [cli, 'deploy', '--dry-run'], cwd).status !== 0) process.exit(1);
  }
}
console.log(`[verify] passed: ${selected.join(', ') || 'no executable changes'}`);
