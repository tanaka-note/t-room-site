import { billingLegacyProfile } from '../src/billing-legacy-profile.js';
import { restoreIsolated } from './restore-isolated.mjs';
import { createLegacyArchive } from './d1-legacy-archive.mjs';

export const {
  planArchives: planBillingArchives,
  sealArchive: sealBillingArchive,
  verifyArchive: verifyBillingArchive,
  restoreArchiveGeneration: restoreBillingArchiveGeneration,
  publishArchive: publishBillingArchive,
  verifyStoredArchive: verifyStoredBillingArchive
} = createLegacyArchive(billingLegacyProfile, restoreIsolated);
