import {
  billingLedgerKeys, signBillingState, unwrapBillingLedgerKey, wrapBillingLedgerKey
} from "./billing-crypto.mjs";
import {
  billingMigrationSources, billingMonthlySources, sealBillingMigrationLedger, verifyBillingMigrationLedger
} from "./billing-migration.mjs";

const migrationPath = "/encryption/migration";
const proofLabel = new TextEncoder().encode("T-lain Billing migration challenge v1");
const encodeBytes = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const decodeBytes = value => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));

async function post(api,path,body) {
  return api(path, { method:"POST", body });
}

export async function distributeBillingKeys(api, scope, material, recipients) {
  const saved = new Set(scope.grants.map(grant => JSON.stringify([
    grant.recipient.credentialId,grant.recipient.serviceLinkId,grant.keySource
  ])));
  const eligible = recipients.filter(recipient => recipient.publicKey
    && (recipient.accountId === scope.accountId || (recipient.accountId === "owner" && recipient.identityId === "primary-admin"))
    && !saved.has(JSON.stringify([recipient.credentialId,recipient.serviceLinkId,recipient.keySource])));
  const grants = await Promise.all(eligible.map(async recipient => ({
    credentialId:recipient.credentialId, serviceLinkId:recipient.serviceLinkId, keySource:recipient.keySource,
    wrappedKey:await wrapBillingLedgerKey(material,scope,recipient,recipient.publicKey)
  })));
  if (grants.length) await post(api,"/encryption/grants",{ ledgerId:scope.ledgerId, grants });
}

async function sourceRows(api, collection, account) {
  const results = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ collection });
    if (account) query.set("account",account.id);
    if (cursor !== null) query.set("after",String(cursor));
    const page = await api(`${migrationPath}/source?${query}`);
    results.push(...page.rows);
    if (page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= (cursor ?? 0))) throw new Error("移行元の続きの位置を確認できません。");
    cursor = page.next;
  } while (cursor !== null);
  return results;
}

async function reserveScope(api, scopes, accountId, length, recovery, material) {
  const existing = scopes.find(scope => scope.accountId === accountId);
  if (existing) return existing;
  const scope = { ledgerId:crypto.randomUUID(),generation:1,accountId,grants:[] };
  const recoveryWrappedKey = await wrapBillingLedgerKey(material,scope,"recovery",recovery.publicKey);
  try {
    await post(api,`${migrationPath}/ledger`,{
      ledgerId:scope.ledgerId, accountId, recoveryWrappedKey, revision:1, recordCount:length
    });
    return { ...scope, recoveryWrappedKey };
  } catch (error) {
    const { ledgers } = await api(`${migrationPath}/ledgers`);
    const stored = ledgers.find(ledger => ledger.accountId === accountId);
    if (!stored) throw error;
    return stored;
  }
}

async function migrateLedger(api, account, scopes, keys, recovery, recipients) {
  const data = account ? {
    entries: await sourceRows(api,"entries",account),
    settlements: await sourceRows(api,"settlements",account),
    openingBalances: await sourceRows(api,"openingBalances",account), auditLogs:[]
  } : { entries:[], settlements:[], openingBalances:[], auditLogs: await sourceRows(api,"auditLogs",null) };
  const projected = billingMigrationSources(data);
  const sources = account ? [...projected.ledger,...billingMonthlySources(account,projected.ledger)] : projected.audit;
  let material = crypto.getRandomValues(new Uint8Array(32));
  try {
    const scope = await reserveScope(api,scopes,account?.id ?? null,sources.length,recovery,material);
    material.fill(0);
    material = await unwrapBillingLedgerKey(scope.recoveryWrappedKey,scope,"recovery",recovery.privateKey);
    const ledgerKeys = await billingLedgerKeys(material,scope);
    const path = `${migrationPath}/ledger?ledger=${encodeURIComponent(scope.ledgerId)}`;
    const cached = await api(path);
    if (cached.header.record_count !== sources.length) throw new Error("移行元の件数が一致しません。");
    const parameters = { scope, keys:ledgerKeys, revision:1, sources, writer:keys.writer, stagedRecords:cached.records };
    if (!cached.header.signature) {
      const staged = await sealBillingMigrationLedger(parameters);
      const ids = new Set(cached.records.map(record => record.id));
      const missing = staged.records.filter(record => !ids.has(record.id));
      for (let offset = 0; offset < missing.length; offset += 8) {
        await post(api,`${migrationPath}/records`,{ ledgerId:scope.ledgerId, records:missing.slice(offset,offset+8) });
      }
      const readback = await api(path);
      await verifyBillingMigrationLedger({
        ...parameters, state:{ ...staged,records:readback.records }, writerPublicKey:keys.writerPublicKey
      });
      await post(api,`${migrationPath}/attest`,{
        ledgerId:scope.ledgerId, revision:1, digest:staged.digest, signature:staged.signature
      });
    }
    const readback = await api(path);
    await verifyBillingMigrationLedger({
      ...parameters,
      state:{ revision:1,digest:readback.header.digest,signature:readback.header.signature,records:readback.records },
      writerPublicKey:keys.writerPublicKey
    });
    await distributeBillingKeys(api,scope,material,recipients);
    return { scope, keys:ledgerKeys, sources, writerPublicKey:keys.writerPublicKey };
  } finally {
    material.fill(0);
  }
}

