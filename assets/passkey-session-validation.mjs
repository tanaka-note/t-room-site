export async function validateServicePasskeySession(payload, env, service, cloudRootFolderId = null) {
  if (payload?.authMethod !== "passkey") return true;
  if (String(env.PASSKEY_ENABLED || "true") !== "true" || !env.SECURITY) return false;
  if (!payload.identityId || !payload.credentialId || !payload.serviceLinkId || !payload.serviceAccountId) return false;
  try {
    const result = await env.SECURITY.validatePasskeySession({
      service,
      identityId: payload.identityId,
      credentialId: payload.credentialId,
      serviceLinkId: payload.serviceLinkId,
      serviceAccountId: payload.serviceAccountId,
      cloudRootFolderId
    });
    return result?.valid === true;
  } catch {
    return false;
  }
}
