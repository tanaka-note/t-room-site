import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root, services } from './verify-plan.mjs';

export function safeEvent(service, event) {
  // Never forward the request, URL, headers, console messages or exceptions.
  return { service, version: /^[a-f0-9-]{36}$/i.test(event.scriptVersion?.id || '') ? event.scriptVersion.id : null,
    operation: event.event?.scheduledTime ? 'scheduled' : event.event?.queue ? 'queue' : 'request',
    result: ['exception', 'exceededCpu', 'exceededMemory', 'canceled', 'ok', 'unknown'].includes(event.outcome) ? event.outcome : 'unknown',
    timestamp: Number.isFinite(event.eventTimestamp) ? event.eventTimestamp : null };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'tools/worker-logs.mjs')) {
  const service = process.argv[2];
  if (!services.includes(service)) throw new Error('Specify a Worker service');
  const cwd = resolve(root, `${service}-worker`);
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'tail', '--format', 'json', '--status', 'error'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  // Wrangler emits pretty-printed JSON objects. Bound the temporary buffer.
  let buffer = '';
  createInterface({ input: child.stdout }).on('line', line => {
    if (!buffer && !line.trim().startsWith('{')) return;
    buffer += line;
    try { const event = JSON.parse(buffer); buffer = ''; console.log(JSON.stringify(safeEvent(service, event))); } catch { if (buffer.length > 1024 * 1024) buffer = ''; }
  });
  process.on('SIGINT', () => child.kill());
  child.on('exit', code => { process.exitCode = code || 0; });
}