export async function stageBillingMigration(api, keys, auth, showProgress, options = {}) {
  const { unlockRecovery = globalThis.TRoomCrypto?.unlockAdminPrivateKeyWithPasskey, restore, activate } = options;
  const context = await api(`${migrationPath}/challenge`);
  if (!unlockRecovery) throw new Error("復旧鍵を開くための機能を読み込めませんでした。");
  const privateKey = await unlockRecovery(auth.prfOutput,context.envelope);
  const answer = new Uint8Array(await crypto.subtle.decrypt({
    name:"RSA-OAEP",label:proofLabel
  },privateKey,decodeBytes(context.challenge)));
  let initialization;
  try {
    initialization = await post(api,`${migrationPath}/start`,{ generation:crypto.randomUUID(),proof:encodeBytes(answer) });
  } finally {
    answer.fill(0);
  }
  const { ledgers } = await api(`${migrationPath}/ledgers`);
  const { recipients } = await api("/encryption/recipients");
  const scopes = [...initialization.accounts,null];
  const verifiedSources = new Map();
  for (const [index,account] of scopes.entries()) {
    showProgress(index,scopes.length);
    const verified = await migrateLedger(api,account,ledgers,keys,{ publicKey:context.publicKey,privateKey },recipients);
    verifiedSources.set(verified.scope.ledgerId,verified);
  }
  showProgress(scopes.length,scopes.length);
  if (!restore) return { migration:initialization.migration,activated:false };
  const receipt = await post(api,`${migrationPath}/checkpoint`,{});
  const restored = await restore(receipt);
  if (restored.generation !== initialization.migration || restored.ledgers.length !== verifiedSources.size) {
    throw new Error("復元した台帳の世代と件数を確認できません。");
  }
  for (const ledger of restored.ledgers) {
    const original = verifiedSources.get(ledger.ledgerId);
    if (!original || await verifyBillingMigrationLedger({ ...original,state:ledger }) !== original.sources.length) {
      throw new Error("復元した台帳の内容を照合できません。");
    }
    const recovered = await unwrapBillingLedgerKey(ledger.recoveryWrappedKey,original.scope,"recovery",privateKey);
    try {
      const restoredKeys = await billingLedgerKeys(recovered,original.scope);
      await verifyBillingMigrationLedger({ ...original,keys:restoredKeys,state:ledger });
    } finally {
      recovered.fill(0);
    }
  }
  if (activate) {
    const digest = encodeBytes(Uint8Array.from(receipt.payloadSha256.match(/../g),byte => parseInt(byte,16)));
    const signature = await signBillingState(keys.writer,{ ledgerId:initialization.migration,generation:1 },1,digest);
    await post(api,`${migrationPath}/activate`,{ archiveSha256:receipt.archiveSha256,signature });
  }
  return { migration:initialization.migration,activated:Boolean(activate) };
}
