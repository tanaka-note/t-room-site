import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { root, services } from './verify-plan.mjs';

export function localConfig(service, source) {
  if (!services.includes(service) || service === 'downloader') throw new Error('Use the existing Downloader fixtures; Containers are not started here.');
  // Allowlist instead of copying bindings/remote flags, secrets, routes or cron.
  return { name: `t-lain-local-${service}`, main: resolve(root, `${service}-worker`, source.main),
    compatibility_date: source.compatibility_date, compatibility_flags: source.compatibility_flags,
    ...(source.assets ? { assets: { ...source.assets, directory: resolve(root, `${service}-worker`, source.assets.directory) } } : {}),
    d1_databases: (source.d1_databases || []).map(d => ({ binding: d.binding, database_name: `local-${service}`, database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: resolve(root, `${service}-worker`, d.migrations_dir || 'migrations') })),
    r2_buckets: (source.r2_buckets || []).map(b => ({ binding: b.binding, bucket_name: `local-${service}-${b.binding.toLowerCase()}` })) };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'tools/local-dev.mjs')) {
  const [service, action = 'dev'] = process.argv.slice(2);
  if (!['dev', 'migrate'].includes(action)) throw new Error('Usage: node tools/local-dev.mjs cloud|security|diary|billing|ai dev|migrate');
  const cwd = resolve(root, `${service}-worker`);
  const source = JSON.parse(readFileSync(resolve(cwd, 'wrangler.jsonc'), 'utf8'));
  const config = localConfig(service, source);
  const dir = resolve(root, 'tmp/local-dev', service); mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'wrangler.json'); writeFileSync(path, JSON.stringify(config, null, 2));
  // Generated local-only secrets are never copied from production or committed.
  if (!existsSync(resolve(dir, '.dev.vars'))) writeFileSync(resolve(dir, '.dev.vars'), `SESSION_SECRET=${randomBytes(32).toString('hex')}\n`);
  const cli = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const args = action === 'migrate' ? ['d1', 'migrations', 'apply', 'DB', '--local'] : ['dev', '--local', '--ip', '127.0.0.1'];
  const r = spawnSync(process.execPath, [cli, ...args, '--config', path, '--persist-to', resolve(dir, 'state')], { cwd: dir, stdio: 'inherit' });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}
