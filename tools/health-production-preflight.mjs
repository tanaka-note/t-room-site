import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Only secret names are queried. Values are never fetched or printed.
export function healthSecretNames(directory) {
  try {
    const result = execFileSync(process.execPath, [resolve(directory, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'list', '--config', 'wrangler.jsonc'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    const secrets = JSON.parse(result);
    if (!Array.isArray(secrets) || secrets.some(secret => typeof secret?.name !== 'string')) throw new Error();
    return secrets.map(secret => secret.name);
  } catch {
    throw new Error('Health preflight could not verify Secret names; deployment stopped.');
  }
}

export function assertHealthProductionReady(config, getSecretNames) {
  const database = config.d1_databases?.find(binding => binding.binding === 'DB');
  if (!database || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database.database_id || '') || /^0{8}(?:-0{4}){3}-0{12}$/.test(database.database_id)) {
    throw new Error('Health preflight requires a configured production D1 DB; deployment stopped.');
  }
  if (config.vars?.PASSKEY_ENABLED !== 'true') throw new Error('Health preflight requires PASSKEY_ENABLED=true; deployment stopped.');
  if (config.assets?.binding !== 'ASSETS' || !config.assets.directory
    || !config.services?.some(binding => binding.binding === 'SECURITY' && binding.service === 't-room-security')
    || !config.queues?.producers?.some(binding => binding.binding === 'SECURITY_AUDIT' && binding.queue === 't-room-security-audit')) {
    throw new Error('Health preflight requires ASSETS, SECURITY and SECURITY_AUDIT bindings; deployment stopped.');
  }
  if (Object.hasOwn(config.vars || {}, 'SESSION_SECRET')) throw new Error('Health SESSION_SECRET must be a Secret; deployment stopped.');
  const names = getSecretNames();
  if (!Array.isArray(names) || !names.includes('SESSION_SECRET')) throw new Error('Health preflight requires SESSION_SECRET; deployment stopped.');
}

export function healthProductionPreflight(directory, getSecretNames = () => healthSecretNames(directory)) {
  const config = JSON.parse(readFileSync(resolve(directory, 'wrangler.jsonc'), 'utf8'));
  assertHealthProductionReady(config, getSecretNames);
}
