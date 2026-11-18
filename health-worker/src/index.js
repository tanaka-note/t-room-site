import { WorkerEntrypoint } from 'cloudflare:workers';
import { retiredServiceResponse } from '../../site-worker/retired-services.mjs';

export default class HealthWorker extends WorkerEntrypoint {
  fetch(request) { return retiredServiceResponse(request); }
}

// The previous Security deployment can still call this entrypoint during rollout.
export class SecurityIntegration extends WorkerEntrypoint {
  fetch(request) { return retiredServiceResponse(request); }
  getSessionRuntimeState() { return { sessionVersion: '1', passkeyEnabled: false }; }
  listLinkTargets() { return { service: 'health', displayName: '体調管理', targets: [] }; }
  describeAccount() { return { valid: false }; }
}
