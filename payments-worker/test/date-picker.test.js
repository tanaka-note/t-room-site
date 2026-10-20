import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture } from './fixture.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('calendar keeps Diary design and behavior while preserving payment year boundaries', () => {
  const source = read('../public/troom-date-picker.js');
  assert.equal(source.slice(source.indexOf('(() =>')), read('../../diary-worker/public/troom-date-picker.js').replace('const MAX_YEAR = 2100;', 'const MAX_YEAR = 9999;'));
  assert.equal(read('../public/troom-date-picker.css'), read('../../diary-worker/public/troom-date-picker.css'));
  const wheelLayout = read('../../diary-worker/public/diary.css').split('.date-wheel-dialog {')[1].split('\n.toast {')[0];
  assert.ok(read('../public/date-wheel.css').includes('.date-wheel-dialog {' + wheelLayout));
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
  vm.runInNewContext(source, context);
  const picker = context.window.TRoomDatePicker;
  for (const value of ['1900-01-01', '2024-02-29', '2101-12-31', '9999-12-31']) {
    assert.equal(picker.formatValue(picker.parseValue(value)), value);
  }
  for (const value of ['1899-12-31', '2025-02-29', '2026-04-31', '10000-01-01']) assert.equal(picker.parseValue(value), null);
  assert.equal(picker.formatValue(picker.parseValue('9999-12', 'month'), 'month'), '9999-12');
});

test('all picker assets are served by Payments with no-store', async () => {
  const f = fixture();
  try {
    f.env.ASSETS.fetch = async request => new Response(read(`../public${new URL(request.url).pathname}`));
    for (const file of ['troom-date-picker.js', 'troom-date-picker.css', 'date-wheel.js', 'date-wheel.css']) {
      const response = await f.request(`/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(await response.text(), read(`../public/${file}`));
    }
  } finally { f.close(); }
});
