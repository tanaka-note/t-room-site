import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture } from './fixture.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const assets = ['dialog-navigation.js', 'troom-date-picker.js', 'troom-date-picker.css', 'date-wheel.js', 'date-wheel.css'];

test('Portfolio uses registered shared date components and keeps the existing 1900–9999 year range', () => {
  const registry = JSON.parse(read('../../web-apps.json'));
  const app = registry.apps.find(a => a.id === 'portfolio');
  for (const name of assets) {
    const source = name === 'dialog-navigation.js' ? `diary-worker/public/${name}` : `payments-worker/public/${name}`;
    assert.ok(app.buildFiles.includes(source));
    assert.ok(app.assetCopies.some(copy => copy.source === source && copy.copy === `portfolio-worker/public/${name}`));
    assert.equal(read(`../public/${name}`), read(`../../${source}`));
  }
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
  vm.runInNewContext(read('../public/troom-date-picker.js'), context);
  const picker = context.window.TRoomDatePicker;
  for (const date of ['1900-01-01', '2028-02-29', '2101-12-31', '9999-12-31']) assert.equal(picker.formatValue(picker.parseValue(date)), date);
  for (const date of ['1899-12-31', '2027-02-29', '2026-04-31']) assert.equal(picker.parseValue(date), null);
});

test('the Worker serves shared picker assets without authentication and without caching financial data', async () => {
  const f = fixture();
  try {
    f.env.ASSETS.fetch = request => new Response(read(`../public${new URL(request.url).pathname}`));
    for (const name of assets) {
      const response = await f.request(`/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(await response.text(), read(`../public/${name}`));
    }
    assert.equal((await f.request('/api/data')).status, 401);
  } finally { f.close(); }
});
