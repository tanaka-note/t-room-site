import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands, browserTests, affected } from './verify-plan.mjs';

test('Diary CI always executes recently upgraded photo safety suites', () => {
  const scripts = new Set(commands('diary')
    .filter(command => command.cwd === 'diary-worker')
    .flatMap(command => command.args || []));
  for (const script of [
    'tests/photo-migration.test.mjs',
    'tests/photo-preparation.mjs',
    'tests/photo-upload.mjs',
    'tests/photo-save-timing.mjs',
    'tests/photo-rich-text-editing-ui.mjs',
    'tests/photo-backup.test.js',
    'tests/photo-backup.workerd.mjs',
    'tests/album-photo-deletion.mjs',
    'tests/photo-order.mjs',
    'tests/backup.mjs'
  ]) {
    assert.ok(scripts.has(script), `Diary verification omits safety regression: ${script}`);
  }
});

test('Diary CI uses synthetic browser coverage for migration, album and navigation', () => {
  const scripts = new Set(browserTests('diary'));
  for (const script of [
    'diary-worker/tests/browser/photo-migration.mjs',
    'diary-worker/tests/browser/photo-deletion.mjs',
    'diary-worker/tests/browser/album-photo-order.mjs',
    'diary-worker/tests/browser/navigation-return.mjs',
    'diary-worker/tests/browser/passkey-login.mjs'
  ]) {
    assert.ok(scripts.has(script), `Diary browser verification omits: ${script}`);
  }
});

test('Migration and photo-backup source changes select the Diary suite', () => {
  for (const path of [
    'diary-worker/public/photo-migration-core.js',
    'diary-worker/public/photo-migration.js',
    'diary-worker/src/photo-deletion.js',
    'diary-worker/src/photo-backup-job.js',
    'diary-worker/tests/photo-migration.test.mjs'
  ]) {
    assert.ok(affected([path]).includes('diary'), `CI target selection misses: ${path}`);
  }
});
