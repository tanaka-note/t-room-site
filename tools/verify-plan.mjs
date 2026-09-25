import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const services = ['cloud', 'security', 'diary', 'billing', 'downloader', 'downloader2', 'ai'];
export const android = ['android-tcloud', 'android-tcloud-twa', 'android-diary-twa', 'android-ai-chat'];
export const targets = ['tooling', 'site', ...services, 'auth', 'container-unit', ...android];
const registry = JSON.parse(readFileSync(new URL('../web-apps.json', import.meta.url), 'utf8'));
const node = (cwd, ...args) => ({ cwd, args });
const files = (dir, pattern) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => pattern.test(f)).sort();
const tests = (cwd, ...paths) => paths.map(path => node(cwd, path));

// Profiles reuse the existing tests. Remote HTTP suites and Container builds are
// deliberately separate: these commands never need a production credential.
export function commands(target) {
  if (!targets.includes(target)) throw new Error(`Unknown verify target: ${target}`);
  if (android.includes(target)) return [{ cwd: target, gradle: true, args: [':app:assembleDebug', ':app:testDebugUnitTest', '--no-daemon'] }];
  const checks = services.includes(target) ? [{ cwd: `${target}-worker`, script: 'check' }] : [];
  // Downloader's existing check also compiles Python; no Docker or definition refresh.
  const suites = {
    tooling: [node('.', '--test', 'tools/test-development-flow.mjs', 'tools/test-secret-ignore.mjs', 'tools/test-web-app-build-freshness.mjs')],
    site: [
      { cwd: '.', script: 'brand:test' },
      node('.', 'tools/check-web-app-builds.mjs', '--target', 't-room-site'),
      node('.', 'tools/verify-web-contracts.mjs'),
      { cwd: '.', script: 'browser-policy:test' }
    ],
    cloud: tests('cloud-worker', ...[
      'crypto-roundtrip', 'member-api-boundary', 'passkey-session-resume', 'permission-guards', 'password-session-lifetime',
      'manual-thumbnail-api', 'encrypted-thumbnail-policy', 'favorites-api', 'share-isolation',
      'media-range', 'media-prefetch', 'media-long-range', 'offline-storage', 'file-safety', 'display-cache', 'startup-view', 'preview-sorting', 'sort-preferences-preview-cleanup'
    ].map(n => `tests/${n}.mjs`)),
    security: [node('security-worker', '--test', ...files('security-worker/test', /\.test\.js$/).map(f => `test/${f}`))],
    diary: tests('diary-worker', ...['request-safety', 'backup', 'last-published-migration', 'search-text', 'favorites-ui', 'drafts-ui', 'entry-time-ui', 'entry-time.e2e', 'history-ui', 'navigation-return-ui', 'pwa-ui', 'startup-view'].map(n => `tests/${n}.mjs`), 'tests/permissions.e2e.mjs'),
    billing: [{ cwd: 'billing-worker', script: 'test' }],
    downloader: [node('downloader-worker', '--test', ...files('downloader-worker/test', /\.test\.js$/).map(f => `test/${f}`))],
    downloader2: [{ cwd: 'downloader2-worker', script: 'test' }],
    ai: [{ cwd: 'ai-worker', script: 'test' }],
    'container-unit': [node('downloader-worker', 'test/run-python.mjs', '-m', 'unittest', 'discover', '-s', 'container/tests', '-p', 'test_*.py')],
    auth: [node('.', '--test', 'tools/test-session-secret.mjs', 'tools/test-password-auth.mjs'),
      node('security-worker', '--test', 'test/service-passkey-session.test.js', 'test/security-contract.test.js', 'test/primary-admin-setup.test.js'),
      ...tests('cloud-worker', 'tests/passkey-session-resume.mjs', 'tests/password-session-lifetime.mjs', 'tests/permission-guards.mjs'),
      node('diary-worker', 'tests/permissions.e2e.mjs'), { cwd: 'billing-worker', script: 'test' }, { cwd: 'ai-worker', script: 'test' }]
  };
  return [...checks, ...suites[target]];
}

