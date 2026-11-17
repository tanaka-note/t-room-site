import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_dev } from 'wrangler';

// Node's HTTP fixtures do not implement Workers' automatic Content-Encoding.
// Send the real handler's final body/headers through workerd before the browser
// receives them. Raw node:http preserves the wire bytes without decompressing.
// This worker has no production bindings, credentials, resources or routes.
export async function workerdResponseTransport() {
  const directory = await mkdtemp(join(tmpdir(), 'diary-response-runtime-'));
  let runtime;
  const NativeResponse = globalThis.Response, encodings = new WeakMap();
  try {
    const { compatibility_date } = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify({
      name: 'diary-response-runtime-fixture', main: 'worker.js', compatibility_date
    }));
    await writeFile(join(directory, 'worker.js'), `export default {
      async fetch(request) {
        const {status, headers, encodeBody} = JSON.parse(request.headers.get('X-Fixture-Response'));
        return new Response(await request.arrayBuffer(), {status, headers, encodeBody});
      }
    };`);
    runtime = await unstable_dev(join(directory, 'worker.js'), {
      config: join(directory, 'wrangler.json'), local: true, ip: '127.0.0.1',
      port: 0, inspectorPort: 0, persist: false, logLevel: 'error',
      experimental: { disableExperimentalWarning: true }
    });
    // Node ignores this Workers-only ResponseInit field. Preserve the final
    // production constructor's actual choice for the workerd HTTP boundary.
    globalThis.Response = class extends NativeResponse {
      constructor(body, init) {
        super(body, init);
        encodings.set(this, init?.encodeBody ?? 'automatic');
      }
    };
    return {
      async send(reply, destination) {
        const body = Buffer.from(await reply.arrayBuffer());
        const headers = [...reply.headers].filter(([key]) => !['content-length', 'transfer-encoding', 'connection'].includes(key));
        await new Promise((resolve, reject) => {
          const outgoing = request({
            hostname: runtime.address, port: runtime.port, method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': body.length,
              'Accept-Encoding': 'gzip',
              'X-Fixture-Response': JSON.stringify({ status: reply.status, headers, encodeBody: encodings.get(reply) ?? 'automatic' })
            }
          }, incoming => {
            destination.writeHead(incoming.statusCode, incoming.headers);
            incoming.on('error', reject);
            destination.on('finish', resolve);
            incoming.pipe(destination);
          });
          outgoing.on('error', reject);
          outgoing.end(body);
        });
      },
      async close() {
        globalThis.Response = NativeResponse;
        try { await runtime.stop(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    };
  } catch (error) {
    globalThis.Response = NativeResponse;
    await runtime?.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
