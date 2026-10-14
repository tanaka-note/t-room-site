import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runtime-only personal data comes from stdin. Commands and errors never echo it.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const cli = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
const run = (args, input) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('Inventory setup command failed; inspect configuration without exposing credentials.');
  return result.stdout;
};
if (!process.argv.includes('--remote')) throw new Error('Explicit --remote is required for production bootstrap.');
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw new Error('Setup input too large.'); }
const { displayName } = JSON.parse(input);
if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) throw new Error('Invalid account display name.');
const secrets = JSON.parse(run(['secret', 'list']));
if (!secrets.some(s => s.name === 'SESSION_SECRET')) run(['secret', 'put', 'SESSION_SECRET'], randomBytes(32).toString('hex') + '\n');
const directory = mkdtempSync(resolve(tmpdir(), 'inventory-bootstrap-'));
try {
  const path = resolve(directory, 'bootstrap.sql');
  // One fixed account, no automatic Identity or passkey grant, no overwrite.
  writeFileSync(path, `INSERT INTO inventory_accounts (id, display_name) VALUES ('owner', '${displayName.trim().replaceAll("'", "''")}') ON CONFLICT(id) DO NOTHING;`, { mode: 0o600 });
  run(['d1', 'execute', 'inventory-db', '--remote', '--file', path, '--yes']);
  console.log('Inventory owner initialized; personal data and session secret were not printed.');
} finally {
  const target = realpathSync(directory), parent = realpathSync(tmpdir());
  if (!target.toLowerCase().startsWith((parent + sep).toLowerCase())) throw new Error('Temporary cleanup target is outside the intended directory.');
  rmSync(target, { recursive: true, force: true });
}
