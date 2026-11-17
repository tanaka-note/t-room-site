import { WorkflowEntrypoint } from 'cloudflare:workers';
import { executeExportWorkflow } from './workflow-run.js';

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) { return executeExportWorkflow(this.env, event.payload, step); }
}
