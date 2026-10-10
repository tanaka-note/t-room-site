import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/listing-model.js';

const listing = globalThis.TCloudListing;
test('search orders shallow results before exact, prefix and substring matches', () => {
  const files = [
    { id: 1, name: '旅行', searchDepth: 2, mediaKind: 'image' },
    { id: 2, name: '夏の旅行', searchDepth: 0, mediaKind: 'image' },
    { id: 3, name: '旅行動画', searchDepth: 0, mediaKind: 'video' },
    { id: 4, name: '旅行', searchDepth: 0, mediaKind: 'image' },
    { id: 5, name: '書類', searchDepth: 0, mediaKind: 'document' }
  ];
  assert.deepEqual(listing.finalizeFiles(files, { query: '旅行', kind: '' }).map(file => file.id), [4, 3, 2, 1]);
  assert.deepEqual(listing.finalizeFiles(files, { query: '旅行', kind: 'image' }).map(file => file.id), [4, 2, 1]);
  assert.deepEqual(files.map(file => file.id), [1, 2, 3, 4, 5], 'input order is preserved');
});

test('normal listing keeps numeric name sorting, direction and newest-first defaults', () => {
  const files = [
    { id: 1, name: 'file10', sizeBytes: 2, createdAt: '2026-01-01' },
    { id: 2, name: 'file2', sizeBytes: 1, createdAt: '2026-01-02' }
  ];
  const preferences = { query: '', kind: '', sort: 'name', sortDirection: 'asc', sortUsesTypeDefaults: false };
  assert.deepEqual(listing.finalizeFiles(files, preferences).map(file => file.id), [2, 1]);
  assert.deepEqual(listing.finalizeFiles(files, { ...preferences, sortDirection: 'desc' }).map(file => file.id), [1, 2]);
  assert.deepEqual(listing.finalizeFiles(files, { ...preferences, sortUsesTypeDefaults: true }).map(file => file.id), [2, 1]);
  const renamed = files.map(file => ({ ...file, updatedAt: file.id === 1 ? '2026-10-08' : '2026-01-02' }));
  assert.deepEqual(listing.finalizeFiles(renamed, { ...preferences, sort: 'updated', sortDirection: 'desc' }).map(file => file.id), [2, 1], 'saved-date sorting is independent of later renames');
});

test('folder selection merges overlapping paths and preserves distinct revisions', () => {
  const file = { name: 'a.jpg', size: 1, lastModified: 1 };
  const first = listing.normalizeFolderSelection([{ file, relativePath: '写真\\./2026/a.jpg' }], new Set(['空フォルダ']));
  const next = listing.normalizeFolderSelection([
    { file, relativePath: '写真/2026/a.jpg' },
    { file: { ...file, lastModified: 2 }, relativePath: '写真/2026/a.jpg' }
  ]);
  const merged = listing.mergeFolderSelections(first, next);
  assert.deepEqual(merged.roots, ['空フォルダ', '写真']);
  assert.equal(merged.files.length, 2);
  assert.equal(first.files.length, 1);
  assert.throws(() => listing.normalizeFolderSelection([]), /アップロードするフォルダ/);
});

test('folder sorting preserves numeric names, saved dates and search depth independently of file type', () => {
  const folders = Object.freeze([
    Object.freeze({ id: 1, name: 'folder10', createdAt: '2026-01-01', updatedAt: '2026-10-08', searchDepth: 2 }),
    Object.freeze({ id: 2, name: 'folder2', createdAt: '2026-01-02', searchDepth: 0 })
  ]);
  const preferences = { query: '', kind: 'video', sort: 'name', sortDirection: 'asc', sortUsesTypeDefaults: false };
  assert.deepEqual(listing.finalizeFolders(folders, preferences).map(folder => folder.id), [2, 1]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, sortDirection: 'desc' }).map(folder => folder.id), [1, 2]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, sort: 'updated', sortDirection: 'desc' }).map(folder => folder.id), [2, 1]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, sort: 'size', sortDirection: 'desc' }).map(folder => folder.id), [2, 1]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, sortUsesTypeDefaults: true, sortDirection: 'desc' }).map(folder => folder.id), [2, 1]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, query: 'folder' }).map(folder => folder.id), [2, 1]);
  assert.deepEqual(listing.finalizeFolders(folders, { ...preferences, query: 'folder10' }).map(folder => folder.id), [1]);
  assert.deepEqual(folders.map(folder => folder.id), [1, 2]);
});
