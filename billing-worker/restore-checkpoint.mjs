import initSqlJs from "sql.js";

const schema = `
CREATE TABLE ledger (id TEXT PRIMARY KEY, account TEXT, recovery_wrapped_key TEXT NOT NULL,
  revision INTEGER NOT NULL, digest TEXT NOT NULL, signature TEXT NOT NULL);
CREATE TABLE record (ledger TEXT NOT NULL REFERENCES ledger(id), id TEXT NOT NULL, revision INTEGER NOT NULL,
  iv TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY(ledger,id));
CREATE TABLE grant_key (ledger TEXT NOT NULL REFERENCES ledger(id), identity_id TEXT NOT NULL, credential_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL, key_source TEXT NOT NULL, wrapped_key TEXT NOT NULL,
  PRIMARY KEY(ledger,credential_id,service_link_id,key_source));
`;

export async function restoreBillingCheckpoint(receipt, options = {}) {
  const payload = receipt.payload;
  const hash = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(payload)));
  const hex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,"0")).join("");
  if (hex !== receipt.payloadSha256 || payload.format !== "troom-billing-encrypted-checkpoint" || payload.version !== 1) {
    throw new Error("バックアップの照合に失敗しました。");
  }
  const SQL = await initSqlJs({ locateFile:() => "/security/vendor/sql-wasm.wasm", ...options });
  const db = new SQL.Database();
  try {
    db.run("PRAGMA foreign_keys=ON");
    db.run(schema);
    db.run("BEGIN");
    for (const ledger of payload.ledgers) {
      db.run("INSERT INTO ledger VALUES (?,?,?,?,?,?)",[
        ledger.ledgerId,ledger.accountId,ledger.recoveryWrappedKey,ledger.revision,ledger.digest,ledger.signature
      ]);
      for (const record of ledger.records) {
        db.run("INSERT INTO record VALUES (?,?,?,?,?)",[ledger.ledgerId,record.id,record.revision,record.iv,record.ciphertext]);
      }
    }
    for (const grant of payload.grants) {
      db.run("INSERT INTO grant_key VALUES (?,?,?,?,?,?)",[
        grant.ledger_id,grant.identity_id,grant.credential_id,grant.service_link_id,grant.key_source,grant.wrapped_key
      ]);
    }
    if (db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] !== "ok" || db.exec("PRAGMA foreign_key_check").length) {
      throw new Error("復元した台帳の整合性を確認できません。");
    }
    db.run("COMMIT");
    const ledgers = [];
    db.each("SELECT * FROM ledger ORDER BY id", row => {
      const records = [];
      db.each("SELECT id,revision,iv,ciphertext FROM record WHERE ledger=? ORDER BY id",[row.id], item => records.push(item));
      ledgers.push({
        ledgerId:row.id,accountId:row.account,recoveryWrappedKey:row.recovery_wrapped_key,
        revision:row.revision,digest:row.digest,signature:row.signature,records
      });
    });
    const grants = [];
    db.each("SELECT ledger AS ledger_id,identity_id,credential_id,service_link_id,key_source,wrapped_key FROM grant_key ORDER BY ledger,credential_id,service_link_id,key_source",
      row => grants.push(row));
    const reconstructed = { ...payload, ledgers, grants };
    const verified = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(reconstructed)));
    if ([...new Uint8Array(verified)].some((byte,index) => byte !== new Uint8Array(hash)[index])) {
      throw new Error("復元結果をバックアップ原本と照合できません。");
    }
    return reconstructed;
  } finally {
    db.close();
  }
}
