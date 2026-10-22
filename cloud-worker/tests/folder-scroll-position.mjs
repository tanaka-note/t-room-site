import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const client = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
const snapshotSource = client.slice(client.indexOf('function captureNavigationPosition'), client.indexOf('function cancelFolderNavigation'));
const context = vm.createContext({
  navigationPositions: new Map(), state: { folderId: 30, kind: 'video', view: 'all', query: 'sample', listMode: true,
    sort: 'name', sortDirection: 'desc', sortUsesTypeDefaults: false, folders: Array(96), files: Array(32), itemRenderLimit: 192 },
  appScrollPosition: () => ({ x: 12, y: 845 }), $: () => ({ textContent: 'C' }), navigationOriginSelector: () => ''
});
vm.runInContext(snapshotSource, context);
const entry = vm.runInContext('captureNavigationPosition({tcloud:true,navigationId:"visit-1"},"folder",11)', context);
assert.equal(entry.scrollY, 845); assert.equal(entry.scrollX, 12);
assert.equal(entry.originType, 'folder'); assert.equal(entry.originId, 11);
assert.equal(entry.query, 'sample'); assert.equal(entry.listMode, true);
assert.equal(entry.loadedFolderCount, 96); assert.equal(entry.loadedFileCount, 32);
assert.equal(entry.sortDirection, 'desc'); assert.equal(entry.renderLimit, 192);
assert.equal(Object.hasOwn(entry, 'folders'), false, 'history contains counts rather than records or encryption keys');
vm.runInContext('for(let i=0;i<200;i++)cacheNavigationPosition({navigationId:String(i)})', context);
assert.equal(context.navigationPositions.size, 128);

const restoreSource = client.slice(client.indexOf('async function restoreNavigationPosition'), client.indexOf('async function prepareCryptoSession'));
for (const changed of ['navigationGeneration', 'load']) {
  let finish;
  const scrolls = [];
  const restoreContext = vm.createContext({
    state: { itemLoadGeneration: 1 }, navigationGeneration: 1,
    ensureNavigationOriginRendered: () => new Promise(resolve => { finish = resolve; }),
    navigationOriginSelector: () => '', scrollAppTo: value => scrolls.push(value), appScrollPosition: () => ({y: 845})
  });
  vm.runInContext(restoreSource, restoreContext);
  const restoring = vm.runInContext('restoreNavigationPosition({tcloud:true,scrollY:845})', restoreContext);
  if (changed === 'load') restoreContext.state.itemLoadGeneration++;
  else restoreContext.navigationGeneration++;
  finish(); await restoring;
  assert.deepEqual(scrolls, [], changed + ' invalidates an unfinished restoration');
}
console.log('folder navigation display snapshots, bounded history and stale restoration cancellation: ok');

const ensureSource = client.slice(client.indexOf('async function ensureNavigationOriginRendered'), client.indexOf('async function restoreNavigationPosition'));
for (const type of ['file', 'folder']) {
  const loaded = [];
  const rangeState = { itemLoadGeneration: 1, folders: [], files: [], itemNextFolderOffset: 32,
    itemNextFileOffset: 32, itemRenderLimit: 192, progressiveItemsLoading: true, itemPageLoading: false };
  const rangeContext = vm.createContext({
    state: rangeState, navigationGeneration: 1, folderNavigation: {},
    navigationOriginSelector: () => 'anchor', nextRenderOpportunity: async () => {},
    loadNextItemPage: async options => {
      loaded.push(options.searchOrigin);
      const records = type === 'file' ? rangeState.files : rangeState.folders;
      records.push(...Array.from({ length: options.searchOrigin ? 250 : 160 }, (_, i) => ({ id: 1000 + i })));
    }
  });
  vm.runInContext(ensureSource, rangeContext);
  await vm.runInContext(`ensureNavigationOriginRendered({originType:'${type}',originId:90,loaded${type === 'file' ? 'File' : 'Folder'}Count:160})`, rangeContext);
  assert.deepEqual(loaded, [false, true], type + ' restores saved range and searches only one extra page');
}
console.log('missing folder/file anchor search is bounded independently of remaining folder size: ok');

let pages = 0, rangeFailure;
const cappedState = { itemLoadGeneration: 1, folders: [], files: [], itemNextFolderOffset: null,
  itemNextFileOffset: 0, itemRenderLimit: 192, progressiveItemsLoading: true, itemPageLoading: false };
const cappedContext = vm.createContext({
  state: cappedState, navigationGeneration: 1, folderNavigation: {}, navigationOriginSelector: () => '',
  loadNextItemPage: async () => { pages++; cappedState.itemNextFileOffset += 250; },
  handleError: error => { rangeFailure = error; }
});
vm.runInContext(ensureSource, cappedContext);
const capped = await vm.runInContext('ensureNavigationOriginRendered({loadedFileCount:1056})', cappedContext);
assert.equal(pages, 256, 'malformed/non-progressing pages cannot exceed the existing hard limit');
assert.equal(capped.ok, false); assert.equal(capped.error, rangeFailure, 'an incomplete saved range fails instead of committing a partial restoration');
console.log('restoration page safety limit fails closed on non-progressing data: ok');
