import assert from 'node:assert/strict';
import { db, env, context, api, handoff, securityDb } from './session-fixture.mjs';

// Exercise the real Worker with SQLite and the existing passkey ledger fixture.
// Count D1 calls rather than asserting machine-dependent elapsed times.
for (let id = 100; id <= 125; id++) {
  db.prepare('INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(?,?,?,?)')
    .run(id, id === 100 ? null : id - 1, `ancestor-${id}`, 'admin');
}
for (let id = 200; id <= 202; id++) {
  db.prepare('INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(?,105,?,?)')
    .run(id, `child-${id}`, 'admin');
}
for (let id = 1000; id <= 1002; id++) {
  db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,
    size_bytes,status,created_by,created_at,display_metadata_version,display_name,display_mime_type,display_media_kind)
    VALUES(?,105,?,?,'text/plain','document',?,'ready','admin',?,1,?,'text/plain','document')`)
    .run(id, `fixture-${id}`, `file-${id}.txt`, id, `2026-10-${id - 999} 00:00:00`, `file-${id}.txt`);
}
db.prepare(`UPDATE cloud_files SET crypto_version=1,encrypted_metadata='fixture-cipher',metadata_iv='fixture-iv',
  wrapped_file_key='fixture-envelope',file_key_iv='fixture-wrap-iv',thumbnail_key='fixture-thumbnail' WHERE id=1000`).run();
db.prepare(`UPDATE cloud_folders SET crypto_version=1,encrypted_name='folder-cipher',name_iv='folder-iv',
  password_salt='folder-salt',password_wrapped_key='password-envelope',password_wrap_iv='password-iv',
  admin_wrapped_key='admin-envelope',parent_wrapped_key='parent-envelope',parent_wrap_iv='parent-iv' WHERE id=105`).run();
// A member's assigned root can itself have an ancestor outside its scope.
db.prepare('UPDATE cloud_folders SET parent_id=100 WHERE id=7').run();

const admin = await handoff('admin'), member = await handoff('folder-member');
const originalPrepare = env.DB.prepare, originalBatch = env.DB.batch;
const originalValidation = env.SECURITY.validatePasskeySession;
const originalLedger = env.SECURITY.cloudPasskeySession;
let calls;
const reset = () => { calls = { trips: 0, batches: 0, ancestorReads: 0, validations: 0, ledger: [] }; };
reset();
env.DB.prepare = (sql) => {
  const wrap = (statement) => ({
    bind(...values) { return wrap(statement.bind(...values)); },
    ...Object.fromEntries(['first', 'all', 'run'].map(method => [method, async (...args) => {
      calls.trips++;
      if (sql.includes('WITH RECURSIVE ancestors')) calls.ancestorReads++;
      return statement[method](...args);
    }])),
    // Only the fixture batch adapter reads this original statement.
    original: statement, sql
  });
  return wrap(originalPrepare(sql));
};
env.DB.batch = async (statements) => {
  calls.trips++; calls.batches++;
  calls.ancestorReads += statements.filter(statement => statement.sql.includes('WITH RECURSIVE ancestors')).length;
  return originalBatch(statements.map(statement => statement.original));
};
env.SECURITY.validatePasskeySession = input => { calls.validations++; return originalValidation(input); };
env.SECURITY.cloudPasskeySession = input => { calls.ledger.push(input.action); return originalLedger(input); };
const get = (session, path, headers = {}) => api(session?.cookie, path, 'GET', undefined, {
  ...(session ? { 'X-TCloud-Session': session.body.sessionCacheId, 'X-TCloud-Activity': 'foreground' } : {}), ...headers
});

try {
  const first = await get(admin, '/items?folderId=105&pageSize=2&sort=name-asc');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.breadcrumbs.map(folder => folder.id), [100, 101, 102, 103, 104, 105]);
  assert.deepEqual(first.body.folders.map(folder => folder.id), [106, 200]);
  assert.deepEqual(first.body.files.map(file => file.id), [1000, 1001]);
  assert.equal(first.body.nextFolderOffset, 2); assert.equal(first.body.nextFileOffset, 2);
  assert.equal(first.body.files[0].encryptedMetadata, 'fixture-cipher');
  assert.equal(first.body.files[0].wrappedFileKey, 'fixture-envelope');
  assert.equal(first.body.files[0].hasThumbnail, 1);
  assert.ok(first.body.breadcrumbs.every(folder => folder.adminAccess && folder.isUnlocked));
  assert.deepEqual(first.body.breadcrumbs.at(-1), {
    id: 105, parentId: 104, name: 'ancestor-105', cryptoVersion: 1, encryptedName: 'folder-cipher', nameIv: 'folder-iv',
    passwordSalt: 'folder-salt', passwordWrappedKey: 'password-envelope', passwordWrapIv: 'password-iv',
    adminWrappedKey: 'admin-envelope', parentWrappedKey: 'parent-envelope', parentWrapIv: 'parent-iv',
    isProtected: false, isUnlocked: true, adminAccess: true
  }, 'preserve every breadcrumb field used for folder names and client-side key unwrapping');
  assert.deepEqual({ trips: calls.trips, batches: calls.batches, ancestorReads: calls.ancestorReads },
    { trips: 2, batches: 1, ancestorReads: 1 }, 'admin listing and breadcrumbs share one D1 batch after the folder lookup');
  assert.equal(calls.validations, 2, 'initial ledger read and final touch both validate live authority');
  assert.deepEqual(calls.ledger, ['read', 'touch'], 'renewal reuses only the request-local initial read');

  for (const [flag, key, expected] of [
    ['filesOnly', 'files', [1002]], ['foldersOnly', 'folders', [201, 202]]
  ]) {
    reset();
    const next = await get(admin, `/items?folderId=105&pageSize=2&sort=name-asc&offset=2&continuation=1&${flag}=1`);
    assert.equal(next.status, 200);
    assert.deepEqual(next.body[key].map(item => item.id), expected);
    assert.deepEqual(next.body.breadcrumbs, []);
    assert.deepEqual(next.body[flag === 'filesOnly' ? 'folders' : 'files'], []);
    assert.equal(calls.batches, 0, 'single-surface continuation does not run an extra SELECT');
    assert.equal(calls.ancestorReads, 0);
    assert.equal(next.body[flag === 'filesOnly' ? 'nextFileOffset' : 'nextFolderOffset'], null);
  }
  const descending = await get(admin, '/items?folderId=105&pageSize=2&sort=size-desc');
  assert.deepEqual(descending.body.files.map(file => file.id), [1002, 1001]);
  const filtered = await get(admin, '/items?folderId=105&q=file-1001&kind=document');
  assert.deepEqual(filtered.body.files.map(file => file.id), [1001]);
  const uploadIndex = await get(admin, '/items?folderId=105&uploadIndex=1&pageSize=1&sort=name-asc');
  assert.equal(uploadIndex.body.files.length, 3); assert.equal(uploadIndex.body.folders.length, 4);
  assert.equal(uploadIndex.body.nextFolderOffset, null); assert.equal(uploadIndex.body.nextFileOffset, null);
  reset();
  const root = await get(admin, '/items');
  assert.equal(root.status, 200); assert.deepEqual(root.body.breadcrumbs, []);
  assert.deepEqual(root.body.files, []); assert.equal(calls.trips, 1); assert.equal(calls.batches, 0);

  const bounded = await get(admin, '/items?folderId=125');
  assert.deepEqual(bounded.body.breadcrumbs.map(folder => folder.id), Array.from({ length: 20 }, (_, i) => 106 + i));
  db.prepare("UPDATE cloud_folders SET deleted_at=CURRENT_TIMESTAMP WHERE id=124").run();
  const deletedParent = await get(admin, '/items?folderId=125');
  assert.deepEqual(deletedParent.body.breadcrumbs.map(folder => folder.id), [125]);
  db.prepare('UPDATE cloud_folders SET deleted_at=NULL WHERE id=124').run();

  reset();
  const own = await get(member, '/items?folderId=8');
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.breadcrumbs.map(folder => folder.id), [7, 8], 'never include ancestors outside the member root');
  assert.equal(own.body.breadcrumbs[0].isUnlocked, true);
  assert.ok(own.body.breadcrumbs.every(folder => !folder.adminAccess));
  assert.equal(calls.trips, 5, 'three listing trips plus both live session root checks');
  assert.deepEqual(calls.ledger, ['read', 'touch']);
  for (let id = 300; id <= 304; id++) {
    db.prepare('INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(?,?,?,?)')
      .run(id, id === 300 ? 7 : id - 1, `deep-${id}`, 'admin');
  }
  reset();
  const deep = await get(member, '/items?folderId=304');
  assert.equal(deep.status, 200);
  assert.deepEqual(deep.body.breadcrumbs.map(folder => folder.id), [7, 300, 301, 302, 303, 304]);
  assert.equal(calls.trips, 5, 'six levels must not add any D1 round trips, including both session root checks');
  assert.equal(calls.validations, 2);
  db.prepare("UPDATE cloud_folders SET password_hash='fixture-locked' WHERE id=302").run();
  reset();
  assert.equal((await get(member, '/items?folderId=304')).status, 423);
  assert.equal(calls.batches, 0, 'locked folders never read either listing or breadcrumbs');
  db.prepare('INSERT INTO cloud_folder_unlocks(session_id,folder_id,expires_at) VALUES(?,?,?)')
    .run(member.body.sessionCacheId, 302, Math.floor(Date.now() / 1000) + 60);
  assert.equal((await get(member, '/items?folderId=304')).status, 200);
  db.prepare('UPDATE cloud_folder_unlocks SET expires_at=0 WHERE folder_id=302').run();
  assert.equal((await get(member, '/items?folderId=304')).status, 423, 'an earlier success cannot retain expired authority');
  db.prepare('UPDATE cloud_folders SET password_hash=NULL WHERE id=302').run();
  db.prepare('UPDATE cloud_folders SET deleted_at=CURRENT_TIMESTAMP WHERE id=302').run();
  assert.equal((await get(member, '/items?folderId=304')).status, 403, 'a deleted ancestor breaks member scope');
  db.prepare('UPDATE cloud_folders SET deleted_at=NULL WHERE id=302').run();
  // Compare against the unchanged access walk used by other endpoints, including
  // its exact depth bound, nearest assigned root and lock/error precedence.
  const directSession = { role: 'member', rootFolderId: 7, serviceLinkId: 'fixture', sessionId: 'direct-fixture' };
  const outcome = async (check, folderId, session = directSession) => {
    try { await check(env, folderId, session); return 200; } catch (error) { return error.status; }
  };
  const equivalent = async (folderId, expected, session = directSession) => {
    assert.equal(await outcome(context.requireFolderAccess, folderId, session), expected);
    reset();
    assert.equal(await outcome(context.requireMemberListingScope, folderId, session), expected);
    assert.equal(calls.trips, 1, 'a member listing access check always uses one query');
  };
  for (const [folderId, expected] of [[7, 200], [8, 200], [11, 423], [9, 403], [999999, 403]]) {
    await equivalent(folderId, expected);
  }
  for (let id = 10000; id < 10100; id++) {
    db.prepare('INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(?,?,?,?)')
      .run(id, id === 10000 ? 7 : id - 1, `bounded-${id}`, 'admin');
  }
  await equivalent(10098, 200); // 99 descendants plus the assigned root.
  await equivalent(10099, 403);
  db.prepare("UPDATE cloud_folders SET password_hash='fixture-lock' WHERE id=10040").run();
  await equivalent(10098, 423);
  await equivalent(10098, 200, { ...directSession, folderScopes: [
    { serviceLinkId: 'outer', rootFolderId: 7 }, { serviceLinkId: 'inner', rootFolderId: 10050 }
  ] });
  db.prepare('INSERT INTO cloud_folder_unlocks(session_id,folder_id,expires_at) VALUES(?,?,?)')
    .run(directSession.sessionId, 10040, Math.floor(Date.now() / 1000) + 60);
  await equivalent(10098, 200);
  db.prepare('UPDATE cloud_folder_unlocks SET expires_at=0 WHERE session_id=?').run(directSession.sessionId);
  await equivalent(10098, 423);
  db.prepare('UPDATE cloud_folders SET parent_id=10001 WHERE id=10000').run();
  await equivalent(10098, 403, directSession);
  const search = await get(member, '/items?folderId=8&searchCandidates=1');
  assert.equal(search.status, 200); assert.deepEqual(search.body.breadcrumbs.map(folder => folder.id), [7, 8]);
  for (const [path, expected] of [['/items?folderId=9', 403], ['/items?folderId=11', 423], ['/items?folderId=999999', 404]]) {
    reset(); const denied = await get(member, path);
    assert.equal(denied.status, expected); assert.equal(calls.batches, 0); assert.equal(calls.ancestorReads, 0);
  }
  reset(); assert.equal((await get(null, '/items?folderId=105')).status, 401); assert.equal(calls.trips, 0);
  reset(); assert.equal((await get(admin, '/items?folderId=105', { 'X-TCloud-Session': 'other-tab' })).status, 419);
  assert.equal(calls.trips, 0);
  securityDb.prepare("UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP WHERE service_account_id='admin'").run();
  reset(); assert.equal((await get(admin, '/items?folderId=105')).status, 401); assert.equal(calls.trips, 0);

  // Preserve the old traversal bound even for malformed cyclic folder data.
  db.prepare('UPDATE cloud_folders SET parent_id=105 WHERE id=100').run();
  const cyclic = await context.breadcrumbs(env, 105, { role: 'admin', sessionId: 'cyclic-fixture' });
  assert.equal(cyclic.length, 20); assert.equal(cyclic.at(-1).id, 105);
  console.log('folder listing: batching, breadcrumbs, paging, filters, member boundaries and unchanged passkey checks: ok');
} finally {
  env.DB.prepare = originalPrepare; env.DB.batch = originalBatch;
  env.SECURITY.validatePasskeySession = originalValidation; env.SECURITY.cloudPasskeySession = originalLedger;
}
