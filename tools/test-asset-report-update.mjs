import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, join } from 'node:path';
import { dataPath, parsePortfolioModule, prepareReportUpdate, updateAssetReport } from './update-asset-report.mjs';
import { filesForApp, inspectBuildFreshness, loadWebAppRegistry, workspace } from './web-app-registry.mjs';
import { validatePortfolioData } from '../asset-report-k7m4q9x2/portfolio-model.mjs';

test('updates are validated and staged before changing data, HTML and managed metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 't-lain-asset-update-test-'));
  const registry = await loadWebAppRegistry();
  const app = registry.apps.find(app => app.id === 'asset-report');
  try {
    for (const file of [...await filesForApp(app), resolve(workspace, 'web-apps.json')]) {
      const target = resolve(root, relative(workspace, file));
      await mkdir(dirname(target), { recursive: true });
      await cp(file, target);
    }
    const current = parsePortfolioModule(await readFile(resolve(root, dataPath), 'utf8'));
    const nextDay = new Date(current.period + 'T00:00:00Z'); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const prices = Object.fromEntries(current.assets.map((asset, index) => [asset.id, asset.marketValue + index + 1]));
    const input = { period: nextDay.toISOString().slice(0, 10), marketValues: prices };
    const monitored = [dataPath, app.entrypoints[0], app.serviceWorker, 'asset-report-k7m4q9x2/report.js'];
    const snapshot = () => Promise.all(monitored.map(path => readFile(resolve(root, path), 'utf8')));
    const before = await snapshot();
    const missing = { ...prices }; delete missing[current.assets[0].id];
    for (const bad of [
      { ...input, period: current.period }, { ...input, period: '2000-01-01' }, { ...input, period: '2024-02-30' },
      { ...input, marketValues: { ...prices, unknown: 123 } }, { ...input, marketValues: missing },
      { ...input, basePrincipal: current.basePrincipal + 1 }, { ...input, rawMarketValue: 1 }, { ...input, extraField: true },
      ...[NaN, Infinity, null, '12', -1, 1.25].map(value => ({ ...input, marketValues: { ...prices, [current.assets[0].id]: value } }))
    ]) {
      await assert.rejects(updateAssetReport({ rootDirectory: root, input: bad }));
      assert.deepEqual(await snapshot(), before, 'invalid input must not modify any file');
    }
    const dry = await updateAssetReport({ rootDirectory: root, input, dryRun: true });
    assert.deepEqual(await snapshot(), before, 'dry-run must not modify any file');
    assert.ok(dry.changed.includes(dataPath));
    await writeFile(resolve(root, app.entrypoints[0]), before[1].replace('id="report-updated"', 'id="broken-update-time"'));
    await assert.rejects(updateAssetReport({ rootDirectory: root, input }), /exactly one/);
    assert.equal(await readFile(resolve(root, dataPath), 'utf8'), before[0]);
    await writeFile(resolve(root, app.entrypoints[0]), before[1]);
    await writeFile(resolve(root, app.serviceWorker), before[2].replace('const CACHE_NAME', 'const BROKEN_CACHE_NAME'));
    const beforeFailure = await snapshot();
    await assert.rejects(updateAssetReport({ rootDirectory: root, input }), /CACHE_NAME/);
    assert.deepEqual(await snapshot(), beforeFailure, 'build staging failure must not change the checkout');
    await writeFile(resolve(root, app.serviceWorker), before[2]);
    const result = await updateAssetReport({ rootDirectory: root, input });
    const next = parsePortfolioModule(await readFile(resolve(root, dataPath), 'utf8'));
    validatePortfolioData(next);
    assert.equal(next.period, input.period);
    assert.equal(next.history.length, current.history.length + 1);
    assert.deepEqual(next.history.slice(0, -1), current.history);
    assert.deepEqual(next.monthlyReport, current.monthlyReport);
    assert.deepEqual(next.performanceAdjustmentSnapshots, current.performanceAdjustmentSnapshots);
    const metadata = d => d.assets.map(({ id, costBasis, color, name }) => ({ id, costBasis, color, name }));
    assert.deepEqual(metadata(next), metadata(current));
    assert.equal((await snapshot())[3], before[3], 'price updates never edit rendering logic');
    assert.equal((await inspectBuildFreshness(app, registry.contract, root)).fresh, true);
    assert.deepEqual(result.changed.sort(), [dataPath, app.entrypoints[0], app.serviceWorker].sort());
    await assert.rejects(updateAssetReport({ rootDirectory: root, input }), /newer/);
    const renamed = structuredClone(next); renamed.assets[0].name = '名称を変更した架空銘柄';
    const later = new Date(next.period + 'T00:00:00Z'); later.setUTCDate(later.getUTCDate() + 1);
    assert.equal(prepareReportUpdate(renamed, { period: later.toISOString().slice(0, 10), marketValues: prices }).assets[0].name, renamed.assets[0].name);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
