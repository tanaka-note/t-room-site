import { WorkerEntrypoint } from "cloudflare:workers";

// Local fixture only: bypasses WebAuthn to exercise real Diary authorization.
// No production resources, identities or credentials are used here.
export default class extends WorkerEntrypoint {
  async redeemHandoff(token, service) {
    if (service !== "diary" || !["fixture-main-admin", "fixture-main-user"].includes(token)) return null;
    const id = token.slice("fixture-".length);
    return { identityId: "fixture-identity", credentialId: "fixture-credential", serviceLinkId: `fixture-${id}`, serviceAccountId: id, sessionEpoch: 1 };
  }
  async validatePasskeySession(session) {
    return { valid: session.service === "diary" && session.identityId === "fixture-identity"
      && session.credentialId === "fixture-credential" && session.sessionEpoch === 1
      && ["main-admin", "main-user"].includes(session.serviceAccountId)
      && session.serviceLinkId === `fixture-${session.serviceAccountId}` };
  }
  async recordAuditEvent() {}
  async fetch() { return new Response("Local test fixture", { status: 404 }); }
}