export function browserTests(target) {
  const existing = ({ tooling: ['tools/test-browser-trace.mjs'], site: ['tools/test-public-site-visual.mjs'], cloud: ['cloud-worker/tests/favorites-navigation.browser.mjs', 'cloud-worker/tests/manual-video-thumbnail.browser.mjs', 'cloud-worker/tests/preview-player-parity.browser.mjs', 'cloud-worker/tests/media-long-range.browser.mjs'],
    security: ['security-worker/test/audit-history.browser.mjs', 'security-worker/test/invite-completion.browser.mjs'],
    diary: ['diary-worker/tests/browser/favorites-flow.mjs', 'diary-worker/tests/browser/entry-time.mjs', 'diary-worker/tests/browser/photo-marker-atomicity.mjs'] })[target] || [];
  return ['cloud', 'security', 'diary', 'billing'].includes(target)
    ? [...existing, 'diary-worker/tests/browser/passkey-account-dialog.mjs'] : existing;
}

export function affected(paths) {
  const selected = new Set();
  const add = (...values) => values.forEach(v => selected.add(v));
  for (const raw of paths) {
    const path = raw.replaceAll('\\', '/');
    if (/^(docs\/|README\.md$|AGENTS\.md$)/.test(path) || /\.md$/.test(path)) continue;
    if (/^(tools\/(verify|install-verify|test-development|test-browser|browser-|local-dev|release|worker-logs)|\.github\/|\.node-version$)/.test(path)) { add('tooling'); continue; }
    if (path === '.gitignore' || path === 'tools/test-secret-ignore.mjs') { add('tooling'); continue; }
    if (path === 'tools/test-session-secret.mjs') { add('auth'); continue; }
    if (path === 'assets/session-secret.mjs') add(...services, 'auth');
    if (/^(package\.json$|pnpm-)/.test(path)) { add('tooling', 'site'); continue; }
    const mobile = android.find(d => path.startsWith(`${d}/`));
    if (mobile) { add(mobile); continue; }
    const service = services.find(s => path.startsWith(`${s}-worker/`));
    if (service) add(service);
    if (/^downloader2-(?:extension|native|fixtures)\//.test(path)) add('downloader2');
    if (/^downloader-worker\/container\//.test(path)) add('container-unit');
    // The server is monolithic: any Security runtime edit can affect handoff.
    if (/^security-worker\/(src\/|public\/passkey-client\.js)/.test(path)
      || /^assets\/(passkey|password-auth|session-policy|session-secret|security-audit|account-display)/.test(path)
      || /^tools\/password-auth/.test(path)) add('auth');
    if (/^cloud-worker\/public\/(crypto-vault|vendor\/argon2)/.test(path)) add('security', 'auth');
    // Registry build dependencies are the authoritative cross-service asset map.
    for (const app of registry.apps) {
      if ((app.buildFiles || []).includes(path) || (app.buildRoots || []).some(d => path.startsWith(`${d}/`))) {
        const consumer = services.find(s => app.deployCwd === `${s}-worker`);
        if (consumer) add(consumer);
      }
    }
    if (/^assets\//.test(path) && !/^assets\/(passkey|password-auth|session-policy|session-secret|security-audit|account-display)/.test(path)) add('site', 'cloud', 'security', 'diary', 'billing');
    if (!service && !/^assets\//.test(path)) add('site');
    if (/service-worker|webmanifest|web-apps\.json|pwa-auto-update/.test(path)) add('site');
  }
  return targets.filter(t => selected.has(t));
}

export function changedFiles(base, head, cwd = root) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (base) {
    // Include both sides of renames/deletions; invalid/missing refs fail, never skip CI.
    if (/^0+$/.test(base)) return git(['ls-tree', '-rz', '--name-only', head || 'HEAD']);
    const comparison = head ? `${base}...${head}` : base;
    return git(['diff', '--no-renames', '--name-only', '-z', comparison, '--']);
  }
  return [...new Set([...git(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']), ...git(['ls-files', '--others', '--exclude-standard', '-z'])])];
}

export function installDirectories(selected) {
  const dirs = new Set(['.']);
  for (const target of selected) {
    if (target === 'site') dirs.add('security-worker');
    if (services.includes(target)) dirs.add(`${target}-worker`);
    if (['tooling', 'site', 'cloud', 'security', 'diary', 'billing', 'auth'].includes(target)) dirs.add('diary-worker');
    if (target === 'auth') for (const s of ['security', 'cloud', 'billing', 'ai']) dirs.add(`${s}-worker`);
  }
  return [...dirs];
}
