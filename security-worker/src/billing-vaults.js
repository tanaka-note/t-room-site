const primaryAdmin = "primary-admin";
const ownerAccount = "owner";

async function billingActor(env, input, validateSession) {
  if (input?.service !== "billing" || !(await validateSession(env, input)).valid) return null;
  const [account, credential] = await Promise.all([
    env.BILLING_AUTH.describeAccount({ accountId: input.serviceAccountId }),
    env.DB.prepare(`SELECT c.prf_enabled, i.is_security_admin FROM security_credentials c
      JOIN security_identities i ON i.id=c.identity_id
      WHERE c.credential_id=? AND c.identity_id=? AND c.status='active' AND i.status='active'`)
      .bind(input.credentialId, input.identityId).first()
  ]);
  if (!account?.valid || !credential) return null;
  return {
    ...input, supportsPrf: Boolean(credential.prf_enabled),
    primaryOwner: account.role === "owner" && input.serviceAccountId === ownerAccount
      && input.identityId === primaryAdmin && credential.is_security_admin === 1
  };
}

function ownVaultRow(env, actor) {
  return env.DB.prepare(`SELECT recipient_public_key,recipient_iv,recipient_ciphertext,
      writer_public_key,writer_iv,writer_ciphertext FROM security_billing_vaults
    WHERE credential_id=? AND identity_id=?`).bind(actor.credentialId, actor.identityId).first();
}

function formatVault(row, includeWriter) {
  return row ? {
    recipient: { publicKey: JSON.parse(row.recipient_public_key), iv: row.recipient_iv, ciphertext: row.recipient_ciphertext },
    writer: includeWriter && row.writer_public_key ? {
      publicKey: JSON.parse(row.writer_public_key), iv: row.writer_iv, ciphertext: row.writer_ciphertext
    } : null
  } : null;
}

async function publicEnvelope(value, writer) {
  if (!value || typeof value.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value.iv)
    || typeof value.ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,5483}$/.test(value.ciphertext)
    || !value.publicKey || "d" in Object(value.publicKey)) throw new Error("BillingVaultInvalid");
  const { kty, n, e, crv, x, y } = value.publicKey;
  let publicKey;
  if (writer) {
    if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(x) || !/^[A-Za-z0-9_-]{43}$/.test(y)) throw new Error("BillingVaultInvalid");
    publicKey = { kty, crv, x, y };
    await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } else {
    if (kty !== "RSA" || e !== "AQAB" || typeof n !== "string" || !/^(?:[A-Za-z0-9_-]{512}|[A-Za-z0-9_-]{683})$/.test(n)) {
      throw new Error("BillingVaultInvalid");
    }
    publicKey = { kty, n, e };
    const imported = await crypto.subtle.importKey("jwk", publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    if (![3072, 4096].includes(imported.algorithm.modulusLength)) throw new Error("BillingVaultInvalid");
  }
  return { publicKey, iv: value.iv, ciphertext: value.ciphertext };
}

export async function billingVaultContext(env, input, validateSession) {
  const actor = await billingActor(env, input, validateSession);
  if (!actor) return null;
  return {
    credentialId: actor.credentialId, supportsPrf: actor.supportsPrf, primaryOwner: actor.primaryOwner,
    vault: formatVault(await ownVaultRow(env, actor), actor.primaryOwner)
  };
}

export async function enrollBillingVault(env, input, vault, validateSession) {
  const actor = await billingActor(env, input, validateSession);
  if (!actor || !actor.supportsPrf) return { status: "denied" };
  let recipient, writer;
  try {
    if (!vault || Boolean(vault.writer) !== actor.primaryOwner) return { status: "invalid" };
    recipient = await publicEnvelope(vault.recipient, false);
    writer = vault.writer ? await publicEnvelope(vault.writer, true) : null;
  } catch {
    return { status: "invalid" };
  }
  // Initial envelopes are immutable. An authorized owner can initialize the
  // previously empty signing slot if this credential already has a reader key.
  await env.DB.prepare(`INSERT INTO security_billing_vaults
    (credential_id,identity_id,recipient_public_key,recipient_iv,recipient_ciphertext,writer_public_key,writer_iv,writer_ciphertext)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM security_credentials c JOIN security_identities i ON i.id=c.identity_id
      JOIN security_service_links l ON l.identity_id=i.id
      WHERE c.credential_id=? AND i.id=? AND c.status='active' AND c.prf_enabled=1 AND i.status='active'
        AND l.id=? AND l.service='billing' AND l.service_account_id=? AND l.status='active'
        AND (?=0 OR i.is_security_admin=1)
    ) ON CONFLICT(credential_id) DO UPDATE SET
      writer_public_key=excluded.writer_public_key,writer_iv=excluded.writer_iv,writer_ciphertext=excluded.writer_ciphertext
      WHERE security_billing_vaults.identity_id=excluded.identity_id
        AND security_billing_vaults.writer_public_key IS NULL AND excluded.writer_public_key IS NOT NULL`).bind(
    actor.credentialId, actor.identityId, JSON.stringify(recipient.publicKey), recipient.iv, recipient.ciphertext,
    writer ? JSON.stringify(writer.publicKey) : null, writer?.iv ?? null, writer?.ciphertext ?? null,
    actor.credentialId, actor.identityId, actor.serviceLinkId, actor.serviceAccountId, writer ? 1 : 0
  ).run();
  if (!(await validateSession(env, input)).valid) return { status: "denied" };
  const stored = formatVault(await ownVaultRow(env, actor), actor.primaryOwner);
  return stored ? { status: "ok", vault: stored } : { status: "denied" };
}

export async function billingKeyRecipients(env, input, validateSession) {
  const actor = await billingActor(env, input, validateSession);
  if (!actor?.primaryOwner) return null;
  const targets = await env.BILLING_AUTH.listLinkTargets();
  if (!Array.isArray(targets?.targets)) throw new Error("BillingRecipientAccountsUnavailable");
  const members = new Set(targets.targets.filter(target => target.role === "member").map(target => target.accountId));
  const { results } = await env.DB.prepare(`SELECT c.credential_id AS credentialId,c.identity_id AS identityId,
      l.id AS serviceLinkId,l.service_account_id AS accountId,
      own.recipient_public_key AS billingKey,shared.public_key_jwk AS cloudKey
    FROM security_service_links l JOIN security_identities i ON i.id=l.identity_id
    JOIN security_credentials c ON c.identity_id=i.id
    LEFT JOIN security_billing_vaults own ON own.credential_id=c.credential_id AND own.identity_id=i.id
    LEFT JOIN security_tcloud_client_vaults shared ON shared.credential_id=c.credential_id AND shared.identity_id=i.id
    WHERE l.service='billing' AND l.status='active' AND i.status='active' AND c.status='active' AND c.prf_enabled=1
    ORDER BY l.service_account_id,l.id,c.credential_id LIMIT 501`).all();
  if (results.length > 500) throw new Error("BillingRecipientLimit");
  if (!(await validateSession(env, input)).valid) return null;
  return results
    .filter(row => members.has(row.accountId) || (row.accountId === ownerAccount && row.identityId === primaryAdmin))
    .map(({ billingKey, cloudKey, ...recipient }) => ({
      ...recipient, ...(billingKey ? { keySource: "billing", publicKey: JSON.parse(billingKey) }
        : cloudKey ? { keySource: "cloud", publicKey: JSON.parse(cloudKey) } : { keySource: null, publicKey: null })
    }));
}
