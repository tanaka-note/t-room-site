import { exportDay, exportPrefix } from './export-backup.js';

export const billingLegacyProfile = {
  service: 'billing',
  errorPrefix: 'BillingArchive',
  format: 'troom-billing-legacy-backup-archive',
  destinationPrefix: 'sealed/billing-legacy/v1/',
  exportPrefix: exportPrefix('billing'),
  generationKey: /^d1\/billing\/(?:v[23]\/)?(?:daily\/\d{4}-\d{2}-\d{2}|monthly\/\d{4}-\d{2})\.json\.gz$/,
  partKey: /^d1\/billing\/v3\/data\/[a-f0-9-]{36}\/\d{6}\.json\.gz$/,
  requireRecordedHash: key => /^d1\/billing\/v[23]\//.test(key),
  verifyRestored(db, payload, key) {
    const isExport = key.startsWith(exportPrefix('billing'));
    if (isExport ? payload.format !== 'troom-d1-export-v3' : ![1, 2].includes(payload.formatVersion)) {
      throw new Error('BillingArchiveFormatMismatch');
    }
    const date = Date.parse(payload.scheduledFor ?? payload.createdAt);
    if (!Number.isFinite(date)) throw new Error('BillingArchiveGenerationMismatch');
    const day = exportDay(date);
    const expected = key.includes('/monthly/') ? day.slice(0, 7) : day;
    if (key.split('/').at(-1) !== `${expected}.json.gz`) throw new Error('BillingArchiveGenerationMismatch');
    if (db.prepare('SELECT EXISTS (SELECT 1 FROM billing_accounts WHERE is_active != 0) AS active').get().active) {
      throw new Error('BillingArchiveAccountsActive');
    }
  }
};
