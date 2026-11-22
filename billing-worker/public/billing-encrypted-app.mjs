import {
  billingEncryptedDigest, billingLedgerKeys, openBillingRecord, unwrapBillingLedgerKey, verifyBillingState
} from "./billing-crypto.mjs";
import { entryInput, settlementInput } from "./billing-finance.mjs";
import { billingMonthlySources, readBillingEncryptedMonth, sealBillingMigrationLedger } from "./billing-migration.mjs";
import { distributeBillingKeys } from "./billing-migration-client.mjs";

const ledgerPath = scope => `/encryption/ledger?ledger=${encodeURIComponent(scope.ledgerId)}`;
const requestError = (message,status) => Object.assign(new Error(message),{ status });
const auditAccount = null;

function newId() {
  const uuid = crypto.randomUUID().replaceAll("-","");
  // Keep 52 random bits and skip the fixed UUID version nibble. The leading
  // hex digit reserves a safe-integer range above the old SQLite row IDs.
  return Number.parseInt(`1${uuid.slice(0,12)}${uuid[13]}`,16);
}

function ownRecordId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function applyEdit(kind, action, id, previous, input, actor, clock) {
  if (action === "deleted") return { ...previous, deleted_at:clock, updated_at:clock };
  const base = {
    id, account_id:input.accountId, amount_yen:input.amountYen, note:input.note,
    created_by:previous?.created_by ?? actor, created_at:previous?.created_at ?? clock, updated_at:clock, deleted_at:null
  };
  if (kind === "entry") return {
    ...base, document_type:input.documentType, entry_date:input.entryDate, category:input.category, description:input.description
  };
  return {
    ...base, settlement_date:input.settlementDate, direction:input.direction, method:input.method,
    legacy_entry_id:previous?.legacy_entry_id ?? null
  };
}

export async function refreshBillingGrants(api, authentication, signal) {
  const request = (path, options) => {
    signal?.throwIfAborted();
    return api(path,{ ...options,signal });
  };
  const { ledgers } = await request("/encryption/pending-grants");
  if (!ledgers.length) return;
  const context = await request("/encryption/recovery-context");
  const recovery = await globalThis.TRoomCrypto.unlockAdminPrivateKeyWithPasskey(authentication.prfOutput,context.envelope);
  for (const scope of ledgers) {
    signal?.throwIfAborted();
    const material = await unwrapBillingLedgerKey(scope.recoveryWrappedKey,scope,"recovery",recovery);
    try {
      await distributeBillingKeys(request,{ ...scope, grants:[] },material,scope.recipients);
    } finally {
      material.fill(0);
    }
  }
}

