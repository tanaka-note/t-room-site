import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import '../public/selection-state.js';

const client = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
const adapter = client.slice(client.indexOf('let selectionState = null;'), client.indexOf('function selectFile('));
const action = (name, next) => client.slice(client.indexOf(`async function ${name}(`), client.indexOf(next, client.indexOf(`async function ${name}(`)));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function makeContext(extra = {}) {
  const context = vm.createContext({ TCloudSelection, ...extra });
  vm.runInContext(adapter, context); return context;
}
function choose(context, files, folders = []) {
  context.nextFiles = files; context.nextFolders = folders;
  vm.runInContext('clearSelectedRecords(); for (const file of nextFiles) rememberSelectedRecord("file", file); for (const folder of nextFolders) rememberSelectedRecord("folder", folder);', context);
}

test('host adapter keeps records and keys outside ID selection without reading other state', () => {
  const forbidden = () => { throw new Error('Unrelated authority was accessed'); };
  const state = Object.defineProperties({}, Object.fromEntries(['session', 'crypto', 'previewPlayer', 'uploadAbort'].map(name => [name, { get: forbidden }])));
  const record = Object.defineProperties({ id: 1 }, { fileKey: { get: forbidden }, encryptedName: { get: forbidden } });
  const context = makeContext({ state }); choose(context, [record], [{ id: 1 }]);
  const captured = vm.runInContext('selectedItems()', context);
  assert.equal(captured.files[0], record);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.files) && Object.isFrozen(captured.folders));
  context.replacement = [{ id: 2 }]; vm.runInContext('replaceSelectedFiles(replacement)', context);
  assert.deepEqual(Array.from(vm.runInContext('getSelection().snapshot().fileIds', context)), [2]);
  assert.deepEqual(Array.from(vm.runInContext('getSelection().snapshot().folderIds', context)), [1]);
  vm.runInContext('clearSelectedRecords()', context);
  assert.equal(vm.runInContext('selectedRecordStore.file.size + selectedRecordStore.folder.size', context), 0);
  assert.equal(captured.files[0], record); assert.equal(captured.folders[0].id, 1);
  assert.doesNotMatch(client, /state\.selected(?:Files|Folders)/);
});

test('bulk download uses the starting records across an asynchronous destination picker', async () => {
  const picker = deferred(), executions = [], first = { id: 1, fileKey: {} };
  const context = makeContext({ state: { downloadActive: false }, chooseDownloadTargets: files => { assert.equal(files[0], first); return picker.promise; }, executeDownloads: (files, targets) => executions.push({ files, targets }), setNotice() {} });
  vm.runInContext(action('startSelectedDownloads', '\nfunction currentOfflineContext'), context);
  choose(context, [first]); const pending = vm.runInContext('startSelectedDownloads()', context);
  choose(context, [{ id: 9 }]); const targets = new Map(); picker.resolve(targets); await pending;
  assert.equal(executions.length, 1); assert.equal(executions[0].files[0], first); assert.equal(executions[0].targets, targets);
});

test('bulk delete preserves captured targets, permission rejection and partial success', async () => {
  const confirmation = deferred(), calls = [], deleted = [], notices = [], button = {};
  const context = makeContext({ state: { session: { role: 'subadmin', canDelete: false } },
    canTrashFile: item => item.allowed !== false, canTrashFolder: item => item.allowed !== false,
    confirmSubadminDeletion: () => confirmation.promise, $: () => button,
    api: async (path, options) => { assert.equal(options.method, 'DELETE'); calls.push(path); if (path === '/files/2') throw new Error('fixture failure'); return { deleted: 3 }; },
    setNotice: (message, error) => notices.push({ message, error }), invalidateStoredConflicts() {},
    removeDeviceCopiesForFiles() {}, removeDeviceCopiesForFolders() {},
    preserveListingAfterDeletion: items => deleted.push(items), syncSelectionBar() {}, loadUsage() { throw new Error('subadmin does not load admin usage'); }
  });
  vm.runInContext(action('deleteSelectedItems', '\nasync function openMoveDialog'), context);
  choose(context, [{ id: 1 }, { id: 2, name: 'failed' }], [{ id: 3 }]);
  const pending = vm.runInContext('deleteSelectedItems()', context);
  choose(context, [{ id: 9 }]); confirmation.resolve(true); await pending;
  assert.deepEqual(calls.sort(), ['/files/1', '/files/2', '/folders/3']);
  assert.deepEqual(Array.from(deleted[0].files, item => item.id), [1]);
  assert.deepEqual(Array.from(deleted[0].folders, item => item.id), [3]);
  assert.equal(notices.at(-1).error, true); assert.equal(button.disabled, false);
  choose(context, [{ id: 4, allowed: false }]); await vm.runInContext('deleteSelectedItems()', context);
  assert.equal(calls.length, 3); assert.equal(notices.at(-1).error, true);
  choose(context, [{ id: 5 }]); context.confirmSubadminDeletion = async () => false;
  await vm.runInContext('deleteSelectedItems()', context); assert.equal(calls.length, 3);
});

test('bulk move keeps captured records and passes their existing keys to the existing rewrap API', async () => {
  const destination = deferred(), fileKey = {}, folderKey = {}, targetKey = {}, rewrites = [], calls = [], elements = new Map();
  const state = { movePicker: { currentId: 10 }, moveDestinations: new Map(), crypto: { folderKeys: new Map([[10, targetKey], [3, folderKey]]) }, session: { role: 'admin' } };
  const context = makeContext({ state, movePickerCurrentIsSource: () => false,
    $: id => { if (!elements.has(id)) elements.set(id, id === '#move-dialog' ? { open: true, close() { this.open = false; } } : {}); return elements.get(id); },
    loadMoveDestination: () => destination.promise,
    TRoomCrypto: { rewrapFileForFolder: async (key, parent) => { rewrites.push([key, parent]); return { wrappedFileKey: 'fixture' }; }, rewrapFolderForParent: async (key, parent) => { rewrites.push([key, parent]); return { wrappedFolderKey: 'fixture' }; } },
    api: async (path, options) => calls.push([path, JSON.parse(options.body)]),
    clearFileSelection: () => vm.runInContext('clearSelectedRecords()', context), setNotice() {}, invalidateStoredConflicts() {}, loadItems() {}, renderMovePicker() {}
  });
  vm.runInContext(action('moveSelectedItems', '\nasync function downloadCurrentFolder'), context);
  choose(context, [{ id: 1, fileKey }], [{ id: 3, name: 'folder' }]);
  const pending = vm.runInContext('moveSelectedItems({ preventDefault() {} })', context);
  choose(context, [{ id: 9 }]); destination.resolve({ id: 10 }); await pending;
  assert.deepEqual(rewrites, [[fileKey, targetKey], [folderKey, targetKey]]);
  assert.deepEqual(calls.map(([path]) => path), ['/files/1', '/folders/3']);
  assert.equal(calls[0][1].folderId, 10); assert.equal(calls[1][1].passwordAction, 'keep'); assert.equal(calls[1][1].parentId, 10);
  assert.equal(state.crypto.folderKeys.get(10), targetKey); assert.equal(elements.get('#move-dialog').open, false);
});
