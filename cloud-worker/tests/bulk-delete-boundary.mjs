import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import '../public/bulk-delete.js';

const source = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
const start = source.indexOf('async function deleteSelectedItems(');
const body = source.slice(start, source.indexOf('\nasync function openMoveDialog', start));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup({ files = [], folders = [], admin = true, confirmed = true, remove = async () => ({ deleted: 3 }), afterDeletion } = {}) {
  const log = { calls: [], progress: [], disabled: [], notices: [], effects: [], confirmations: [], refreshed: 0 }, button = {};
  Object.defineProperties(button, { textContent: { set: value => log.progress.push(value) }, disabled: { set: value => log.disabled.push(value) } });
  const selection = { files, folders };
  const context = vm.createContext({ TCloudBulkDelete, state: { session: { role: admin ? 'admin' : 'subadmin', canDelete: admin } },
    selectedItems: () => selection,
    canTrashFile: file => file.allowed !== false, canTrashFolder: folder => folder.allowed !== false,
    confirm: message => { log.confirmations.push(message); return confirmed; },
    confirmSubadminDeletion: message => { log.confirmations.push(message); return confirmed; },
    $: () => button,
    api: async (path, options) => { log.calls.push({ path, ...options }); return remove(path); },
    setNotice: (message, error) => log.notices.push({ message, error: !!error }),
    invalidateStoredConflicts: () => log.effects.push(['invalidate']),
    removeDeviceCopiesForFiles: items => log.effects.push(['files', items]),
    removeDeviceCopiesForFolders: items => log.effects.push(['folders', items]),
    preserveListingAfterDeletion: items => { log.effects.push(['listing', items]); afterDeletion?.(); },
    loadUsage: () => log.effects.push(['usage']), syncSelectionBar: () => log.refreshed++
  });
  vm.runInContext(body, context);
  return { log, context, selection, run: () => vm.runInContext('deleteSelectedItems()', context) };
}

test('empty, denied mixed selection and cancelled confirmation make no deletion requests', async () => {
  for (const options of [{}, { files: [{ id: 1 }], folders: [{ id: 2, allowed: false }] }, { files: [{ id: 1 }], confirmed: false }]) {
    const fixture = setup(options); await fixture.run();
    assert.deepEqual(fixture.log.calls, []); assert.deepEqual(fixture.log.disabled, []); assert.equal(fixture.log.refreshed, 0);
  }
  const denied = setup({ files: [{ id: 1, allowed: false }] }); await denied.run();
  assert.deepEqual(denied.log.confirmations, []);
  assert.equal(denied.log.notices[0].message, 'PWで解除した最初のフォルダ配下だけ削除できます。');
});

test('admin mixed deletion retains request shape, progress, totals and host cleanup order', async () => {
  const file = { id: 1 }, folder = { id: 2 }, fixture = setup({ files: [file], folders: [folder] });
  await fixture.run(); const { log } = fixture;
  assert.deepEqual(log.calls, [{ path: '/folders/2', method: 'DELETE', body: '{}' }, { path: '/files/1', method: 'DELETE', body: '{}' }]);
  assert.deepEqual(log.progress, ['削除中 0 / 2', '削除中 1 / 2', '削除中 2 / 2']);
  assert.deepEqual(log.disabled, [true, false]); assert.equal(log.refreshed, 1);
  assert.equal(log.confirmations[0], '2件を削除しますか？ファイルはゴミ箱へ移動します。\nフォルダは中身ごとゴミ箱へ移動します。');
  assert.deepEqual(log.notices, [{ message: '2件の選択から、合計4件をゴミ箱へ移動しました。', error: false }]);
  assert.deepEqual(log.effects.map(([name]) => name), ['invalidate', 'files', 'folders', 'listing', 'usage']);
  assert.equal(log.effects[1][1][0], file); assert.equal(log.effects[2][1][0], folder);
});