export function encryptedBillingApp(api, session, holder, initial) {
  const revisions = new Map();
  const prepared = new Map();
  let closed = false;
  const assertOpen = () => { if (closed) throw new DOMException("Aborted","AbortError"); };

  async function scopeFor(accountId, options) {
    assertOpen();
    const { ledgers } = await api("/encryption/ledgers",options);
    assertOpen();
    const scope = ledgers.find(candidate => candidate.accountId === accountId);
    if (!scope) throw requestError("台帳を確認できません。",403);
    return scope;
  }

  async function keysFor(scope) {
    if (!scope.grants.length) throw requestError("管理者からの暗号鍵の配布を待っています。",409);
    if (prepared.has(scope.ledgerId)) return prepared.get(scope.ledgerId);
    for (const grant of scope.grants) {
      const privateKey = grant.keySource === "billing" ? holder.recipient : holder.cloud;
      if (!privateKey) continue;
      let material;
      try {
        material = await unwrapBillingLedgerKey(grant.wrappedKey,scope,grant.recipient,privateKey);
        const keys = await billingLedgerKeys(material,scope);
        assertOpen();
        prepared.set(scope.ledgerId,keys);
        return keys;
      } catch (error) {
        if (error.name === "AbortError") throw error;
      } finally {
        material?.fill(0);
      }
    }
    throw requestError("このパスキーで台帳を解除できません。",403);
  }

  async function read(scope, options) {
    assertOpen();
    return verify(scope,await api(ledgerPath(scope),options));
  }

  async function verify(scope, result) {
    assertOpen();
    const previous = revisions.get(scope.ledgerId);
    const writer = holder.writerKeys.find(key => key.kty === result.writer?.kty && key.crv === result.writer.crv
      && key.x === result.writer.x && key.y === result.writer.y);
    if (previous && (result.revision < previous.number || (result.revision === previous.number && result.digest !== previous.digest))
      || !writer || !Array.isArray(result.records) || await billingEncryptedDigest(result.records) !== result.digest
      || !await verifyBillingState(writer,scope,result.revision,result.digest,result.signature)) {
      throw requestError("台帳の署名または更新番号を確認できません。",409);
    }
    assertOpen();
    revisions.set(scope.ledgerId,{ number:result.revision,digest:result.digest });
    return result;
  }

  async function summary(accountId,month,options,initialView) {
    assertOpen();
    const { scope, ledger } = initialView ?? await api(`/encryption/view?accountId=${encodeURIComponent(accountId)}`,options);
    assertOpen();
    if (scope.accountId !== accountId) throw requestError("台帳を確認できません。",403);
    const [keys,data] = await Promise.all([keysFor(scope),ledger ? verify(scope,ledger) : null]);
    assertOpen();
    return readBillingEncryptedMonth({
      scope,keys,revision:data.revision,month,signal:options?.signal,
      loadRecord: id => data.records.find(record => record.id === id)
    });
  }

  async function mutate(match, method, body, currentAccount) {
    if (!holder.primaryOwner || !holder.writer) throw requestError("台帳を変更する権限がありません。",403);
    const [ , path, rawId ] = match;
    const kind = path === "entries" ? "entry" : "settlement";
    const action = { POST:"created", PUT:"updated", DELETE:"deleted" }[method];
    if (!action || (method === "POST") !== (rawId === undefined)) throw requestError("操作の内容を確認してください。",400);
    const id = rawId === undefined ? newId() : Number(rawId);
    if (!ownRecordId(id)) throw requestError("明細の番号を確認してください。",400);
    const input = action === "deleted" ? null : (kind === "entry" ? entryInput(body) : settlementInput(body));
    if (!input && action !== "deleted") {
      throw requestError(kind === "entry" ? "明細の入力内容を確認してください。" : "入出金の入力内容を確認してください。",400);
    }
    const target = input?.accountId ?? currentAccount;
    const accounts = (await api("/accounts")).accounts;
    if (!accounts.some(account => account.id === target)) throw requestError("利用者が見つかりません。",404);
    const source = action === "created" ? target : currentAccount;
    const required = [...new Set([source,target,auditAccount])];
    const context = new Map(await Promise.all(required.map(async account => {
      const scope = await scopeFor(account);
      const [keys, result] = await Promise.all([keysFor(scope),read(scope)]);
      const values = await Promise.all(result.records.map(record => openBillingRecord(keys,scope,record)));
      assertOpen();
      return [account,{ scope, keys, revision:result.revision,
        sources: values.filter(value => value.kind !== "month" && value.kind !== "index") }];
    })));
    const sourceLedger = context.get(source), destination = context.get(target);
    const old = sourceLedger.sources.find(record => record.kind === kind && record.sourceId === String(id));
    if ((action === "created" && old) || (action !== "created" && (!old || old.data.deleted_at !== null))) {
      throw requestError("明細の最新の状態を確認してください。",409);
    }
    const clock = new Date().toISOString().slice(0,19).replace("T"," ");
    const row = { kind, sourceId:String(id),data:applyEdit(kind,action,id,old?.data,input,session.accountId,clock) };
    if (old) sourceLedger.sources = sourceLedger.sources.filter(record => record !== old);
    destination.sources.push(row);
    const eventType = `${kind}_${action}`;
    const auditId = newId();
    context.get(auditAccount).sources.push({
      kind:"audit",sourceId:String(auditId),
      data:{ id:auditId,event_type:eventType,actor_account_id:session.accountId,target_account_id:target,
        entry_id:kind === "entry" ? id : null,attempted_login_id:null,occurred_at:clock,
        details_json:JSON.stringify({ previous:old?.data ?? null,next:row.data }) }
    });
    const updates = await Promise.all([...context].map(async ([account,value]) => {
      const sources = account === auditAccount ? value.sources : [...value.sources,...billingMonthlySources(
        { id:account,displayName:value.scope.displayName },value.sources)];
      const state = await sealBillingMigrationLedger({
        scope:value.scope, keys:value.keys, revision:value.revision+1, sources, writer:holder.writer
      });
      return { ...state, ledgerId:value.scope.ledgerId };
    }));
    assertOpen();
    const options = { method:"POST",body:{ operationId:crypto.randomUUID(),targetAccountId:target,eventType,updates } };
    try {
      await api("/encryption/commit",options);
    } catch (error) {
      if (error.status || error.name === "AbortError") throw error;
      assertOpen();
      // Same encrypted request, same operation ID, safe when the response was
      // lost after the batch was applied.
      await api("/encryption/commit",options);
    }
    return { ok:true,id };
  }

  return {
    async request(path,options,currentAccount) {
      const url = new URL(path,"https://billing.invalid");
      if (url.pathname === "/accounts" && url.searchParams.get("includeSummary") === "1") {
        const startup = initial;
        initial = null;
        const accounts = startup?.accounts ?? (await api("/accounts",options)).accounts;
        const account = accounts[0];
        return { accounts,summary:account ? await summary(account.id,url.searchParams.get("month"),options,startup?.view) : null };
      }
      if (url.pathname === "/summary") return summary(
        url.searchParams.get("accountId") || session.accountId,url.searchParams.get("month"),options);
      const match = url.pathname.match(/^\/(entries|settlements)(?:\/(\d+))?$/);
      if (match) return mutate(match,options?.method,options?.body,currentAccount);
      return api(path,options);
    },
    close() {
      closed = true;
      initial = null;
      prepared.clear();
      revisions.clear();
    }
  };
}
