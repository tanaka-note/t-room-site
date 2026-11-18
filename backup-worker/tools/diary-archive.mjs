import { exportSpec } from '../src/export-backup.js';
import { restoreIsolated } from './restore-isolated.mjs';
import { createLegacyArchive } from './d1-legacy-archive.mjs';

export const {
  planArchives: planDiaryArchives,
  sealArchive: sealDiaryArchive,
  verifyArchive: verifyDiaryArchive,
  restoreArchiveGeneration: restoreDiaryArchiveGeneration,
  publishArchive: publishDiaryArchive,
  verifyStoredArchive: verifyStoredDiaryArchive
} = createLegacyArchive({
  service: 'diary',
  errorPrefix: 'DiaryArchive',
  format: 'troom-diary-legacy-backup-archive',
  destinationPrefix: 'sealed/diary-legacy/v1/',
  exportPrefix: 'v9/',
  generationKey: /^(?:v[89]\/)?(?:daily\/\d{4}-\d{2}-\d{2}|monthly\/\d{4}-\d{2})\.json\.gz$/,
  partKey: /^v9\/data\/[a-f0-9-]{36}\/\d{6}\.json\.gz$/,
  requireRecordedHash: key => key.startsWith('v9/') || key.startsWith('v8/'),
  verifyRestored(db, payload, key) {
    const formatMatches = key.startsWith('v9/') ? payload.expectedMigration === exportSpec('diary').migration
      : key.startsWith('v8/') ? payload.formatVersion === 8 : [3, 6, 7].includes(payload.formatVersion);
    if (!formatMatches) throw new Error('DiaryArchiveFormatMismatch');
    if (!key.startsWith('v9/')) {
      const date = payload.japanDate;
      const expected = key.includes('monthly/') ? date?.slice(0, 7) : date;
      if (key.split('/').at(-1) !== `${expected}.json.gz`) throw new Error('DiaryArchiveGenerationMismatch');
    }
    if (db.prepare('SELECT count(*) AS n FROM diary_accounts WHERE active != 0').get().n) throw new Error('DiaryArchiveAccountsActive');
  }
}, restoreIsolated);
