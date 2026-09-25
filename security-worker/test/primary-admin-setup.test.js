import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import vm from "node:vm";

globalThis.window = globalThis;
await import("../../cloud-worker/public/vendor/argon2.umd.min.js");
await import("../../cloud-worker/public/crypto-vault.js");
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function extract(name, text = source) {
  const start = text.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf("\nasync function ", start + 1));
}
const accountKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const vault = await TRoomCrypto.createVault(accountKey);
const prfA = crypto.getRandomValues(new Uint8Array(32)), prfB = crypto.getRandomValues(new Uint8Array(32));
const envelopeA = await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey, vault.payload, prfA);
const envelopeB = await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey, vault.payload, prfB);

function fixture({ legacy = false, bootstrap = false } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','owner','active',1);
    INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES
      ('cloud-admin','primary-admin','cloud','admin','Cloud','active'),('diary','primary-admin','diary','main-admin','Diary','active'),
      ('billing','primary-admin','billing','main-admin','Billing','active'),('ai','primary-admin','ai','admin','AI','active'),
      ('downloader','primary-admin','downloader','admin','Downloader','active'),
      ('downloader2','primary-admin','downloader2','owner','Downloader 2','active');
    INSERT INTO security_invitations(id,identity_id,token_hash,link_set_hash,expires_at,status,created_by_identity_id)
      VALUES('invite','primary-admin','token','links',9999999999,'used','primary-admin');
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,prf_enabled,status,registered_via_invitation_id)
      VALUES('credential-A','primary-admin','public','salt',1,'active',NULL),
      ('credential-B','primary-admin','public','salt',0,'${legacy ? "active" : "pending"}',${bootstrap ? "NULL" : "'invite'"});
    INSERT INTO security_setup_sessions(id,token_hash,identity_id,credential_id,expires_at)
      VALUES('setup-B','setup-token','primary-admin','credential-B',9999999999);`);
  db.prepare(`INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv)
    VALUES('envelope-A','primary-admin','credential-A','cloud-admin','admin_private_prf',?,?)`).run(envelopeA.encryptedPayload, envelopeA.payloadIv);
  function statement(sql, args = []) {
    return { bind(...values) { return statement(sql, values); }, async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; } };
  }
  const env = { DB: { prepare: statement, async batch(statements) {
    db.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } } };
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const actor = { identityId: "primary-admin", credentialId: "credential-B", setupId: "setup-B" };
  const context = { PRIMARY_ADMIN_ID: "primary-admin", SETUP_UV_TTL_SECONDS: 300, HANDOFF_TTL_SECONDS: 60, crypto, Headers, URL,
    HttpError, parseJson: (s, fallback) => s ? JSON.parse(s) : fallback, nowSeconds: () => Math.floor(Date.now() / 1000),
    readJson: async body => body, validCredentialId: id => id, normalizeSecretText: s => s || "",
    requireSetupOrIdentitySession: async () => actor,
    requireSetupSession: async () => ({ ...actor, ...db.prepare("SELECT * FROM security_setup_sessions WHERE id='setup-B'").get() }),
    currentSetupActor: async () => actor, readSetupSession: async () => null,
    requireActiveIdentitySession: async () => {
      if (db.prepare("SELECT status FROM security_credentials WHERE credential_id=?").get(actor.credentialId).status !== "active") throw new HttpError(403, "pending");
      return actor;
    },
    // The unchanged WebAuthn verifier is the cryptographic boundary. Exercise
    // both its UV-verified and rejected results without a physical authenticator.
    consumeChallenge: async (_env, _id, _purpose, identityId) => { assert.equal(identityId, actor.identityId); return { challenge: "fixture" }; },
    verifyAuthentication: async () => ({ verified: true, authenticationInfo: { userVerified: true, newCounter: 2 } }),
    securitySessionHeaders: async () => new Headers(), localAuditStatement: async () => ({ run: async () => ({}) }),
    passkeysEnabled: () => true, observePasskeyRuntime: async () => ({ enabled: true, epoch: 1 }), normalizeService: s => s,
    randomToken: () => crypto.randomUUID(), sha256: async s => createHash("sha256").update(s).digest("hex"), publicLink: async (_env, link) => link,
    json: body => body, setupCookie: () => "fixture", prepareSetupSession: async () => ({ token: "fixture" }),
    insertSetupSessionStatement: () => ({ run: async () => ({}) }) };
  vm.createContext(context);
  for (const name of ["credentialForIdentity", "tcloudSetupStatus", "setupStatus", "resumeSetup", "prfVerify", "saveOwnTCloudEnvelope", "approveIdentity", "activeLinks", "tcloudEnvelopeBundle", "createHandoff"]) vm.runInContext(extract(name), context);
  const beforeA = db.prepare("SELECT * FROM security_credentials WHERE credential_id='credential-A'").get();
  const beforeEnvelopeA = db.prepare("SELECT * FROM security_tcloud_key_envelopes WHERE credential_id='credential-A'").get();
  return { db, env, context, actor, beforeA, beforeEnvelopeA,
    verify: available => context.prfVerify({ response: { id: actor.credentialId }, prfAvailable: available }, env, new URL("https://example.test/security/")),
    save: () => context.saveOwnTCloudEnvelope({ serviceLinkId: "cloud-admin", envelopeType: "admin_private_prf", ...envelopeB }, env),
    approve: () => context.approveIdentity("primary-admin", { credentialId: "credential-B" }, env, { identityId: "primary-admin" }) };
}

test("new primary-admin B remains pending until its own PRF envelope, then shares existing Identity links with A", async () => {
  const f = fixture(); try {
    await assert.rejects(f.approve(), e => e.status === 409);
    await assert.rejects(f.context.createHandoff({ service: "cloud" }, f.env), e => e.status === 403);
    await f.verify(true); await f.save();
    assert.equal(f.db.prepare("SELECT status FROM security_credentials WHERE credential_id='credential-B'").get().status, "pending");
    await f.approve();
    assert.equal(f.db.prepare("SELECT status FROM security_credentials WHERE credential_id='credential-B'").get().status, "active");
    assert.deepEqual(f.db.prepare("SELECT * FROM security_credentials WHERE credential_id='credential-A'").get(), f.beforeA);
    assert.deepEqual(f.db.prepare("SELECT * FROM security_tcloud_key_envelopes WHERE credential_id='credential-A'").get(), f.beforeEnvelopeA);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM security_service_links").get().n, 6);
    for (const credentialId of ["credential-A", "credential-B"]) {
      f.actor.credentialId = credentialId;
      for (const service of ["diary", "billing", "ai", "downloader", "downloader2"]) {
        const links = await f.context.activeLinks(f.env, "primary-admin", service, credentialId);
        assert.equal(links[0].identity_id, "primary-admin");
      }
      const handoff = await f.context.createHandoff({ service: "cloud", linkId: "cloud-admin" }, f.env);
      assert.equal(handoff.link.service_account_id, "admin");
      const expected = credentialId === "credential-A" ? envelopeA : envelopeB;
      assert.equal(handoff.tcloudKey.admin_private_prf.encryptedPayload, expected.encryptedPayload);
      const ownPrf = credentialId === "credential-A" ? prfA : prfB;
      const key = await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(ownPrf, handoff.tcloudKey.admin_private_prf);
      const plain = new TextEncoder().encode("same admin key");
      const cipher = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, await crypto.subtle.importKey("jwk", vault.publicKeyJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]), plain);
      assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, cipher)), plain);
    }
    await assert.rejects(TRoomCrypto.unlockAdminPrivateKeyWithPasskey(prfA, envelopeB));
  } finally { f.db.close(); }
});

test("legacy active B with PRF=0 is resumable and repairable without changing A", async () => {
  const f = fixture({ legacy: true }); try {
    assert.equal((await f.context.setupStatus({}, f.env)).resumable, true);
    assert.equal((await f.context.resumeSetup({}, f.env, new URL("https://example.test"))).active, true);
    // Fixture resume uses a stub insert; restore its active capability for save.
    f.db.exec("UPDATE security_setup_sessions SET status='active' WHERE id='setup-B'");
    await assert.rejects(f.save(), e => e.status === 401);
    await f.verify(true); await f.save();
    assert.equal((await f.context.tcloudSetupStatus(f.env, "primary-admin", "credential-B", {})).tcloudReady, true);
    assert.deepEqual(f.db.prepare("SELECT * FROM security_tcloud_key_envelopes WHERE credential_id='credential-A'").get(), f.beforeEnvelopeA);
  } finally { f.db.close(); }
});

test("only a verified same-credential UV assertion promotes PRF; absence never downgrades or grants setup UV", async () => {
  const f = fixture(); try {
    await f.verify(false);
    assert.equal(f.db.prepare("SELECT last_user_verification_at FROM security_setup_sessions").get().last_user_verification_at, null);
    f.context.verifyAuthentication = async () => ({ verified: true, authenticationInfo: { userVerified: false } });
    await assert.rejects(f.verify(true), e => e.status === 401);
    assert.equal(f.db.prepare("SELECT prf_enabled FROM security_credentials WHERE credential_id='credential-B'").get().prf_enabled, 0);
    await assert.rejects(f.context.prfVerify({ response: { id: "credential-A" }, prfAvailable: true }, f.env, new URL("https://example.test")), e => e.status === 403);
    f.context.verifyAuthentication = async () => ({ verified: true, authenticationInfo: { userVerified: true, newCounter: 3 } });
    await f.verify(true); await f.verify(false);
    assert.equal(f.db.prepare("SELECT prf_enabled FROM security_credentials WHERE credential_id='credential-B'").get().prf_enabled, 1);
  } finally { f.db.close(); }
});

test("password-authorized bootstrap B activates only in the envelope transaction", async () => {
  assert.match(extract("bootstrapVerify"), /'pending', NULL/);
  const f = fixture({ bootstrap: true }); try {
    await f.verify(true); await f.save();
    assert.equal(f.db.prepare("SELECT status FROM security_credentials WHERE credential_id='credential-B'").get().status, "active");
    assert.deepEqual(f.db.prepare("SELECT * FROM security_credentials WHERE credential_id='credential-A'").get(), f.beforeA);
  } finally { f.db.close(); }
});

test("reinvitation registration adds B as pending and preserves A and its shared links", async () => {
  const f = fixture(); try {
    f.db.exec("DELETE FROM security_setup_sessions WHERE credential_id='credential-B'; DELETE FROM security_credentials WHERE credential_id='credential-B'; UPDATE security_invitations SET status='active' WHERE id='invite'");
    Object.assign(f.context, {
      requireUsableInvitation: async () => ({ id: "invite", identity_id: "primary-admin", link_set_hash: "links" }),
      serviceLinkSetHash: async () => "links",
      consumeChallenge: async () => ({ invitation_id: "invite", challenge: "verified-registration" }),
      verifyRegistration: async () => ({ verified: true, registrationInfo: { userVerified: true, credential: { id: "credential-B", publicKey: new Uint8Array([1, 2]), counter: 0 }, credentialDeviceType: "singleDevice", credentialBackedUp: false } }),
      bytesToBase64Url: bytes => Buffer.from(bytes).toString("base64url"),
      prepareSetupSession: async () => ({ id: "setup-B", token: "fixture", identityId: "primary-admin", credentialId: "credential-B" }),
      insertSetupSessionStatement: (_env, setup) => f.env.DB.prepare("INSERT INTO security_setup_sessions(id,token_hash,identity_id,credential_id,expires_at) VALUES(?,?,?,?,9999999999)").bind(setup.id, "new-token", setup.identityId, setup.credentialId)
    });
    vm.runInContext(extract("invitationVerify"), f.context);
    const registered = await f.context.invitationVerify({ token: "fixture", prfEnabled: false }, f.env, new URL("https://example.test"));
    assert.equal(registered.identityId, "primary-admin");
    assert.equal(registered.pendingApproval, true);
    assert.equal(f.db.prepare("SELECT status FROM security_credentials WHERE credential_id='credential-B'").get().status, "pending");
    assert.deepEqual(f.db.prepare("SELECT * FROM security_credentials WHERE credential_id='credential-A'").get(), f.beforeA);
    assert.deepEqual(f.db.prepare("SELECT * FROM security_tcloud_key_envelopes WHERE credential_id='credential-A'").get(), f.beforeEnvelopeA);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM security_service_links").get().n, 6);
  } finally { f.db.close(); }
});

const uiSource = readFileSync(new URL("../public/security.js", import.meta.url), "utf8");
function uiFunction(name) {
  const start = uiSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  const rest = uiSource.slice(start);
  const end = rest.slice(1).search(/\n  (?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
function uiFixture() {
  const elements = new Map(), calls = [], messages = [];
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, value: selector.endsWith("-id") ? "admin@test" : "fixture-password" });
    return elements.get(selector);
  };
  let setup = { active: true, resumable: false, identityId: "primary-admin", credentialId: "credential-B", isPrimaryAdmin: true,
    credentialStatus: "pending", pendingApproval: true, prfEnabled: false, tcloudReady: false, adminKeyReady: false, clientKeyReady: true,
    cloudLinks: [{ id: "cloud-admin", accountId: "admin" }] };
  const context = { $, state: {}, TRoomPasskeys: {
    setupStatus: async () => ({ ...setup }), obtainPrf: async id => { assert.equal(id, "credential-B"); calls.push("prf"); setup.prfEnabled = true; return { prfOutput: prfB }; },
    userMessage: e => e.message
  }, TRoomCrypto: { deriveAccountCredentials: async () => ({ accountKey, authProof: "fixture-proof" }),
    wrapAdminPrivateKeyForPasskey: async (...args) => { calls.push("wrap"); return TRoomCrypto.wrapAdminPrivateKeyForPasskey(...args); } },
    cloudApi: async () => ({}), get: async path => { assert.equal(path, "/tcloud/admin-config", "pending registration must not fetch the administrator-only Identity detail"); return { initialized: true, ...vault.payload }; },
    post: async (path, body) => { if (path.endsWith("verify-password")) { assert.equal(body.authProof, "fixture-proof"); calls.push("password"); }
      else { assert.equal(body.envelopeType, "admin_private_prf"); assert.equal(body.serviceLinkId, "cloud-admin"); assert.ok(body.encryptedPayload); assert.equal(body.prfOutput, undefined); calls.push("save"); setup = { ...setup, tcloudReady: true, adminKeyReady: true }; } },
    prepareClientVault: async () => { throw new Error("must not enter folder-member preparation"); },
    showMessage: message => messages.push(message), showAdmin: async () => calls.push("admin") };
  vm.createContext(context);
  for (const name of ["prepareInviteCloud", "resumePrimaryAdminSetup", "preparePrimaryAdminCloud", "renderPrimarySetupNotice"]) vm.runInContext(uiFunction(name), context);
  return { context, $, calls, messages, setup };
}

test("primary-admin invite uses the admin setup form; PRF=0 is measured before password verification and rewrap", async () => {
  const f = uiFixture();
  assert.equal(await f.context.prepareInviteCloud({ identityId: "primary-admin", credentialId: "credential-B", prfEnabled: false }), false);
  assert.equal(f.$("#tcloud-setup-form").hidden, false);
  await f.context.resumePrimaryAdminSetup({ preventDefault() {}, submitter: f.$("submit") });
  assert.deepEqual(f.calls, ["prf", "password", "wrap", "save"]);
  assert.match(f.messages.at(-1), /管理者の承認/);
});

test("legacy PRF=0 repair remains visible; a truly missing PRF leaves registration unfinished", async () => {
  const f = uiFixture();
  f.context.renderPrimarySetupNotice({ ...f.setup, active: false, resumable: true, credentialStatus: "active" });
  assert.equal(f.$("#tcloud-setup-resume").hidden, false);
  assert.match(f.$("#tcloud-setup-resume").textContent, /修復/);
  f.context.TRoomPasskeys.obtainPrf = async () => ({ prfOutput: null });
  await f.context.resumePrimaryAdminSetup({ preventDefault() {}, submitter: f.$("submit") });
  assert.deepEqual(f.calls, []);
  assert.match(f.messages.at(-1), /このパスキー方式/);
  assert.equal(f.$("submit").disabled, false);
});
