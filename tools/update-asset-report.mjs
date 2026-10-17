import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortfolioModel, isReportDate, rawMarketValue, validatePortfolioData } from '../asset-report-k7m4q9x2/portfolio-model.mjs';
import { filesForApp, inspectBuildFreshness, syncContentHashApp } from './web-app-registry.mjs';

export const dataPath = 'asset-report-k7m4q9x2/data/portfolio-data.mjs';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function parsePortfolioModule(source) {
  const match = source.match(/^\s*export default\s+([\s\S]+);\s*$/);
  if (!match) throw new Error('Portfolio data must be an export default JSON object');
  return JSON.parse(match[1]);
}

export function serializePortfolioData(data) {
  return `export default ${JSON.stringify(data, null, 2)};\n`;
}

export function prepareReportUpdate(current, input) {
  validatePortfolioData(current);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object');
  const allowed = ['period', 'marketValues', 'rawMarketValue', 'basePrincipal'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown input field');
  if (!isReportDate(input.period)) throw new Error('period must be a valid YYYY-MM-DD date');
  if (input.period <= current.period) throw new Error('Update date must be newer than the latest history; duplicate dates are rejected');
  if (Object.hasOwn(input, 'basePrincipal') && input.basePrincipal !== current.basePrincipal) throw new Error('basePrincipal cannot be changed by a price update');
  const prices = input.marketValues;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new Error('marketValues must be an object keyed by stable asset ID');
  const knownIds = new Set(current.assets.map(asset => asset.id));
  if (Object.keys(prices).some(id => !knownIds.has(id))) throw new Error('Unknown asset ID');
  if (Object.keys(prices).length !== knownIds.size) throw new Error('Every asset ID must have a marketValue');
  const next = structuredClone(current);
  for (const asset of next.assets) {
    if (!Object.hasOwn(prices, asset.id) || !Number.isSafeInteger(prices[asset.id]) || prices[asset.id] < 0) throw new Error('marketValues must contain nonnegative safe integers');
    asset.marketValue = prices[asset.id];
  }
  const raw = rawMarketValue(next);
  if (Object.hasOwn(input, 'rawMarketValue') && input.rawMarketValue !== raw) throw new Error('rawMarketValue does not match the asset total');
  next.period = input.period;
  next.history.push({ period: input.period, basePrincipal: next.basePrincipal, rawMarketValue: raw });
  validatePortfolioData(next);
  return next;
}

export function updateHtmlPeriod(html, period) {
  const pattern = /<time id="report-updated" datetime="[^"]+">[^<]+<\/time>/g;
  if ([...html.matchAll(pattern)].length !== 1) throw new Error('HTML must have exactly one report-updated time element');
  return html.replace(pattern, `<time id="report-updated" datetime="${period}">${period.replaceAll('-', '.')}</time>`);
}

export async function updateAssetReport({ input, rootDirectory = repositoryRoot, dryRun = false }) {
  const current = parsePortfolioModule(await readFile(resolve(rootDirectory, dataPath), 'utf8'));
  const next = prepareReportUpdate(current, input);
  const registry = JSON.parse(await readFile(resolve(rootDirectory, 'web-apps.json'), 'utf8'));
  const app = registry.apps.find(app => app.id === 'asset-report');
  if (!app) throw new Error('asset-report is missing from web-apps.json');
  const htmlPath = app.entrypoints[0];
  const html = updateHtmlPeriod(await readFile(resolve(rootDirectory, htmlPath), 'utf8'), next.period);
  // Validate and synchronize in a disposable copy. Invalid input or a build
  // preparation error cannot leave the real checkout partially updated.
  const stagingRoot = await mkdtemp(join(tmpdir(), 't-lain-asset-update-'));
  try {
    for (const file of await filesForApp(app, rootDirectory)) {
      const destination = resolve(stagingRoot, file.slice(resolve(rootDirectory).length + 1));
      await mkdir(dirname(destination), { recursive: true });
      await cp(file, destination);
    }
    await writeFile(resolve(stagingRoot, dataPath), serializePortfolioData(next));
    await writeFile(resolve(stagingRoot, htmlPath), html);
    const synced = await syncContentHashApp(app, registry.contract, stagingRoot);
    const freshness = await inspectBuildFreshness(app, registry.contract, stagingRoot);
    if (!freshness.fresh) throw new Error('Staged asset-report build is not fresh');
    const paths = [...new Set([dataPath, htmlPath, ...synced.changed])];
    const prepared = [];
    for (const path of paths) {
      if (!path.startsWith('asset-report-k7m4q9x2/')) throw new Error('Refusing to modify another application');
      const before = await readFile(resolve(rootDirectory, path), 'utf8');
      const after = await readFile(resolve(stagingRoot, path), 'utf8');
      if (before !== after) prepared.push({ path, before, after });
    }
    if (!dryRun) {
      const written = [];
      try {
        for (const change of prepared) {
          written.push(change);
          await writeFile(resolve(rootDirectory, change.path), change.after);
        }
      } catch (error) {
        const rollback = await Promise.allSettled(written.map(change => writeFile(resolve(rootDirectory, change.path), change.before)));
        const failed = rollback.filter(result => result.status === 'rejected');
        if (failed.length) throw new AggregateError([error, ...failed.map(result => result.reason)], 'Update and rollback failed; restore the reported files from Git');
        throw error;
      }
    }
    return { period: next.period, ...createPortfolioModel(next).summary(), build: synced.build, dryRun, changed: prepared.map(change => change.path) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const inputIndex = args.indexOf('--input');
    if (inputIndex < 0 || !args[inputIndex + 1] || args.some((arg, index) => index !== inputIndex + 1 && !['--input', '--dry-run'].includes(arg))) throw new Error('Usage: node tools/update-asset-report.mjs --input prices.json [--dry-run]');
    const input = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
    console.log(JSON.stringify(await updateAssetReport({ input, dryRun: args.includes('--dry-run') }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
