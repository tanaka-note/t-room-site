import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from './verify-plan.mjs';

// CI verifies generated release artifacts, never edits the developer's build
// markers. Production release separately requires committed markers to match.
const scratch = mkdtempSync(resolve(tmpdir(), 't-lain-web-contract-'));
try {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of new Set(paths)) {
    const from = resolve(root, path), to = resolve(scratch, path);
    if (relative(scratch, to).startsWith('..')) throw new Error('Invalid snapshot path');
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to);
  }
  const git = args => execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
  git(['init', '--quiet']); git(['-c', 'core.autocrlf=false', 'add', '.']);
  git(['-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Local generated artifact fixture']);
  execFileSync(process.execPath, ['tools/sync-web-app-builds.mjs'], { cwd: scratch, stdio: 'inherit' });
  const script = JSON.parse(readFileSync(resolve(scratch, 'package.json'), 'utf8')).scripts['web-apps:test'];
  for (const command of script.split(' && ')) {
    if (!/^node tools\/[\w-]+\.mjs$/.test(command)) throw new Error('Review changed web-apps:test command before executing it in the fixture');
    execFileSync(process.execPath, [command.slice(5)], { cwd: scratch, stdio: 'inherit' });
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
