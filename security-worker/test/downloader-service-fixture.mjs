import { WorkerEntrypoint } from "cloudflare:workers";

export default {
  fetch() {
    return new Response("Not Found", { status: 404 });
  }
};

export class SecurityIntegration extends WorkerEntrypoint {
  async getSessionRuntimeState() {
    return { sessionVersion: "1", passkeyEnabled: true };
  }

  async listLinkTargets() {
    return {
      service: "downloader",
      displayName: "T-lain Downloader",
      targets: [{
        accountId: "owner",
        displayLabel: "T-lain Downloader 管理者",
        role: "owner",
        roleLabel: "管理者",
        privileged: true,
        exclusive: false,
        shared: false,
        rootFolderId: null
      }]
    };
  }

  async describeAccount(input) {
    return String(input?.accountId || "") === "owner"
      ? { valid: true, ...(await this.listLinkTargets()).targets[0] }
      : { valid: false };
  }
}
