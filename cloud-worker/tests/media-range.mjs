import assert from "node:assert/strict";
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
await import("../public/media-range.js");

const range = globalThis.TCloudRange;
assert.deepEqual(range.parsePlainRange(null, 100), { start: 0, end: 99, partial: false });
assert.deepEqual(range.parsePlainRange("bytes=0-0", 100), { start: 0, end: 0, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=10-29", 100), { start: 10, end: 29, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=90-", 100), { start: 90, end: 99, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=-10", 100), { start: 90, end: 99, partial: true });
assert.equal(range.parsePlainRange("bytes=100-110", 100), null);
assert.equal(range.parsePlainRange("bytes=30-20", 100), null);
assert.equal(range.parsePlainRange("bytes=0-1,4-5", 100), null);

const file = { sizeBytes: 20, chunkSizeBytes: 8 };
assert.deepEqual(range.encryptedChunkRange(file, 0), { start: 0, end: 39, plainLength: 8 });
assert.deepEqual(range.encryptedChunkRange(file, 1), { start: 40, end: 79, plainLength: 8 });
assert.deepEqual(range.encryptedChunkRange(file, 2), { start: 80, end: 115, plainLength: 4 });
assert.deepEqual(range.plainChunkSlice(1, 8, 10, 18, 8), { from: 2, to: 8 });
assert.deepEqual(range.plainChunkSlice(2, 4, 10, 18, 8), { from: 0, to: 3 });

console.log("media range mapping: ok");

const mediaSource=readFileSync(new URL('../public/media-client.js',import.meta.url),'utf8');
const mediaContext={URL,location:{href:'https://fixture.invalid/cloud/'}};
vm.runInNewContext(mediaSource.replace('registerMedia,','descriptorFor, registerMedia,'),mediaContext);
const describe=mediaContext.TCloudMedia.descriptorFor;
const opaque='a'.repeat(64),updatedAt='2026-11-19T00:00:00.000Z';
const current=describe({id:42,name:'original.mp4',sizeBytes:1,updatedAt,contentVersion:opaque},'/cloud/api/files/42/view?session=fixture');
assert.equal(current.endpoint,'/cloud/api/files/42/view?session=fixture&contentVersion='+opaque);
assert.equal(current.version,opaque);assert.equal(current.sourceUpdatedAt,updatedAt);
const next=describe({id:42,name:'original.mp4',sizeBytes:1,updatedAt,contentVersion:'b'.repeat(64)},'/cloud/api/files/42/view');
assert.notEqual(next.version,current.version,'different bodies cannot share cached chunks even within the same timestamp');
const legacy=describe({id:42,name:'original.mp4',sizeBytes:1,updatedAt,offlineOnly:true},'/cloud/api/files/42/view');
assert.equal(legacy.version,updatedAt);assert.equal(legacy.endpoint,'/cloud/api/files/42/view');assert.equal(legacy.offlineOnly,true);
assert.throws(()=>describe({contentVersion:'invalid'},'/cloud/api/files/42/view'));
console.log('immutable media body versions preserve query context and legacy offline descriptors: ok');
