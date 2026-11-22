import { billingLegacyApi, billingLegacyRecovery } from "./legacy-api.js";
import { billingEncryptedDigest, verifyBillingState } from "../public/billing-crypto.mjs";
import { billingMigrationState, freezeBillingMigrationSource, readBillingMigrationPage } from "./migration-source.js";
import { attestBillingCandidate, readBillingCandidate, reserveBillingCandidate, validateBillingCiphertext, writeBillingCandidatePage } from "./migration-candidate.js";

const keyEpoch = 1;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const wrappedKey = /^(?:[A-Za-z0-9_-]{512}|[A-Za-z0-9_-]{683})$/;
const aad = new TextEncoder().encode("T-lain Billing migration challenge v1");
const legacyAad = new TextEncoder().encode("T-lain Billing archive recovery challenge v1");
const legacyPath = "/api/encryption/legacy";
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const eventTypes = new Set(["entry_created","entry_updated","entry_deleted","settlement_created","settlement_updated","settlement_deleted"]);

function id(value, HttpError) {
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(400, "移行IDを確認してください。");
  return value;
}

async function recoveryProof(env, session, purpose = "billing-migration") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encode([purpose, session.sessionId, session.startedAt, session.credentialId]));
}

function proofMatches(expected, actual) {
  const token = b64(expected);
  if (typeof actual !== "string" || actual.length !== token.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

async function listScopes(db, migration, session, primaryOwner, staging = false) {
  const scopes = db.prepare(`SELECT l.ledger_id,l.account_id,l.recovery_wrapped_key,
      a.display_name AS display_name
    FROM billing_encryption_candidate_ledgers l
    LEFT JOIN billing_accounts a ON a.id=l.account_id
    WHERE l.generation=? AND (?=1 OR (l.account_id=? AND a.is_active=1) OR (?=1 AND (l.account_id IS NULL OR a.is_active=1)))
    ORDER BY l.account_id,l.ledger_id`).bind(migration, staging && primaryOwner ? 1 : 0, session.accountId, primaryOwner ? 1 : 0);
  const grantsQuery = db.prepare(`SELECT ledger_id,key_source,wrapped_key,identity_id,credential_id,service_link_id
    FROM billing_encryption_grants WHERE generation=? AND identity_id=? AND credential_id=? AND service_link_id=?`)
    .bind(migration, session.identityId, session.credentialId, session.serviceLinkId);
  const [results, grants] = await db.batch([scopes, grantsQuery]);
  const byLedger = new Map();
  for (const row of grants.results) {
    if (!byLedger.has(row.ledger_id)) byLedger.set(row.ledger_id, []);
    byLedger.get(row.ledger_id).push({
      keySource: row.key_source, wrappedKey: row.wrapped_key,
      recipient: { identityId: row.identity_id, credentialId: row.credential_id, serviceLinkId: row.service_link_id }
    });
  }
  return results.results.map(row => ({
    ledgerId: row.ledger_id, generation: keyEpoch, accountId: row.account_id, displayName: row.display_name,
    grants: byLedger.get(row.ledger_id) ?? [], ...(primaryOwner ? { recoveryWrappedKey: row.recovery_wrapped_key } : {})
  }));
}

async function encryptedView(db, state, accountId, session, primary, HttpError) {
  if (!primary && accountId !== session.accountId) throw new HttpError(403, "台帳を確認できません。");
  const [scopes, grants, ledgers] = await db.batch([
    db.prepare(`SELECT c.ledger_id,c.account_id,a.display_name
      FROM billing_encryption_candidate_ledgers c JOIN billing_accounts a ON a.id=c.account_id
      WHERE c.generation=? AND c.account_id=? AND a.is_active=1`).bind(state.generation,accountId),
    db.prepare(`SELECT g.key_source,g.wrapped_key FROM billing_encryption_grants g
      JOIN billing_encryption_candidate_ledgers c ON c.generation=g.generation AND c.ledger_id=g.ledger_id
      WHERE g.generation=? AND c.account_id=? AND g.identity_id=? AND g.credential_id=? AND g.service_link_id=?`)
      .bind(state.generation,accountId,session.identityId,session.credentialId,session.serviceLinkId),
    db.prepare(`SELECT l.revision,l.digest,l.signature,l.writer_public_key,l.records_json
      FROM billing_encryption_live_ledgers l JOIN billing_encryption_candidate_ledgers c
        ON c.generation=l.generation AND c.ledger_id=l.ledger_id
      JOIN billing_accounts a ON a.id=c.account_id AND a.is_active=1
      WHERE l.generation=? AND c.account_id=? AND EXISTS (
        SELECT 1 FROM billing_encryption_grants g WHERE g.generation=l.generation AND g.ledger_id=l.ledger_id
        AND g.identity_id=? AND g.credential_id=? AND g.service_link_id=?)`)
      .bind(state.generation,accountId,session.identityId,session.credentialId,session.serviceLinkId)
  ]);
  const row = scopes.results[0];
  if (!row) throw new HttpError(403, "台帳を確認できません。");
  const recipient = { identityId:session.identityId, credentialId:session.credentialId, serviceLinkId:session.serviceLinkId };
  const scope = { ledgerId:row.ledger_id, generation:keyEpoch, accountId:row.account_id, displayName:row.display_name,
    grants:grants.results.map(g=>({ keySource:g.key_source, wrappedKey:g.wrapped_key, recipient })) };
  const ledger = ledgers.results[0];
  if (scope.grants.length && !ledger) throw new HttpError(404, "暗号化台帳が見つかりません。");
  return { scope, ledger: ledger ? serializeEncryptedLedger(ledger) : null };
}

function serializeEncryptedLedger(row) {
  return { revision:row.revision, digest:row.digest, signature:row.signature,
    writer:JSON.parse(row.writer_public_key), records:JSON.parse(row.records_json) };
}

function billingGrantTargets(recipients, accountId) {
  return recipients.filter(item => item.publicKey && (item.accountId === accountId
    || (item.accountId === "owner" && item.identityId === "primary-admin")));
}

const grantRecipientKey = (identity, credential, link, source) => JSON.stringify([identity,credential,link,source]);

async function pendingBillingGrants(env, state, actor, HttpError) {
  const [recipients, [scopes, grants]] = await Promise.all([
    env.SECURITY.getBillingKeyRecipients(actor),
    env.DB.batch([
      env.DB.prepare(`SELECT c.ledger_id,c.account_id,c.recovery_wrapped_key
        FROM billing_encryption_candidate_ledgers c LEFT JOIN billing_accounts a ON a.id=c.account_id
        WHERE c.generation=? AND (c.account_id IS NULL OR a.is_active=1) ORDER BY c.account_id,c.ledger_id`).bind(state.generation),
      env.DB.prepare(`SELECT ledger_id,identity_id,credential_id,service_link_id,key_source
        FROM billing_encryption_grants WHERE generation=?`).bind(state.generation)
    ])
  ]);
  if (!recipients) throw new HttpError(403, "鍵を配布する権限がありません。");
  const existing = new Map();
  for (const grant of grants.results) {
    if (!existing.has(grant.ledger_id)) existing.set(grant.ledger_id,new Set());
    existing.get(grant.ledger_id).add(grantRecipientKey(grant.identity_id,grant.credential_id,grant.service_link_id,grant.key_source));
  }
  return scopes.results.flatMap(scope => {
    const delivered = existing.get(scope.ledger_id);
    const targets = billingGrantTargets(recipients,scope.account_id).filter(recipient =>
      !delivered?.has(grantRecipientKey(recipient.identityId,recipient.credentialId,recipient.serviceLinkId,recipient.keySource)));
    return targets.length ? [{ ledgerId:scope.ledger_id,generation:keyEpoch,accountId:scope.account_id,
      recoveryWrappedKey:scope.recovery_wrapped_key,recipients:targets }] : [];
  });
}

async function saveGrants(env, state, actor, ledgerId, grants, HttpError) {
  if (!Array.isArray(grants) || grants.length > 500) throw new HttpError(400, "鍵の配布先を確認してください。");
  const ledger = await env.DB.prepare("SELECT account_id FROM billing_encryption_candidate_ledgers WHERE generation=? AND ledger_id=?")
    .bind(state.generation, ledgerId).first();
  if (!ledger) throw new HttpError(404, "暗号化台帳が見つかりません。");
  const eligible = await env.SECURITY.getBillingKeyRecipients(actor);
  if (!eligible) throw new HttpError(403, "鍵を配布する権限がありません。");
  const key = (credential, link) => JSON.stringify([credential, link]);
  const targets = new Map(billingGrantTargets(eligible,ledger.account_id)
    .map(item => [key(item.credentialId,item.serviceLinkId), item]));
  const seen = new Set();
  const statements = grants.map(grant => {
    const unique = key(grant?.credentialId, grant?.serviceLinkId);
    const target = targets.get(unique);
    if (!target || target.keySource !== grant.keySource || seen.has(unique) || typeof grant.wrappedKey !== "string"
      || !wrappedKey.test(grant.wrappedKey)) throw new HttpError(400, "鍵の配布先を確認してください。");
    seen.add(unique);
    return env.DB.prepare(`INSERT INTO billing_encryption_grants
      (generation,ledger_id,identity_id,credential_id,service_link_id,key_source,wrapped_key)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(state.generation, ledgerId, target.identityId, target.credentialId, target.serviceLinkId, target.keySource, grant.wrappedKey);
  });
  if (statements.length) await env.DB.batch(statements);
}

async function commitEncryptedLedgers(env, state, session, writer, body, HttpError) {
  const operationId = id(body?.operationId, HttpError);
  const updates = body?.updates;
  if (!Array.isArray(updates) || updates.length < 2 || updates.length > 3 || !eventTypes.has(body.eventType)
    || typeof body.targetAccountId !== "string") throw new HttpError(400, "暗号化した更新内容を確認してください。");
  const fingerprint = b64(await crypto.subtle.digest("SHA-256", encode(body)));
  const operation = () => env.DB.prepare("SELECT actor_id,fingerprint FROM billing_encryption_operations WHERE generation=? AND id=?")
    .bind(state.generation, operationId).first();
  const match = previous => previous?.actor_id === session.accountId && previous.fingerprint === fingerprint;
  const prior = await operation();
  if (prior) {
    if (!match(prior)) throw new HttpError(409, "同じ操作IDで異なる内容を保存できません。");
    return;
  }
  const ledgers = await listScopes(env.DB, state.generation, session, true);
  const known = new Map(ledgers.map(ledger => [ledger.ledgerId,ledger.accountId]));
  const accounts = new Set();
  const expected = {};
  const updatesSql = [];
  for (const next of updates) {
    const ledgerId = next?.ledgerId;
    if (!known.has(ledgerId) || Object.hasOwn(expected,ledgerId) || !Number.isSafeInteger(next.revision)
      || next.revision <= 1 || !Array.isArray(next.records) || next.records.length > 10000) {
      throw new HttpError(400, "暗号化台帳の更新内容を確認してください。");
    }
    try {
      for (const record of next.records) validateBillingCiphertext(record,next.revision);
      if (await billingEncryptedDigest(next.records) !== next.digest
        || !await verifyBillingState(writer, { ledgerId,generation:keyEpoch }, next.revision, next.digest,next.signature)) throw new Error("Signature");
    } catch {
      throw new HttpError(400, "暗号化台帳の署名を確認できません。");
    }
    const records = JSON.stringify(next.records);
    if (records.length > 1500000) throw new HttpError(413, "暗号化台帳が保存可能なサイズを超えています。");
    expected[ledgerId] = next.revision - 1;
    accounts.add(known.get(ledgerId));
    updatesSql.push(env.DB.prepare(`UPDATE billing_encryption_live_ledgers
      SET revision=?,digest=?,signature=?,writer_public_key=?,records_json=?
      WHERE generation=? AND ledger_id=?`).bind(next.revision,next.digest,next.signature,JSON.stringify(writer),records,state.generation,ledgerId));
  }
  if (!accounts.has(null) || !accounts.has(body.targetAccountId)) throw new HttpError(400, "更新先と操作履歴を確認してください。");
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO billing_encryption_operations (generation,id,actor_id,fingerprint,expected_revisions)
        VALUES (?,?,?,?,?)`).bind(state.generation,operationId,session.accountId,fingerprint,JSON.stringify(expected)),
      ...updatesSql,
      env.DB.prepare("INSERT INTO billing_audit_logs (event_type,actor_account_id,target_account_id) VALUES (?,?,?)")
        .bind(body.eventType,session.accountId,body.targetAccountId)
    ]);
  } catch (error) {
    if (match(await operation())) return;
    if (/billing encrypted revision conflict|UNIQUE constraint failed/.test(error?.message)) {
      throw new HttpError(409, "台帳が更新されました。表示を読み直してから操作してください。");
    }
    throw error;
  }
}

export async function billingEncryptionApi(request, env, url, path, session, helpers) {
  const { json, readJson, HttpError, requireRecentPasskey, billingKeySession, listAccounts, getVaultContext } = helpers;
  const actor = billingKeySession(session);
  const method = request.method;
  const startup = path === "/api/encryption/startup" && method === "GET";
  const [state, vaultContext] = await Promise.all([
    billingMigrationState(env.DB),
    startup ? getVaultContext(actor) : null
  ]);
  const active = Boolean(state?.activated_at);
  const primary = session.role === "owner" && session.accountId === "owner" && session.identityId === "primary-admin";
  const optIn = env.BILLING_MIGRATION_ENABLED === "true";
  if (startup || (path === "/api/encryption/status" && method === "GET")) {
    const status = { mode: active ? "encrypted" : state ? "migrating" : "legacy",
      canStage: primary && optIn && !active, canMaintain: primary && active && Boolean(env.BILLING_BACKUP), checkpointEnabled: Boolean(env.BILLING_BACKUP),
      canActivate: primary && env.BILLING_CUTOVER_ENABLED === "true" && !active };
    if (!startup) return json(status);
    if (!active || url.searchParams.get("maintenance") === "legacy") return json({ status,vaultContext });
    const accounts = await listAccounts(env,session);
    const account = accounts[0];
    const view = account ? await encryptedView(env.DB,state,account.id,session,primary,HttpError) : null;
    return json({ status,vaultContext,accounts,view });
  }
  if (path === "/api/encryption/view" && method === "GET" && active) {
    const requested = url.searchParams.get("accountId") || session.accountId;
    return json(await encryptedView(env.DB,state,requested,session,primary,HttpError));
  }
  if (path === "/api/encryption/ledgers" && method === "GET" && active) {
    return json({ ledgers: await listScopes(env.DB,state.generation,session,primary) });
  }
  if (path === "/api/encryption/ledger" && method === "GET" && active) {
    const ledgerId = id(url.searchParams.get("ledger"), HttpError);
    const scopes = await listScopes(env.DB,state.generation,session,primary);
    if (!scopes.some(ledger => ledger.ledgerId === ledgerId && ledger.grants.length)) throw new HttpError(403, "この台帳の鍵を利用できません。");
    const row = await env.DB.prepare(`SELECT revision,digest,signature,writer_public_key,records_json
      FROM billing_encryption_live_ledgers WHERE generation=? AND ledger_id=?`).bind(state.generation,ledgerId).first();
    if (!row) throw new HttpError(404, "暗号化台帳が見つかりません。");
    return json(serializeEncryptedLedger(row));
  }
  if (!primary) throw new HttpError(403, "第一管理者のみ操作できます。");
  if (path === "/api/encryption/pending-grants" && method === "GET" && active) {
    requireRecentPasskey(session);
    return json({ ledgers:await pendingBillingGrants(env,state,actor,HttpError) });
  }
  if (path.startsWith(`${legacyPath}/`)) {
    const authorizeLegacy = async challenge => {
      if (!challenge) {
        const fingerprint = request.headers.get("X-Billing-Recovery-Key");
        if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint ?? "") || !proofMatches(
          await recoveryProof(env, session, `billing-legacy-archive:${fingerprint}`), request.headers.get("X-Billing-Recovery-Proof")
        )) throw new HttpError(403, "旧バックアップの復旧鍵を解除してください。");
        return { fingerprint };
      }
      requireRecentPasskey(session);
      const recovery = await billingLegacyRecovery(env, actor);
      if (!recovery) throw new HttpError(409, "復旧用の鍵を確認できません。");
      const proof = await recoveryProof(env, session, `billing-legacy-archive:${recovery.fingerprint}`);
      const publicKey = await crypto.subtle.importKey("jwk", recovery.publicKey,{ name:"RSA-OAEP",hash:"SHA-256" },false,["encrypt"]);
      const encrypted = await crypto.subtle.encrypt({ name:"RSA-OAEP",label:legacyAad }, publicKey, proof);
      return { ...recovery, challenge: b64(encrypted) };
    };
    return billingLegacyApi(request, env, url, path.slice(legacyPath.length), state, actor, { ...helpers, authorizeLegacy });
  }
  if (path === "/api/encryption/commit" && method === "POST" && active) {
    const context = await env.SECURITY.getBillingVaultContext(actor);
    if (!context?.primaryOwner || !context.vault?.writer) throw new HttpError(403, "署名用のパスキーを確認できません。");
    await commitEncryptedLedgers(env,state,session,context.vault.writer.publicKey,await readJson(request,4500000),HttpError);
    return json({ ok: true });
  }
  if (state && (active || optIn) && path === "/api/encryption/grants" && method === "POST") {
    const body = await readJson(request,512000);
    await saveGrants(env,state,actor,id(body.ledgerId,HttpError),body.grants,HttpError);
    return json({ ok:true });
  }
  if (!optIn || active) throw new HttpError(404, "移行を利用できません。");
  if (path === "/api/encryption/migration/challenge" && method === "GET") {
    requireRecentPasskey(session);
    const context = await env.SECURITY.getBillingRecoveryContext(actor);
    if (!context) throw new HttpError(409, "復旧用の鍵を確認できません。");
    const publicKey = await crypto.subtle.importKey("jwk",context.publicKey,{ name:"RSA-OAEP",hash:"SHA-256" },false,["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name:"RSA-OAEP",label:aad },publicKey,await recoveryProof(env,session));
    return json({ ...context, challenge: b64(encrypted) });
  }
  if (path === "/api/encryption/migration/start" && method === "POST") {
    requireRecentPasskey(session);
    const body = await readJson(request,4096);
    if (!proofMatches(await recoveryProof(env,session),body?.proof)) throw new HttpError(403, "復旧鍵の解除を確認できません。");
    const vault = await env.SECURITY.getBillingVaultContext(actor);
    if (!vault?.primaryOwner || !vault.vault?.writer) throw new HttpError(403, "署名用のパスキーを確認できません。");
    const migration = state?.generation ?? id(body.generation,HttpError);
    const frozen = await freezeBillingMigrationSource(env.DB,migration,vault.vault.writer.publicKey);
    if (frozen.writer_public_key !== JSON.stringify(vault.vault.writer.publicKey)) throw new HttpError(409, "移行を開始したパスキーでログインしてください。");
    const accounts = await env.DB.prepare("SELECT id,display_name FROM billing_accounts ORDER BY id").all();
    return json({ migration, accounts: accounts.results.map(row => ({ id: row.id,displayName: row.display_name })) });
  }
  if (!state) throw new HttpError(409, "移行を開始してください。");
  if (path === "/api/encryption/migration/source" && method === "GET") {
    return json(await readBillingMigrationPage(env.DB, {
      generation: state.generation, collection: url.searchParams.get("collection"), accountId: url.searchParams.get("account"),
      after: Number(url.searchParams.get("after") || 0)
    }));
  }
  if (path === "/api/encryption/migration/ledgers" && method === "GET") {
    return json({ ledgers: await listScopes(env.DB,state.generation,session,true,true) });
  }
  if (path === "/api/encryption/migration/ledger" && method === "GET") {
    return json(await readBillingCandidate(env.DB,state.generation,{ ledgerId:id(url.searchParams.get("ledger"),HttpError), generation:keyEpoch }));
  }
  if (path === "/api/encryption/migration/ledger" && method === "POST") {
    const body = await readJson(request,4096);
    if (typeof body.recoveryWrappedKey !== "string" || !wrappedKey.test(body.recoveryWrappedKey) || body.revision !== 1
      || (body.accountId !== null && typeof body.accountId !== "string")) throw new HttpError(400, "移行用の台帳を確認してください。");
    await reserveBillingCandidate(env.DB,state.generation,{ ledgerId:id(body.ledgerId,HttpError),generation:keyEpoch },body.accountId,body);
    return json({ ok:true });
  }
  if (path === "/api/encryption/migration/records" && method === "POST") {
    const body = await readJson(request,1500000);
    await writeBillingCandidatePage(env.DB,state.generation,{ ledgerId:id(body.ledgerId,HttpError),generation:keyEpoch },body.records);
    return json({ ok:true });
  }
  if (path === "/api/encryption/migration/attest" && method === "POST") {
    const body = await readJson(request,4096);
    await attestBillingCandidate(env.DB,state.generation,{ ledgerId:id(body.ledgerId,HttpError),generation:keyEpoch },body,JSON.parse(state.writer_public_key));
    return json({ ok:true });
  }
  if (path === "/api/encryption/migration/checkpoint" && method === "POST") {
    if (!env.BILLING_BACKUP) throw new HttpError(503, "台帳バックアップの準備を確認できません。");
    return json(await env.BILLING_BACKUP.writeCheckpoint(state.generation));
  }
  if (path === "/api/encryption/migration/activate" && method === "POST") {
    if (!env.BILLING_BACKUP || env.BILLING_CUTOVER_ENABLED !== "true") {
      throw new HttpError(409, "本番台帳の切り替えはまだ有効になっていません。");
    }
    const body = await readJson(request,4096);
    const checkpoint = await env.BILLING_BACKUP.readCheckpoint(state.generation);
    const digest = b64(Uint8Array.from(checkpoint.payloadSha256.match(/../g),byte => parseInt(byte,16)));
    const writer = JSON.parse(state.writer_public_key);
    if (body.archiveSha256 !== checkpoint.archiveSha256 || !await verifyBillingState(writer,
      { ledgerId:state.generation,generation:keyEpoch },1,digest,body.signature)) {
      throw new HttpError(400, "復元後の台帳を照合できません。");
    }
    const ledgers = checkpoint.payload.ledgers;
    const writes = ledgers.map(ledger => env.DB.prepare(`INSERT INTO billing_encryption_live_ledgers
      (generation,ledger_id,revision,digest,signature,writer_public_key,records_json) VALUES (?,?,?,?,?,?,?)`)
      .bind(state.generation,ledger.ledgerId,1,ledger.digest,ledger.signature,state.writer_public_key,JSON.stringify(ledger.records)));
    await env.DB.batch([...writes,env.DB.prepare(`UPDATE billing_encryption_migration SET
      activated_at=CURRENT_TIMESTAMP,verified_checkpoint=? WHERE generation=? AND activated_at IS NULL`)
      .bind(checkpoint.archiveSha256,state.generation)]);
    return json({ ok:true });
  }
  throw new HttpError(404, "移行操作が見つかりません。");
}
