import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import '../public/search-input.js';

class Control extends EventTarget {
  value = '';
  hidden = true;
  dataset = {};
  focus(options) { this.focusOptions = options; }
  input(value, isComposing = false) {
    this.value = value;
    const event = new Event('input');
    Object.defineProperty(event, 'isComposing', { value: isComposing });
    this.dispatchEvent(event);
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let query = '', result = { ok: true };
  const calls = [], inputs = [new Control(), new Control()];
  inputs.forEach((input, index) => { input.id = `search-${index}`; });
  const clearButtons = inputs.map(input => {
    const button = new Control();
    button.dataset.searchClear = input.id;
    button.ownerDocument = { getElementById: id => inputs.find(item => item.id === id) };
    return button;
  });
  const resultCount = new Control();
  const controller = TCloudSearchInput.create({
    inputs, clearButtons, resultCount,
    getQuery: () => query,
    setQuery: value => { query = value; },
    invalidateSearch: () => calls.push('invalidate'),
    pauseForComposition: () => calls.push('composition'),
    loadItems: async () => { calls.push(`load:${query}`); return result; },
    onResults: () => calls.push('scroll')
  });
  return { inputs, clearButtons, resultCount, controller, calls,
    get query() { return query; },
    setQuery(value) { query = value; },
    setResult(value) { result = value; }
  };
}

test('typing synchronizes both fields immediately and loads only the latest query after 250ms', async t => {
  const f = fixture(t);
  f.inputs[0].input('  first  ');
  assert.equal(f.query, 'first');
  assert.equal(f.inputs[0].value, '  first  ', 'Keep the caret/input text of the source field');
  assert.equal(f.inputs[1].value, 'first');
  assert.ok(f.clearButtons.every(button => !button.hidden));
  assert.equal(f.resultCount.textContent, '検索中…');
  assert.equal(f.resultCount.hidden, false);
  t.mock.timers.tick(200);
  f.inputs[1].input('latest');
  assert.equal(f.inputs[0].value, 'latest');
  t.mock.timers.tick(249);
  assert.deepEqual(f.calls, ['invalidate', 'invalidate']);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['invalidate', 'invalidate', 'load:latest', 'scroll']);
});

test('Japanese composition cancels the pending timer and searches only after conversion completes', async t => {
  const f = fixture(t);
  f.inputs[0].input('before');
  f.inputs[0].dispatchEvent(new Event('compositionstart'));
  f.inputs[0].input('日本');
  t.mock.timers.tick(400);
  assert.deepEqual(f.calls, ['invalidate', 'composition']);
  assert.equal(f.inputs[1].value, '日本');
  f.inputs[0].dispatchEvent(new Event('compositionend'));
  t.mock.timers.tick(249);
  assert.deepEqual(f.calls, ['invalidate', 'composition', 'invalidate']);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(f.calls.slice(-2), ['load:日本', 'scroll']);
});

test('isComposing input is synchronized without starting a search', t => {
  const f = fixture(t);
  f.inputs[1].input('変換中', true);
  t.mock.timers.tick(1000);
  assert.equal(f.query, '変換中');
  assert.equal(f.inputs[0].value, '変換中');
  assert.deepEqual(f.calls, []);
});

test('either clear button clears both fields, hides both buttons and returns focus without scrolling', async t => {
  const f = fixture(t);
  for (let i = 0; i < f.clearButtons.length; i++) {
    f.inputs[i].input('query');
    f.calls.length = 0;
    const click = new Event('click', { cancelable: true });
    f.clearButtons[i].dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(f.query, '');
    assert.ok(f.inputs.every(input => input.value === ''));
    assert.ok(f.clearButtons.every(button => button.hidden));
    assert.deepEqual(f.inputs[i].focusOptions, { preventScroll: true });
    t.mock.timers.tick(250);
    await Promise.resolve();
    assert.deepEqual(f.calls, ['invalidate', 'load:', 'scroll']);
  }
});

test('navigation sync/clear does not start or cancel the existing listing timer', async t => {
  const f = fixture(t);
  f.setQuery('restored');
  f.controller.sync();
  assert.ok(f.inputs.every(input => input.value === 'restored'));
  assert.deepEqual(f.calls, []);
  f.inputs[0].input('pending');
  f.controller.clear();
  assert.equal(f.query, '');
  assert.ok(f.clearButtons.every(button => button.hidden));
  assert.deepEqual(f.calls, ['invalidate']);
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['invalidate', 'load:', 'scroll']);
});

test('an unsuccessful listing does not scroll to results', async t => {
  const f = fixture(t);
  f.setResult({ ok: false });
  f.inputs[0].input('query');
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['invalidate', 'load:query']);
});

test('the actual shell loads the controller before its caller and the service worker caches it', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../public/media-worker.js', import.meta.url), 'utf8');
  const source = html.match(/src="(\/cloud\/search-input\.js\?[^\"]+)"/);
  assert.ok(source);
  assert.ok(html.indexOf(source[1]) < html.indexOf('/cloud/cloud.js?'));
  assert.ok(worker.includes(JSON.stringify(source[1])), 'The offline shell must contain the same module URL');
});
