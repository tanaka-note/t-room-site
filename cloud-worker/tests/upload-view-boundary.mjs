import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
