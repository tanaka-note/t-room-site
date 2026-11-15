import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture } from './fixture.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('calendar keeps Diary design and behavior while preserving payment year boundaries', () => {
  const source = read('../public/troom-date-picker.js');
  const diary = read('../../diary-worker/public/troom-date-picker.js').replace('const MAX_YEAR = 2100;', 'const MAX_YEAR = 9999;')
    .replace('dialog.addEventListener("close", resetCalendar);', 'dialog.addEventListener("close", () => {\n      if (!state.navigation) resetCalendar();\n    });')
    .replace('navigation.register("troom-calendar-dialog", { dialog: ensureDialog() });', 'navigation.register("troom-calendar-dialog", { dialog: ensureDialog(), onClose: resetCalendar });');
  assert.equal(source.slice(source.indexOf('(() =>')), diary);
  assert.equal(read('../public/troom-date-picker.css'), read('../../diary-worker/public/troom-date-picker.css'));
  // Diary also has album-only controls and defaults to instant positioning.
  // Payments retains smooth scrolling; compare the shared base layout only.
  const wheelRules = read('../public/date-wheel.css').match(/^\.date-wheel[^\n{]+\{\n[^}]*\}/gm);
  assert.ok(wheelRules?.some(rule => rule.startsWith('.date-wheel-dialog {')));
  assert.ok(wheelRules.some(rule => rule.startsWith('.date-wheel-column {')));
  const diaryStyles = read('../../diary-worker/public/diary.css');
  for (const rule of wheelRules) {
    const sharedRule = rule.startsWith('.date-wheel-column {')
      ? rule.replace('scroll-behavior: smooth;', 'scroll-behavior: auto;') : rule;
    assert.ok(diaryStyles.includes(sharedRule), rule.split('\n')[0]);
  }
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
