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
