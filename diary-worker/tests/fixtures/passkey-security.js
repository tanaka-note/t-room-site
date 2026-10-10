import { WorkerEntrypoint } from "cloudflare:workers";
import { rollingBinding } from "../../../tools/fixtures/passkey-rolling-binding.mjs";

const rollingSession = rollingBinding(validFixtureSession);
function validFixtureSession(session) {
  return session.service === "diary" && session.identityId === "fixture-identity"
    && session.credentialId === "fixture-credential" && session.sessionEpoch === 1
    && /^[a-z0-9-]+$/.test(session.serviceAccountId)
    && session.serviceLinkId === `fixture-${session.serviceAccountId}`;
}

// Local fixture only: bypasses WebAuthn to exercise real Diary authorization.
// No production resources, identities or credentials are used here.
export default class extends WorkerEntrypoint {
  async redeemHandoff(token, service) {
    if (service !== "diary" || !/^fixture-[a-z0-9-]+$/.test(token)) return null;
    const id = token.slice("fixture-".length);
    return { identityId: "fixture-identity", credentialId: "fixture-credential", serviceLinkId: `fixture-${id}`, serviceAccountId: id, sessionEpoch: 1 };
  }
  async validatePasskeySession(session) {
    return { valid: validFixtureSession(session) };
  }
  async passkeyRollingSession(input) { return rollingSession(input); }
  async recordAuditEvent() {}
  async fetch() { return new Response("Local test fixture", { status: 404 }); }
}
