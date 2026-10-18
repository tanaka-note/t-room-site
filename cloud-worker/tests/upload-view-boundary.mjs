import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';

const [view, client, html] = await Promise.all([
  readFile(new URL('../public/upload-view.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/cloud.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8')
]);
assert.doesNotMatch(view, /\b(?:state|document|fetch|XMLHttpRequest|AbortController|localStorage|sessionStorage|indexedDB|TCloudSession|TRoomCrypto|fileKey|folderKey)\b/,
  'Upload presentation must not own application state, transfer, storage or keys');
const load = vm.createContext({});
vm.runInContext(view, load);
assert.equal(typeof load.TCloudUploadView.create, 'function', 'The view loads without a DOM or transfer environment');
assert.ok(Object.isFrozen(load.TCloudUploadView));
const viewScript = html.indexOf('/cloud/upload-view.js?'), clientScript = html.indexOf('/cloud/cloud.js?');
assert.ok(viewScript >= 0 && clientScript > viewScript, 'Load the view before its caller');

// Exercise the production Worker entry point, not the static browser fixture's routing.
const workerSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const workerContext = { WorkerEntrypoint: class {}, Request, Response, Headers, URL, TextEncoder, console, lineBrowserResponse };
vm.runInNewContext(workerSource.replace(/^import .*;\r?\n/gm, '')
  .replace('export class SecurityIntegration', 'class SecurityIntegration')
  .replace('export default {', 'globalThis.worker = {'), workerContext);
const assetRequests = [];
const env = { ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  assetRequests.push(path);
  const file = path === '/' ? 'index.html' : path === '/share' ? 'share.html' : path.slice(1);
  const body = await readFile(new URL('../public/' + file, import.meta.url));
  return new Response(body, { headers: { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' } });
} } };
const requestAsset = path => workerContext.worker.fetch(new Request('https://fixture.test' + path), env, {});
const shell = await requestAsset('/cloud/');
assert.equal(shell.status, 200);
assert.equal(await shell.text(), html, 'The Worker serves the actual application HTML');
const scriptRefs = [...new Set([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
  .map(match => match[1]).filter(path => path.startsWith('/cloud/')))];
for (const path of scriptRefs) {
  const response = await requestAsset(path);
  assert.equal(response.status, 200, 'The production Worker serves required script ' + path);
  assert.match(response.headers.get('Content-Type'), /javascript/);
  if (path.startsWith('/cloud/upload-view.js?')) assert.equal(await response.text(), view);
  if (path.startsWith('/cloud/search-input.js?')) {
    assert.equal(await response.text(), await readFile(new URL('../public/search-input.js', import.meta.url), 'utf8'),
      'The production Worker serves the actual search controller, including versioned requests');
  }
}
const allowedRequestCount = assetRequests.length;
for (const path of ['/cloud/src/index.js', '/cloud/unlisted.js', '/cloud/upload-view.js/private', '/cloud/search-input.js/private']) {
  assert.equal((await requestAsset(path)).status, 404, 'Unlisted paths remain private');
}
assert.equal(assetRequests.length, allowedRequestCount, 'Unlisted paths never reach the asset binding');

// Keep the real HTML contract complete, including elements used only by failure/confirmation paths.
const required = [...new Set([...view.matchAll(/\b(?:node|text)\("([^"]+)"/g)].map(match => `#upload-${match[1]}`))];
const checked = [], elements = new Map(required.map(selector => [selector, {}]));
const contractView = load.TCloudUploadView.create({
  panel: { querySelector(selector) { checked.push(selector); return elements.get(selector) || null; } },
  formatBytes: String, escapeHtml: String
});
assert.deepEqual([...new Set(checked)].sort(), [...required].sort(), 'Initialization checks every referenced upload element');
for (const selector of required) {
  assert.equal(html.split(`id="${selector.slice(1)}"`).length - 1, 1, selector + ' exists exactly once in the real HTML');
  elements.delete(selector);
  assert.throws(() => contractView.assertReady(), /アップロード画面を準備できませんでした/, 'A cached view detects missing ' + selector);
  assert.throws(() => load.TCloudUploadView.create({ panel: { querySelector: name => elements.get(name) || null } }), /アップロード画面を準備できませんでした/);
  elements.set(selector, {});
}
assert.throws(() => load.TCloudUploadView.create({ panel: null }), /アップロード画面を準備できませんでした/);

const root = {}, received = [];
const formatBytes = value => String(value), escapeHtml = value => String(value);
const adapter = vm.createContext({
  $(selector) { assert.equal(selector, '#upload-panel'); return root; },
  formatBytes, escapeHtml,
  TCloudUploadView: { create(options) {
    assert.deepEqual(Object.keys(options).sort(), ['escapeHtml', 'formatBytes', 'panel']);
    assert.equal(options.panel, root);
    return { renderConflicts: records => received.push(records), renderFailures: records => received.push(records) };
  } }
});
const start = client.indexOf('let uploadView = null;'), end = client.indexOf('function updateDownloadQueueItem(', start);
assert.ok(start >= 0 && end > start);
vm.runInContext(client.slice(start, end), adapter);
const file = { name: 'display name', get fileKey() { throw new Error('View must never receive a file key'); } };
adapter.conflicts = [{ file, reason: 'conflict reason', existingLocations: ['folder/file'], destinationFolderKey: 'fixture-key' }];
adapter.failures = [{ file, error: { message: 'failure reason' }, destinationFolderKey: 'fixture-key' }];
vm.runInContext('renderUploadConflicts(conflicts); renderUploadFailures(failures);', adapter);
assert.deepEqual(JSON.parse(JSON.stringify(received)), [
  [{ name: 'display name', reason: 'conflict reason', details: ['保存済み：folder/file'] }],
  [{ name: 'display name', message: 'failure reason' }]
], 'Only display fields cross the upload presentation boundary');
console.log('upload view checks its real HTML contract and receives no file, key, transfer or session state: ok');
