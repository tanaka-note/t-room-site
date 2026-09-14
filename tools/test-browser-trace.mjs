import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire(new URL('../diary-worker/package.json', import.meta.url))('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<h1>Local synthetic trace fixture</h1>');
  assert.equal(await page.locator('h1').textContent(), 'Local synthetic trace fixture');
} finally { await browser.close(); }
if (process.env.TROOM_TRACE_DIR) {
  const paths = readdirSync(process.env.TROOM_TRACE_DIR);
  assert.ok(paths.some(p => p.endsWith('.png')));
  const zip = paths.find(p => p.endsWith('.zip')); assert.ok(zip);
  assert.equal(readFileSync(join(process.env.TROOM_TRACE_DIR, zip)).subarray(0, 2).toString(), 'PK');
}
console.log('Browser trace and screenshot capture passed; successful runner removes artifacts.');
if (process.env.TROOM_TRACE_PROBE_FAILURE === '1') throw new Error('Intentional local trace-retention fixture failure');
