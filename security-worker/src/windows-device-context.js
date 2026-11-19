// Internal Cloud Service Binding only. No WebAuthn, session issuance or TTL changes.
export async function cloudWindowsDeviceContext(env, input, validate) {
  if (input?.service !== 'cloud' || !['admin', 'folder-member'].includes(input.serviceAccountId)) return null;
  if (input.serviceAccountId === 'admin' && input.identityId !== 'primary-admin') return null;
  const validation = await validate(env, input);
  if (validation?.valid !== true) return null;
  const scopes = input.serviceAccountId === 'admin'
    ? [{ serviceLinkId: input.serviceLinkId, rootFolderId: null }]
    : validation.folderScopes || [{ serviceLinkId: input.serviceLinkId, rootFolderId: input.cloudRootFolderId }];
  if (!scopes.length || scopes.length > 16) return null;
  const rows = [];
  for (const scope of scopes) {
    const row = await env.DB.prepare(`SELECT i.id, i.is_security_admin, iv.revision AS identityRevision,
      cv.revision AS credentialRevision, lv.revision AS linkRevision,
      v.public_key_jwk AS publicKeyJwk, e.wrapped_key AS wrappedKey
      FROM security_identities i
      JOIN security_credentials c ON c.identity_id=i.id AND c.credential_id=? AND c.status='active' AND c.prf_enabled=1
      JOIN security_service_links l ON l.identity_id=i.id AND l.id=? AND l.status='active' AND l.service='cloud'
      JOIN security_windows_authority_versions iv ON iv.kind='identity' AND iv.entity_id=i.id
      JOIN security_windows_authority_versions cv ON cv.kind='credential' AND cv.entity_id=c.credential_id
      JOIN security_windows_authority_versions lv ON lv.kind='link' AND lv.entity_id=l.id
      JOIN security_tcloud_key_envelopes e ON e.identity_id=i.id AND e.credential_id=c.credential_id AND e.service_link_id=l.id
        AND e.envelope_type=CASE WHEN l.service_account_id='admin' THEN 'admin_private_prf' ELSE 'folder_key_rsa' END
      LEFT JOIN security_tcloud_client_vaults v ON v.identity_id=i.id AND v.credential_id=c.credential_id
      WHERE i.id=? AND i.status='active' AND l.service_account_id=? AND l.cloud_root_folder_id IS ?`)
      .bind(input.credentialId, scope.serviceLinkId, input.identityId, input.serviceAccountId, scope.rootFolderId).first();
    if (!row || (input.serviceAccountId === 'admin' && !row.is_security_admin)
      || (input.serviceAccountId === 'folder-member' && (!row.publicKeyJwk || !row.wrappedKey))) return null;
    rows.push({ ...row, serviceLinkId: scope.serviceLinkId, rootFolderId: scope.rootFolderId });
  }
  // Re-read the version vector after all key reads; an intervening revocation
  // must not produce a new valid snapshot with the old keys or scope.
  for (const row of rows) {
    const versions = await env.DB.prepare(`SELECT
      (SELECT revision FROM security_windows_authority_versions WHERE kind='identity' AND entity_id=?) AS i,
      (SELECT revision FROM security_windows_authority_versions WHERE kind='credential' AND entity_id=?) AS c,
      (SELECT revision FROM security_windows_authority_versions WHERE kind='link' AND entity_id=?) AS l`)
      .bind(input.identityId, input.credentialId, row.serviceLinkId).first();
    if (versions?.i !== row.identityRevision || versions?.c !== row.credentialRevision || versions?.l !== row.linkRevision) return null;
  }
  const vector = JSON.stringify([input.sessionEpoch, rows.map(row => [row.serviceLinkId, row.rootFolderId,
    row.identityRevision, row.credentialRevision, row.linkRevision])]);
  const authorityVersion = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(vector)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { valid: true, authorityVersion,
    publicKeyJwk: input.serviceAccountId === 'folder-member' ? JSON.parse(rows[0].publicKeyJwk) : null,
    folderKeys: input.serviceAccountId === 'folder-member'
      ? rows.map(row => ({ serviceLinkId: row.serviceLinkId, rootFolderId: row.rootFolderId, wrappedKey: row.wrappedKey })) : [] };
}
