import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/selection-state.js';

test('selection keeps ordered IDs independently for files, folders and instances', () => {
  const a = TCloudSelection.create(), b = TCloudSelection.create();
  a.add('file', 2); a.add('file', 1); a.add('file', 2); a.add('file', '2'); a.add('folder', 2);
  assert.deepEqual(a.snapshot(), { fileIds: [2, 1, '2'], folderIds: [2] });
  assert.equal(a.count('file'), 3); assert.equal(a.has('folder', 2), true);
  assert.equal(b.count('file'), 0);
  a.remove('file', 2);
  assert.equal(a.has('file', 2), false); assert.equal(a.has('folder', 2), true);
  a.replace('file', [9, 8, 9]);
  assert.deepEqual(a.snapshot(), { fileIds: [9, 8], folderIds: [2] });
});

test('operation snapshots stay immutable when the current selection changes or clears', () => {
  const selection = TCloudSelection.create(); selection.add('file', 1); selection.add('folder', 2);
  const before = selection.snapshot();
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.fileIds) && Object.isFrozen(before.folderIds));
  assert.throws(() => before.fileIds.push(3), TypeError);
  selection.replace('file', [4]); selection.remove('folder', 2); selection.clear();
  assert.deepEqual(before, { fileIds: [1], folderIds: [2] });
  assert.deepEqual(selection.snapshot(), { fileIds: [], folderIds: [] });
});

test('records and keys cannot enter selection; invalid replacement is atomic', () => {
  const selection = TCloudSelection.create(); selection.add('file', 1);
  const record = Object.defineProperty({}, 'id', { get() { throw new Error('record must not be read'); } });
  assert.throws(() => selection.add('file', record), TypeError);
  assert.throws(() => selection.replace('file', [2, record]), TypeError);
  assert.throws(() => selection.add('other', 2), TypeError);
  assert.deepEqual(selection.snapshot(), { fileIds: [1], folderIds: [] });
});
