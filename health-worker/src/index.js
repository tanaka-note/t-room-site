import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRequest, linkTarget } from './worker.js';
export default class HealthWorker extends WorkerEntrypoint {
  async fetch(request) {
    try { return await handleRequest(request, this.env, this.ctx); }
    catch (error) { return Response.json({ code: error.code, error: error.status ? error.message : '体調管理の処理を完了できませんでした。' }, { status: error.status || 500, headers: { 'Cache-Control': 'no-store' } }); }
  }
}
export class SecurityIntegration extends WorkerEntrypoint {
  async fetch(request) { return handleRequest(request, this.env, this.ctx); }
  async getSessionRuntimeState() { return { sessionVersion: String(this.env.SESSION_VERSION || '1'), passkeyEnabled: this.env.PASSKEY_ENABLED === 'true' }; }
  async listLinkTargets() { return { service: 'health', displayName: '体調管理', targets: [linkTarget] }; }
  async describeAccount(input) { return input?.accountId === 'nobumi' && input?.rootFolderId == null ? { valid: true, ...linkTarget } : { valid: false }; }
}
