import {photoHeader} from '../../e2ee/photo-crypto.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { systemFixture } from './system-fixture.mjs';
import { publicTrustPackage } from '../../e2ee/setup.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';
import { readSnapshotPages } from '../../e2ee/snapshot.mjs';

const f = await systemFixture();
const user = f.users[process.argv.includes('--independent-editor') ? 'chiharu-admin' : 'main-admin'];
const root = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const trust = await publicTrustPackage(f.configuration);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const requests = [], errors = [];
let origin, failRetire = false, failCommit = false, failAttachment = false, failFinalize = false, afterCommit = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/diary/api/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const sample = { path: url.pathname, method: request.method, body: body.toString() };
      requests.push(sample);
      const mutation = url.pathname.endsWith('/encryption/mutation') ? JSON.parse(body) : null;
      const attaching = mutation?.proposal?.photoIds?.some(id => f.db.sqlite.prepare('SELECT status FROM diary_e2ee_media WHERE id=?').get(id)?.status === 'ready');
      if ((failRetire && /\/encryption\/media\//.test(url.pathname)) || (failCommit && /\/encryption\/uploads\/[^/]+\/commit$/.test(url.pathname)) || (failAttachment && attaching) || (failFinalize && afterCommit && mutation)) {
        sample.status = 503;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic retryable photo operation failure' }));
        return;
      }
      const result = await f.worker.fetch(new Request(url, { method: request.method, headers: request.headers, ...(body.length ? { body } : {}) }), f.env, f.ctx);
      sample.status = result.status;
      if (result.ok && /\/encryption\/uploads\/[^/]+\/commit$/.test(url.pathname)) {
        afterCommit = true;
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    if (['/security/passkey-client.js', '/assets/pwa-auto-update.js'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/javascript'); response.end('/* Synthetic authentication; no production calls. */'); return;
    }
    const file = resolve(root, url.pathname === '/diary/' ? 'index.html' : url.pathname.slice('/diary/'.length));
    if (!url.pathname.startsWith('/diary/') || !file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : extname(file) === '.html' ? 'text/html' : extname(file) === '.css' ? 'text/css' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`; f.env.DIARY_ENCRYPTION_ORIGIN = origin;
const browser = await chromium.launch({ headless: true });
let context;
try {
  const desktop = process.argv.includes('--desktop');
  context = await browser.newContext({ viewport: { width: desktop ? 1280 : 390, height: 844 }, isMobile: !desktop, hasTouch: !desktop });
  await context.addInitScript(({ prf, credentialId, trust, accountId }) => {
    window.TRoomPasskeys = { authenticate: async () => ({ credentialId, prfOutput: new Uint8Array(prf), verified: { diaryTrust: trust }, link: { accountId }, handoff: { handoffToken: accountId, diaryTrust: trust } }) };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      if (window.losePhotoCommitReply && init.method === 'POST' && /\/encryption\/uploads\/[^/]+\/commit$/.test(new URL(input, location.href).pathname)) {
        window.losePhotoCommitReply = false;
        throw new TypeError('Synthetic response loss after confirmed commit');
      }
      return response;
    };
  }, { prf: [...user.prf], credentialId: user.credentialId, trust, accountId: user.serviceAccountId });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/diary/'); await page.click('#passkey-login'); await page.locator('#app-view').waitFor({ state: 'visible' });

  const mediaFor = id => f.db.sqlite.prepare('SELECT photo_ids FROM diary_e2ee_records WHERE id=?').get(String(id));
  const idsFor = id => JSON.parse(mediaFor(id).photo_ids);
  async function addPhotos(count, label) {
    const chooser = page.waitForEvent('filechooser'); await page.click('#add-photo-button');
    await (await chooser).setFiles(Array.from({ length: count }, (_, index) => ({ name: `PHOTO_EDIT_PRIVATE_${label}_${index}.png`, mimeType: 'image/png', buffer: png })));
    await page.waitForFunction(() => !document.querySelector('#photo-input').disabled);
  }
  async function save(status, { partial = false } = {}) {
    await page.click(status === 'draft' ? '#save-draft-button' : '#save-entry-button');
    await page.waitForFunction(() => !document.querySelector('#editor-dialog').open || (!document.querySelector('#save-entry-button').disabled && document.querySelector('#editor-message').textContent));
    const message = await page.locator('#editor-message').textContent();
    assert.equal(await page.locator('#editor-dialog').evaluate(dialog => dialog.open), partial, message);
    return message;
  }
  async function createPhotoEntry(count, status, label) {
    await page.click('#new-entry-button'); await page.locator('#editor-dialog').waitFor({ state: 'visible' });
    await page.fill('#entry-title', `PHOTO_EDIT_PRIVATE_${label}`); await addPhotos(count, label); await save(status);
    const row = f.db.sqlite.prepare('SELECT id FROM diary_e2ee_records WHERE state=? AND author=? ORDER BY CAST(id AS INTEGER) DESC LIMIT 1').get(status, user.serviceAccountId);
    assert.ok(row); assert.equal(idsFor(row.id).length, count); return row.id;
  }
  async function editEntry(id) {
    await page.locator(`#entry-list [data-entry-id="${id}"]`).click();
    if (f.db.sqlite.prepare('SELECT state FROM diary_e2ee_records WHERE id=?').get(id).state !== 'draft') {
      await page.locator('#entry-dialog').waitFor({ state: 'visible' }); await page.click('#edit-entry-button');
    }
    await page.locator('#editor-dialog').waitFor({ state: 'visible' });
  }
  async function removePhotos(count) {
    for (let index = 0; index < count; index++) await page.locator('#editor-photo-list [data-photo-action="remove"]').first().click();
  }
  async function selectDrafts(drafts) {
    if (await page.locator('#draft-button').getAttribute('aria-pressed') !== String(drafts)) await page.click('#draft-button');
    await page.waitForFunction(drafts => document.querySelector('#draft-button').getAttribute('aria-pressed') === String(drafts), drafts);
  }
  const uploadRequests = () => requests.filter(row => row.method === 'POST' && /\/encryption\/uploads\/[^/]+\/photos$/.test(row.path)).length;
  const commitRequests = () => requests.filter(row => row.method === 'POST' && /\/encryption\/uploads\/[^/]+\/commit$/.test(row.path)).length;
  async function externalUpdate(id) {
    const call = async (path, body) => {
      const response = await f.worker.fetch(new Request(origin + '/diary/api/encryption' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: f.cookie(user.serviceAccountId), ...(body ? { Origin: origin, 'X-Diary-Request': '1', 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), f.env, f.ctx);
      const value = await response.json(); assert.equal(response.status, 200); return value;
    };
    const { profile } = await call('/profile');
    const writer = new EncryptedDiaryClient({ profile, anchor: trust.anchor, documentFormat: 2, transport: { valid: async () => true, timestamp: async () => (await call('/time')).timestamp, snapshot: (household, since) => readSnapshotPages(options => call('/snapshot?' + new URLSearchParams(Object.entries(options).filter(([, value]) => value != null))), household, since), mutation: (proposal, operation) => call('/mutation', { proposal, operation }) } });
    try { await writer.unlock(new Uint8Array(user.prf)); await writer.sync(); await writer.hydrate(id); const entry = writer.entry(id); await writer.saveEntry({ ...entry, title: 'PHOTO_EDIT_PRIVATE_OTHER_DEVICE' }, id); }
    finally { writer.lock(); }
  }

  // Match the reported operation: remove two saved photos, add 31 photos to
  // an otherwise empty diary, then publish its draft through the real Worker.
  const id = await createPhotoEntry(2, 'draft', 'initial');
  const oldIds = idsFor(id);
  await editEntry(id); await removePhotos(2); await addPhotos(31, 'replacement');
  assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 31);
  await save('published');
  const replacements = idsFor(id);
  assert.equal(replacements.length, 31); assert.ok(oldIds.every(id => !replacements.includes(id)));
  assert.equal(requests.filter(row => row.method === 'DELETE' && /^\/diary\/api\/photos\//.test(row.path)).length, 0, 'editor cleanup must use the encrypted API');
  for (const id of replacements) {
    const media = f.db.sqlite.prepare('SELECT status,original_key FROM diary_e2ee_media WHERE id=?').get(id);
    assert.equal(media.status, 'attached'); assert.ok(photoHeader(f.r2.get(media.original_key).bytes));
  }
  await page.reload(); await page.locator('#app-view').waitFor({ state: 'visible' });
  await page.locator(`#entry-list [data-entry-id="${id}"]`).click(); await page.locator('#entry-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#detail-content .entry-photo').count(), 31);
  await page.click('[data-close-dialog="entry-dialog"]');

  // Saving an edit draft retains the published source and all source objects.
  const publishedIds = idsFor(id), retiredBeforeDraft = requests.filter(row => /\/encryption\/media\//.test(row.path)).length;
  await editEntry(id); await removePhotos(2); await addPhotos(2, 'edit-draft'); await save('draft');
  const draft = f.db.sqlite.prepare("SELECT id FROM diary_e2ee_records WHERE state='draft' AND source_id=?").get(id);
  assert.ok(draft); assert.deepEqual(idsFor(id), publishedIds); assert.equal(idsFor(draft.id).length, 31);
  assert.equal(requests.filter(row => /\/encryption\/media\//.test(row.path)).length, retiredBeforeDraft);
  for (const photoId of publishedIds) assert.ok(f.r2.has(f.db.sqlite.prepare('SELECT original_key FROM diary_e2ee_media WHERE id=?').get(photoId).original_key));
  await page.reload(); await page.locator('#app-view').waitFor({ state: 'visible' }); await selectDrafts(true);
  await editEntry(draft.id); assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 31);
  await save('published'); assert.equal(idsFor(id).length, 31);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM diary_e2ee_records WHERE state='draft' AND source_id=?").get(id).n, 0);

  // Failed old-photo cleanup keeps the completed replacements and the editor;
  // retry must neither upload them again nor repeat their successful commit.
  await editEntry(id); await removePhotos(2); await addPhotos(2, 'cleanup-retry'); failRetire = true;
  assert.match(await save('published', { partial: true }), /画像の削除/);
  assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 31);
  const uploadsAfterCleanup = uploadRequests(), commitsAfterCleanup = commitRequests();
  failRetire = false; await save('published');
  assert.equal(uploadRequests(), uploadsAfterCleanup); assert.equal(commitRequests(), commitsAfterCleanup); assert.equal(idsFor(id).length, 31);

  // A completed session must rotate if more files are selected while cleanup
  // failed and the editor is still open.
  await editEntry(id); await removePhotos(1); await addPhotos(1, 'new-session'); failRetire = true;
  await save('published', { partial: true });
  const uploadsBeforeExtra = uploadRequests(), commitsBeforeExtra = commitRequests();
  failRetire = false; await addPhotos(1, 'extra-after-cleanup'); await save('published');
  assert.equal(uploadRequests(), uploadsBeforeExtra + 1); assert.equal(commitRequests(), commitsBeforeExtra + 1); assert.equal(idsFor(id).length, 32);

  // A photo attachment can succeed before the upload-commit HTTP call fails.
  // Retry must retain all input and reconcile that known attachment revision.
  await editEntry(id); await removePhotos(2); await addPhotos(2, 'commit-retry'); failCommit = true;
  assert.match(await save('published', { partial: true }), /写真の反映/);
  const uploadsAfterCommit = uploadRequests();
  assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 32);
  const removedPending = page.locator('#editor-photo-list [data-photo-action="remove"]').filter({ hasText: '取り除く' }).last();
  const removedPendingId = await removedPending.getAttribute('data-photo-id'); await removedPending.click();
  await addPhotos(1, 'extra-after-commit-failure');
  assert.equal(uploadRequests(), uploadsAfterCommit, 'defer new uploads until the previous commit is recovered');
  failCommit = false; await save('published');
  assert.equal(uploadRequests(), uploadsAfterCommit + 1); assert.equal(idsFor(id).length, 32); assert.ok(!idsFor(id).includes(removedPendingId));
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM diary_e2ee_records WHERE state='published'").get().n, 1);

  // An attachment mutation that failed before writing must be retried before
  // another entry mutation can invalidate its signed expected revision.
  await editEntry(id); await removePhotos(1); await addPhotos(1, 'attachment-retry'); failAttachment = true;
  await save('published', { partial: true }); const uploadsBeforeAttachmentRetry = uploadRequests();
  const removedBeforeAttachment = page.locator('#editor-photo-list [data-photo-action="remove"]').filter({ hasText: '取り除く' }).last();
  const removedBeforeAttachmentId = await removedBeforeAttachment.getAttribute('data-photo-id'); await removedBeforeAttachment.click();
  const retainedUpload = f.db.sqlite.prepare('SELECT status,original_key FROM diary_e2ee_media WHERE id=?').get(removedBeforeAttachmentId);
  assert.equal(retainedUpload.status, 'ready'); assert.ok(f.r2.has(retainedUpload.original_key), 'the pending original remains available for its signed attachment retry');
  await addPhotos(1, 'replacement-before-attachment');
  failAttachment = false; await save('published'); assert.equal(uploadRequests(), uploadsBeforeAttachmentRetry + 1); assert.equal(idsFor(id).length, 32);
  assert.ok(!idsFor(id).includes(removedBeforeAttachmentId));

  // Finalization failure resumes without repeating an already confirmed commit.
  await editEntry(id); await removePhotos(1); await addPhotos(1, 'finalize-retry'); afterCommit = false; failFinalize = true;
  await save('published', { partial: true }); const commitsBeforeFinalizeRetry = commitRequests();
  failFinalize = false; await save('published'); assert.equal(commitRequests(), commitsBeforeFinalizeRetry); assert.equal(idsFor(id).length, 32);

  // Lost commit response followed by Save Draft must finish the original
  // operation first, preserving both published source and the editing draft.
  await editEntry(id); await removePhotos(1); await addPhotos(1, 'lost-commit'); await page.evaluate(() => { window.losePhotoCommitReply = true; });
  await save('published', { partial: true }); const uploadsBeforeDraftRecovery = uploadRequests();
  await save('draft'); assert.equal(uploadRequests(), uploadsBeforeDraftRecovery); assert.equal(idsFor(id).length, 32);
  const recoveredDraft = f.db.sqlite.prepare("SELECT id FROM diary_e2ee_records WHERE state='draft' AND source_id=?").get(id);
  assert.ok(recoveredDraft); assert.equal(idsFor(recoveredDraft.id).length, 32);
  await editEntry(recoveredDraft.id); assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 32); await save('published');

  // A genuine concurrent edit must still stop recovery without overwriting it.
  await editEntry(id); await removePhotos(1); await addPhotos(1, 'conflict'); afterCommit = false; failFinalize = true;
  await save('published', { partial: true }); await externalUpdate(id);
  const externalEnvelope = f.db.sqlite.prepare('SELECT envelope FROM diary_e2ee_records WHERE id=?').get(id).envelope;
  const editorTitle = await page.inputValue('#entry-title'); failFinalize = false;
  assert.match(await save('published', { partial: true }), /別の端末|RevisionConflict/);
  assert.equal(f.db.sqlite.prepare('SELECT envelope FROM diary_e2ee_records WHERE id=?').get(id).envelope, externalEnvelope);
  assert.equal(await page.inputValue('#entry-title'), editorTitle); assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 32);
  assert.equal(requests.filter(row => row.method === 'DELETE' && /^\/diary\/api\/photos\//.test(row.path)).length, 0);
  for (const photoId of idsFor(id)) {
    const media = f.db.sqlite.prepare('SELECT household,status,original_key FROM diary_e2ee_media WHERE id=?').get(photoId);
    assert.equal(media.household, user.claims.households[0]); assert.equal(media.status, 'attached');
    assert.ok(photoHeader(f.r2.get(media.original_key).bytes));
  }
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('PHOTO_EDIT_PRIVATE'), false);
  assert.equal(JSON.stringify(requests).includes('PHOTO_EDIT_PRIVATE'), false);
  user.active = false;
  await page.click('#save-entry-button'); await page.locator('#passkey-login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#editor-dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await page.inputValue('#entry-title'), '');
  assert.equal(await page.locator('#entry-content').innerText(), '');
  assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Encrypted photo editing: 2-to-31 replacement, photo-only draft reopen/publish, source preservation, cleanup/attachment/commit/finalize failures, lost response, added/removed photos during recovery, session rotation, no duplicate uploads and concurrent-edit protection passed.');
} finally {
  await context?.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); await f.close();
}
