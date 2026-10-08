import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import '../public/listing-model.js';

const client = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
const sortAdapter = client.slice(client.indexOf('function listingPreferences()'), client.indexOf('async function hydrateDeletionRequestRecords'));
const displayAdapter = client.slice(client.indexOf('const listingRecordRevisions ='), client.indexOf('function appendProgressiveItems'));
const forbidden = () => { throw new Error('Unrelated authority was accessed'); };
function guardedRecord(id, name, extra = {}) {
  return Object.freeze(Object.defineProperties({ id, name, ...extra }, {
    fileKey: { get: forbidden }, folderKey: { get: forbidden }, encryptedName: { get: forbidden }
  }));
}

test('sort/filter adapters pass frozen metadata and preferences without auth, keys or UI state', () => {
  const state = Object.defineProperties({ query: '', kind: '', sort: 'name', sortDirection: 'asc', sortUsesTypeDefaults: false }, {
    session: { get: forbidden }, crypto: { get: forbidden }, previewPlayer: { get: forbidden }, uploadAbort: { get: forbidden }
  });
  const calls = [];
  const model = Object.fromEntries(Object.entries(TCloudListing).map(([name, fn]) => [name, (...args) => {
    for (const value of args) if (value && typeof value === 'object') assert.ok(Object.isFrozen(value));
    if (name.startsWith('finalize')) {
      assert.deepEqual(Object.keys(args[1]).sort(), ['kind', 'query', 'sort', 'sortDirection', 'sortUsesTypeDefaults']);
      for (const record of args[0]) {
        assert.ok(Object.isFrozen(record));
        assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'mediaKind', 'name', 'searchDepth', 'sizeBytes', 'sourceIndex']);
      }
    }
    calls.push(name); return fn(...args);
  }]));
  const context = vm.createContext({ state, TCloudListing: model });
  vm.runInContext(sortAdapter + '\n' + client.match(/^function finalizeHydratedFolders\(hydrated\).*$/m)[0], context);
  const records = Object.freeze([guardedRecord(1, 'file10', { mediaKind: 'video', searchDepth: 2 }), guardedRecord(2, 'file2', { mediaKind: 'image', searchDepth: 0 })]);
  context.records = records;
  assert.deepEqual(Array.from(vm.runInContext('finalizeHydratedFiles(records)', context)), [records[1], records[0]]);
  assert.deepEqual(Array.from(vm.runInContext('finalizeHydratedFolders(records)', context)), [records[1], records[0]]);
  state.query = 'file'; state.kind = 'image';
  assert.deepEqual(Array.from(vm.runInContext('finalizeHydratedFiles(records)', context)), [records[1]]);
  assert.equal(vm.runInContext('matchesActiveSearchFile(records[0])', context), false);
  assert.equal(vm.runInContext('matchesActiveSearchFolder(records[0])', context), true);
  assert.ok(vm.runInContext('compareSearchResults(records[0], records[1])', context) > 0);
  assert.ok(calls.includes('finalizeFolders') && calls.includes('finalizeFiles'));
  assert.deepEqual(records.map(record => record.id), [1, 2]);
});

test('display adapter exposes only ID, name and an opaque revision while preserving record identity', () => {
  const context = vm.createContext({}); vm.runInContext(displayAdapter, context);
  context.records = [guardedRecord(1, '写真'), guardedRecord(2, '動画')];
  const projected = vm.runInContext('listingDisplayRecords(records)', context);
  assert.ok(Object.isFrozen(projected));
  for (const record of projected) {
    assert.ok(Object.isFrozen(record));
    assert.deepEqual(Object.keys(record).sort(), ['id', 'name', 'revision']);
  }
  assert.equal(vm.runInContext('listingDisplayRecords(records)[0].revision', context), projected[0].revision);
  context.records = [guardedRecord(1, '写真')];
  assert.notEqual(vm.runInContext('listingDisplayRecords(records)[0].revision', context), projected[0].revision);
});
