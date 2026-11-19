// Generated from checked-in migrations using Node SQLite; review alongside schema changes.
import { digest } from './integrity.js';
import { BILLING_ENCRYPTED_MIGRATION, SECURITY_BILLING_MIGRATION } from './billing-encrypted.js';
const EXPECTED = {
  "portfolio": "0f996aabee4cfcdec8a1ee2f5d5429b170727d19eba88351ec82577bdedc939a",
  "household": "2f7780c5512b5b1fbd610fc9860e4417832050d941773542871189032bfca10f",
  "cloud": "c52cc385ebd2c565f946207ddf36ec9d5a15659b96dacf84039c3023713e1b1d",
  "security": "597cec608e96b2eb5e7704d8e3216a12aaab1ab5279c8355c0291899dad3313e",
  "billing": "e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f",
  "payments": "a74f9ffcabf4a59f3ae58f552de94adc14738883ea1f07baf670c9c6fc3c740f",
  "health": "5d74bfd7ac54779545e86f1e0bd948b29ce3f578c68c309e445f1542d47f98ac",
  "inventory": "ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3",
  "ai": "d7e265eac65afddd4301e02adb081123c3ab7d1d0444f427cf8cec3d57b9ca0c",
  "downloader": "b367e88bee856222f72cfdf97a35794d381a13a3a7126c07ab50a3c43e6fe6a9",
  "calendar": "cdae4a460294b4cefb9b9392b5ea2214fc335124315ad420ccf9644b88611d4c",
  "diary": "6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70"
};
// Exact DDL metadata reviewed read-only on 2026-10-26. No database/auth
// settings are changed: Billing already uses DEFAULT 210000; the other
// differences are SQL formatting. Pin variants to their migration baseline,
// so a future migration requires a fresh review rather than a broad bypass.
const REVIEWED = {
  billing: ['e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f', '0caa9787a64446caa2e5062638713c9d9978f884d2e0215dc9c7802a152af42e'],
  inventory: ['ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3', 'd583deb887f1a14e802b50a550dca0e54e41dfeb5fadeca9a2cc6c9f3bbe10bd'],
  // Reviewed Diary DDL plus additive migration 0022 (not a new production audit).
  diary: ['6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70', 'ac391629ad0de78bd2ac2390429c5021722528ae129a27f1043dfef5b2de014e']
};
export function reviewedSchemaMatches(service, baseline, actual) {
  return typeof baseline === 'string' && (actual === baseline ||
    (REVIEWED[service]?.[0] === baseline && REVIEWED[service][1] === actual));
}
export async function assertSchema(service, rows) {
  const versions=service==='cloud'?rows.filter(row=>row.tbl_name==='cloud_file_versions'||row.name==='cloud_version_restore_name'):[];
  if(service==='cloud'&&Boolean(versions.length)!==rows.some(row=>row.name==='cloud_windows_uploads'))throw new Error('SchemaReviewRequired');
  if(versions.length) {
    const shape=versions.map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
    if(await digest(new TextEncoder().encode(JSON.stringify(shape)))!=='78a6cd859c5ede6044f7ab9b7531bb26da704d8aa4cdcc2dc66a5c974a1cd986')throw new Error('SchemaReviewRequired');
    rows=rows.filter(row=>!versions.includes(row));
  }
  // Optional Windows authorization schema; both the old production baseline
  // and this exact additive extension are supported during Worker-first rollout.
  // These are authorization records, excluded from automatic data restoration.
  const windows = service==='security' ? row=>row.tbl_name==='security_windows_authority_versions'||row.name.startsWith('windows_')
    : service==='cloud' ? row=>row.name.startsWith('cloud_windows_') : ()=>false;
  const windowsRows=rows.filter(windows);
  if(windowsRows.length) {
    const expected=service==='security'?['953eaa6945a4f7dd167e467de9d500ff32c5ac304dce6d829683ccfcad088a8d']
      :['1daa6b05da32595f44478904b056c787f3c0cd6ac6cbb1551840f79d495d90e9','7ff775cfcf278592dc53ed51bbca522ec6731468ce57f5de17f1bd354606c0e4',
        '14ae18e007e8ff1dc2973098c2e93b3f34ca531544837a983db88cbb9c6ab31b'];
    const shape=windowsRows.map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
    if(!expected.includes(await digest(new TextEncoder().encode(JSON.stringify(shape)))))throw new Error('SchemaReviewRequired');
    rows=rows.filter(row=>!windows(row));
  }
  const extension = service==='billing' ? name => /^billing_(encryption|candidate|freeze)_/.test(name)
    : service==='security' ? name => name === 'security_billing_vaults'
      : service==='diary' ? name=>name.startsWith('diary_photo_migration_') : () => false;
  const extra = rows.filter(row=>extension(row.name));
  if (extra.length) {
    const expected = service==='billing' ? '78f4defbcb4a6662c28ca926de959be22d33da90f9a416f4bb832e5d23e7a7a2'
      : service==='diary' ? '8042681127de3a0fd052920c32334a938ace9708350183438c7cbfcf28bd98af'
        : 'b0d6dd06625913b84b28ee5dd371c170ddddee5a84121cc98276a2bfc8cbade4';
    const shape = extra.map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
    if (await digest(new TextEncoder().encode(JSON.stringify(shape))) !== expected) throw new Error('SchemaReviewRequired');
    rows = rows.filter(row=>!extension(row.name));
  }
  const schema=rows.filter(r=>r.tbl_name!=='d1_migrations').map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
  if(!reviewedSchemaMatches(service, EXPECTED[service], await digest(new TextEncoder().encode(JSON.stringify(schema))))) throw new Error('SchemaReviewRequired');
}
// These fragments are pinned to the candidate SQL, including all old-writer
// fences. Removing an expected trigger or adding an unknown table still fails.
const ENCRYPTED_FRAGMENTS={diary:'609160b000a7bfe17c02101a3e18fc941890bc46058edadc3256d064c2ee639c',security:'fba11d54f4e7ffbabff26541b688517007da622dbf4c3c75fed5c05b6802247e'};
export async function assertEncryptedSchema(service,rows) {
  const encrypted=row=>service==='diary'?(row.name.startsWith('diary_e2ee_')||row.name.startsWith('diary_plaintext_')):service==='security'&&row.name.startsWith('security_diary_key_');
  const fragment=rows.filter(encrypted).map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
  if(!ENCRYPTED_FRAGMENTS[service]||await digest(new TextEncoder().encode(JSON.stringify(fragment)))!==ENCRYPTED_FRAGMENTS[service])throw new Error('SchemaReviewRequired');
  await assertSchema(service,rows.filter(row=>!encrypted(row)));
}
export async function assertArchiveSchema(service,migration,rows) {
  if (service==='billing' && migration===BILLING_ENCRYPTED_MIGRATION) {
    if (!rows.some(row=>row.name==='billing_encryption_live_ledgers')) throw new Error('SchemaReviewRequired');
    return assertSchema(service,rows);
  }
  if (service==='security' && migration===SECURITY_BILLING_MIGRATION) {
    if (!rows.some(row=>row.name==='security_billing_vaults')) throw new Error('SchemaReviewRequired');
    return rows.some(row=>row.name==='security_diary_key_config') ? assertEncryptedSchema(service,rows) : assertSchema(service,rows);
  }
  if(service==='diary'&&(migration==='diary-e2ee-v1'||migration==='0022_photo_backup_identity.sql'&&rows.some(row=>row.name==='diary_e2ee_control'))||service==='security'&&migration==='security-diary-keys-v1')return assertEncryptedSchema(service,rows);
  const historical = service === 'cloud' && migration === '0012_favorites.sql'
    ? 'c319c54132d640262b215ffdac570407df82f54e07a1f2395ea3b68291a7625c'
    : service === 'household' && migration === '0006_independent_households.sql'
      ? '87c3caeb5b1bd4363759e93de4fe377f03064dc96e226fc531546a16146a2ede' : null;
  if (historical) {
    const schema = rows.filter(r => r.tbl_name !== 'd1_migrations').map(r => [r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
    if (await digest(new TextEncoder().encode(JSON.stringify(schema))) !== historical) throw new Error('SchemaReviewRequired');
    return;
  }
  return assertSchema(service,rows);
}
