import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiaryEntryDomain } from '../src/entry-domain.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const domain = createDiaryEntryDomain({ HttpError, basePath: '/diary' });
const valid = { entryDate: '2026-10-07', title: '日記', content: '本文', tags: [' 写真 ', '写真', '旅行'], weather: 'sunny' };
const invalid = action => assert.throws(action, error => error instanceof HttpError && error.status === 400);

test('published entries normalize tags and reject invalid dates, weather and empty text', () => {
  assert.deepEqual(domain.validateEntryInput(valid).tags, ['写真', '旅行']);
  invalid(() => domain.validateEntryInput({ ...valid, entryDate: '2026-02-30' }));
  invalid(() => domain.validateEntryInput({ ...valid, weather: 'unknown' }));
  invalid(() => domain.validateEntryInput({ ...valid, title: '' }));
  invalid(() => domain.validateEntryInput({ ...valid, content: '' }));
  invalid(() => domain.validateEntryInput({ ...valid, tags: ['a'.repeat(31)] }));
  assert.equal(domain.validateEntryInput({ ...valid, title: '', content: '' }, { draft: true }).content, '');
});

test('rich text rejects overlapping ranges and unsupported colors', () => {
  const format = runs => ({ version: 1, runs });
  assert.deepEqual(JSON.parse(domain.validateContentFormat(format([{ start: 0, end: 1, bold: true }]), '本文')).runs, [
    { start: 0, end: 1, bold: true, italic: false, underline: false, color: null }
  ]);
  invalid(() => domain.validateContentFormat(format([{ start: 0, end: 2, bold: true }, { start: 1, end: 2, italic: true }]), '本文'));
  invalid(() => domain.validateContentFormat(format([{ start: 0, end: 3, bold: true }]), '本文'));
  invalid(() => domain.validateContentFormat(format([{ start: 0, end: 1, color: 'black' }]), '本文'));
  assert.equal(domain.parseContentFormat('{broken'), null);
});

test('public records retain revision, draft, favorite and photo URL contracts', () => {
  const id = 'AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA';
  assert.deepEqual(domain.parsePhotoIdList([id, id, 'invalid']), [id.toLowerCase()]);
  const entry = domain.serializeEntry({ id: '7', revision: '3', tags: '["旅行"]', is_favorite: 1, draft_of_entry_id: '6', draft_of_revision: '2', draft_excluded_photo_ids: JSON.stringify([id]) });
  assert.equal(entry.id, 7); assert.equal(entry.revision, 3);
  assert.equal(entry.isFavorite, true); assert.equal(entry.draftOfEntryId, 6);
  assert.deepEqual(entry.excludedPhotoIds, [id.toLowerCase()]);
  assert.deepEqual(entry.tags, ['旅行']);
  assert.deepEqual(domain.serializeEntry({ tags: '{broken' }).tags, []);
  const photo = domain.serializePhoto({ id: id.toLowerCase(), entry_id: '7', original_size: '100', width: null, height: '80' });
  assert.equal(photo.entryId, 7); assert.equal(photo.width, null); assert.equal(photo.height, 80);
  assert.equal(photo.originalUrl, `/diary/api/photos/${id.toLowerCase()}/original`);
});
