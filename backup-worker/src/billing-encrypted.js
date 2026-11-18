export const BILLING_ENCRYPTED_MIGRATION = 'billing-encryption-v1';
export const SECURITY_BILLING_MIGRATION = 'security-diary-billing-keys-v1';

function table(name, sourceColumns, columns = sourceColumns.split(',')) {
  return { name,sourceColumns,columns };
}

export const BILLING_ENCRYPTED_TABLES = [
  table('billing_encryption_migration','id,generation,started_at,audit_through_id,writer_public_key,activated_at,verified_checkpoint'),
  table('billing_encryption_candidate_ledgers','generation,ledger_id,account_id,recovery_wrapped_key,revision,digest,signature,record_count,staged_count,staged_bytes'),
  table('billing_encryption_candidate_records','generation,ledger_id,id,revision,iv,ciphertext'),
  table('billing_encryption_grants','generation,ledger_id,identity_id,credential_id,service_link_id,key_source,wrapped_key'),
  table('billing_encryption_live_ledgers','generation,ledger_id,revision,digest,signature,writer_public_key,records_json'),
  table('billing_encryption_operations','generation,id,actor_id,fingerprint,expected_revisions')
];

export const SECURITY_BILLING_VAULTS = table('security_billing_vaults',
  'credential_id,identity_id,recipient_public_key,recipient_iv,recipient_ciphertext,writer_public_key,writer_iv,writer_ciphertext');

export function billingEncryptedSpec(spec) {
  const protectedTables = new Set(['billing_entries','billing_opening_balances','billing_settlements']);
  const metadata = spec.tables.filter(item => !protectedTables.has(item.name)).map(item =>
    item.name === 'billing_audit_logs'
      ? { ...item,columns:item.columns.filter(column => column !== 'details_json' && column !== 'entry_id') }
      : item);
  return { ...spec,migration:BILLING_ENCRYPTED_MIGRATION,tables:[...metadata,...BILLING_ENCRYPTED_TABLES] };
}
