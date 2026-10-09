import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import '../public/bulk-delete.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const callbacks = { remove: async () => ({}), onProgress() {}, onFailure() {} };

test('empty queue returns immutable empty results without callbacks', async () => {
  const forbidden = () => { throw new Error('Empty queue must not call the host'); };
  const result = await TCloudBulkDelete.run({ fileIds: [], folderIds: [] }, { remove: forbidden, onProgress: forbidden, onFailure: forbidden });
  assert.deepEqual(result, { completed: 0, movedEntries: 0, processed: 0, deletedFileIds: [], deletedFolderIds: [], failures: [] });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.deletedFileIds) && Object.isFrozen(result.deletedFolderIds) && Object.isFrozen(result.failures));
});

test('queue snapshots targets, starts folders first and runs at most four requests once per target', async () => {
  const input = { folderIds: [101, 102], fileIds: [1, 2, 3, 4, 5] }, pending = new Map(), starts = [], progress = [], failures = [];
  let active = 0, maximum = 0;
  const resultPromise = TCloudBulkDelete.run(input, {
    remove: task => {
      assert.ok(Object.isFrozen(task)); assert.deepEqual(Object.keys(task).sort(), ['id', 'type']);
      const key = task.type + ':' + task.id; starts.push(key); const gate = deferred(); pending.set(key, gate);
      maximum = Math.max(maximum, ++active); return gate.promise.finally(() => active--);
    },
    onProgress: value => { assert.ok(Object.isFrozen(value)); progress.push({ ...value }); },
    onFailure: (task, error) => failures.push({ task, error })
  });
  assert.deepEqual(starts, ['folder:101', 'folder:102', 'file:1', 'file:2']);
  input.folderIds.push(999); input.fileIds.splice(0, input.fileIds.length, 999);
  const error = new Error('fixture failure');
  for (const [key, value] of [['file:2', {}], ['folder:102', { deleted: '3' }], ['file:1', error], ['folder:101', { deleted: 0 }], ['file:3', {}], ['file:4', {}], ['file:5', {}]]) {
    if (value === error) pending.get(key).reject(value); else pending.get(key).resolve(value);
    await new Promise(setImmediate);
  }
  const result = await resultPromise;
  assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(new Set(starts).size, 7); assert.equal(starts.length, 7);
  assert.deepEqual(result.deletedFileIds, [2, 3, 4, 5]); assert.deepEqual(result.deletedFolderIds, [102, 101]);
  assert.equal(result.completed, 6); assert.equal(result.movedEntries, 8); assert.equal(result.processed, 7);
  assert.equal(result.failures[0].error, error); assert.equal(failures[0].task, result.failures[0].target);
  assert.deepEqual(progress, Array.from({ length: 7 }, (_, i) => ({ processed: i + 1, total: 7 })));
  assert.ok(Object.isFrozen(result.failures[0]) && Object.isFrozen(result.failures[0].target));
  assert.throws(() => result.deletedFileIds.push(9), TypeError);
});

test('concurrent operations keep independent queues, totals and failure results', async () => {
  const a = deferred(), b = deferred();
  const first = TCloudBulkDelete.run({ fileIds: [1], folderIds: [] }, { ...callbacks, remove: () => a.promise });
  const second = TCloudBulkDelete.run({ fileIds: [], folderIds: [1] }, { ...callbacks, remove: () => b.promise });
  b.resolve({ deleted: 8 }); a.reject(new Error('fixture failure'));
  const [failed, complete] = await Promise.all([first, second]);
  assert.equal(failed.completed, 0); assert.equal(failed.failures.length, 1); assert.deepEqual(failed.deletedFolderIds, []);
  assert.equal(complete.completed, 1); assert.equal(complete.movedEntries, 8); assert.deepEqual(complete.deletedFolderIds, [1]); assert.equal(complete.failures.length, 0);
});

test('ID-only core cannot read records, DOM, authentication, crypto, preview or transfers', async () => {
  const forbidden = () => { throw new Error('Unrelated authority was accessed'); };
  const context = vm.createContext(Object.defineProperties({}, Object.fromEntries(['state', 'document', 'window', 'navigator', 'crypto'].map(name => [name, { get: forbidden }]))));
  vm.runInContext(await readFile(new URL('../public/bulk-delete.js', import.meta.url), 'utf8'), context);
  const selection = Object.freeze(Object.defineProperties({ fileIds: Object.freeze([1]), folderIds: Object.freeze([1]) }, { session: { get: forbidden }, fileKey: { get: forbidden }, preview: { get: forbidden } }));
  const targets = [];
  const result = await context.TCloudBulkDelete.run(selection, { ...callbacks, remove: async task => { targets.push({ ...task }); return {}; } });
  assert.deepEqual(targets, [{ type: 'folder', id: 1 }, { type: 'file', id: 1 }]); assert.equal(result.completed, 2);
  const record = Object.defineProperty({}, 'id', { get: forbidden }); let requests = 0;
  await assert.rejects(TCloudBulkDelete.run({ fileIds: [record], folderIds: [2] }, { ...callbacks, remove: () => requests++ }), TypeError);
  assert.equal(requests, 0);
});