test('subadmin confirmation captures starting targets and preserves live failure names', async () => {
  const confirmation = deferred(), failure = deferred(), first = { id: 1, name: 'before' };
  const fixture = setup({ files: [first, { id: 2 }], admin: false, confirmed: confirmation.promise, remove: path => path === '/files/1' ? failure.promise : {} });
  const pending = fixture.run(); assert.deepEqual(fixture.log.calls, []);
  fixture.selection.files = [{ id: 9 }]; confirmation.resolve(true);
  await new Promise(setImmediate); first.name = 'at failure'; failure.resolve(Promise.reject(new Error('fixture failure')));
  await pending;
  assert.deepEqual(fixture.log.calls.map(call => call.path), ['/files/1', '/files/2']);
  assert.deepEqual(fixture.log.notices, [{ message: '1件を処理しました。削除できなかった1件：at failure', error: true }]);
  assert.deepEqual(fixture.log.effects.map(([name]) => name), ['invalidate', 'files', 'listing']);
});

test('partial and total failures preserve successful records and first three failure names', async () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: 'item' + (i + 1) }));
  const fixture = setup({ files, remove: async path => { if (Number(path.split('/').at(-1)) <= 4) throw new Error('fixture failure'); return {}; } });
  await fixture.run();
  assert.equal(fixture.log.notices[0].message, '2件を処理しました。削除できなかった4件：item1、item2、item3 ほか');
  assert.deepEqual(Array.from(fixture.log.effects.find(([name]) => name === 'listing')[1].files, file => file.id), [5, 6]);
  assert.equal(fixture.log.progress.at(-1), '削除中 6 / 6');
  const allFailed = setup({ files: files.slice(0, 1), remove: async () => { throw new Error('fixture failure'); } });
  await allFailed.run();
  assert.deepEqual(allFailed.log.effects.map(([name]) => name), ['listing', 'usage']);
  assert.deepEqual(Array.from(allFailed.log.effects[0][1].files), []);
});

test('post-deletion failure still restores the button and synchronizes the toolbar', async () => {
  const fixture = setup({ files: [{ id: 1 }], afterDeletion: () => { throw new Error('fixture cleanup failure'); } });
  await assert.rejects(fixture.run(), /fixture cleanup failure/);
  assert.deepEqual(fixture.log.disabled, [true, false]); assert.equal(fixture.log.refreshed, 1);
});

test('host passes only immutable IDs to the runner and retains full records for cleanup', async () => {
  const forbidden = () => { throw new Error('Keys or encrypted metadata were accessed'); };
  const record = Object.freeze(Object.defineProperties({ id: 1, name: 'fixture' }, { fileKey: { get: forbidden }, encryptedName: { get: forbidden } }));
  const fixture = setup({ files: [record] }); let calls = 0;
  fixture.context.TCloudBulkDelete = { run: (selection, callbacks) => {
    calls++;
    assert.ok(Object.isFrozen(selection) && Object.isFrozen(selection.fileIds) && Object.isFrozen(selection.folderIds));
    assert.deepEqual(Object.keys(selection).sort(), ['fileIds', 'folderIds']);
    assert.deepEqual(Array.from(selection.fileIds), [1]); assert.deepEqual(Array.from(selection.folderIds), []);
    return TCloudBulkDelete.run(selection, callbacks);
  } };
  await fixture.run(); assert.equal(calls, 1);
  assert.equal(fixture.log.effects.find(([name]) => name === 'files')[1][0], record);
});

test('runner rejection still restores the button and synchronizes the toolbar', async () => {
  const fixture = setup({ files: [{ id: 1 }] });
  fixture.context.TCloudBulkDelete = { run: async () => { throw new Error('fixture runner failure'); } };
  await assert.rejects(fixture.run(), /fixture runner failure/);
  assert.deepEqual(fixture.log.disabled, [true, false]); assert.equal(fixture.log.refreshed, 1);
});
