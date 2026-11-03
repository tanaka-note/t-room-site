import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./shared/pwa-install.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ loading = false, mode = '', apple = false } = {}) {
  const window = new EventTarget(), document = new EventTarget(), button = new EventTarget();
  Object.assign(button, { hidden: false, disabled: false, textContent: 'ホームへ追加', dataset: {} });
  button.click = () => { if (!button.disabled) button.dispatchEvent(new Event('click')); };
  const status = { hidden: true, textContent: '' };
  document.readyState = loading ? 'loading' : 'complete';
  document.querySelectorAll = selector => document.readyState === 'loading' ? [] : selector === '[data-pwa-install]' ? [button] : [status];
  const media = new Map();
  window.matchMedia = query => {
    const value = Object.assign(new EventTarget(), { matches: query === `(display-mode: ${mode})` });
    media.set(query, value); return value;
  };
  const navigator = { userAgent: apple ? 'iPhone' : 'Android Chrome', platform: '', maxTouchPoints: 0 };
  Object.assign(window, { document, navigator });
  vm.runInNewContext(source, { window, document, navigator, Event });
  function offer({ outcome = 'accepted', fail = false, wait } = {}) {
    let calls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => { calls++; return fail ? Promise.reject(new Error('unavailable')) : wait || Promise.resolve(); };
    event.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    return () => calls;
  }
  return { window, document, button, status, offer, media,
    ready() { document.readyState = 'complete'; document.dispatchEvent(new Event('DOMContentLoaded')); } };
}

test('captures an offer before the buttons are parsed, and prompts synchronously only once', async () => {
  const f = fixture({ loading: true });
  const calls = f.offer(); f.ready();
  assert.equal(f.button.dataset.pwaInstallState, 'ready');
  f.button.click(); f.button.click();
  assert.equal(calls(), 1, 'prompt must run within the click, before awaiting');
  assert.equal(f.button.disabled, true);
  const update = new Event('troom:before-auto-update', { cancelable: true });
  f.document.dispatchEvent(update); assert.equal(update.defaultPrevented, true);
  await tick();
  assert.match(f.status.textContent, /受け付けました/);
  assert.doesNotMatch(f.status.textContent, /完了しました/);
  assert.equal(f.window.TRoomPwaInstall.installing, false);
  f.button.click(); await tick(); assert.equal(calls(), 1);
  const allowed = new Event('troom:before-auto-update', { cancelable: true });
  f.document.dispatchEvent(allowed); assert.equal(allowed.defaultPrevented, false);
});

test('does not confuse an unavailable offer with an installed app, or send Android back to the failing menu', async () => {
  const f = fixture(); f.button.click(); await tick();
  assert.equal(f.button.dataset.pwaInstallState, 'unavailable');
  assert.match(f.status.textContent, /まだ利用できません/);
  assert.doesNotMatch(f.status.textContent, /メニュー|完了しました/);
  const apple = fixture({ apple: true }); apple.button.click(); await tick();
  assert.match(apple.status.textContent, /Safariの共有ボタン/);
});

test('dismissal and prompt failure remain retryable with a new browser offer', async () => {
  const f = fixture(); const first = f.offer({ outcome: 'dismissed' });
  f.button.click(); await tick(); assert.equal(first(), 1);
  assert.match(f.status.textContent, /キャンセル/);
  const second = f.offer({ fail: true }); f.button.click(); await tick();
  assert.equal(second(), 1); assert.match(f.status.textContent, /開けませんでした/);
  assert.equal(f.button.disabled, false);
  const third = f.offer(); f.button.click(); await tick();
  assert.equal(third(), 1); assert.match(f.status.textContent, /受け付けました/);
});

test('a replacement offer survives while the first prompt is pending', async () => {
  const f = fixture(); let resolve;
  f.offer({ outcome: 'dismissed', wait: new Promise(done => { resolve = done; }) });
  f.button.click(); const replacement = f.offer(); resolve(); await tick();
  assert.equal(f.button.dataset.pwaInstallState, 'ready');
  f.button.click(); await tick(); assert.equal(replacement(), 1);
});

test('only appinstalled confirms success and survives a later userChoice result or busy reset', async () => {
  const f = fixture(); let resolve;
  f.offer({ wait: new Promise(done => { resolve = done; }) }); f.button.click();
  f.window.dispatchEvent(new Event('appinstalled')); resolve(); await tick();
  f.window.TRoomPwaInstall.setBlocked(false);
  assert.equal(f.button.dataset.pwaInstallState, 'installed');
  assert.equal(f.button.disabled, true); assert.equal(f.button.textContent, '追加済み');
  assert.match(f.status.textContent, /完了しました/);
});

test('application busy state cannot be bypassed by a newly arriving offer', async () => {
  const f = fixture(); f.window.TRoomPwaInstall.setBlocked(true); const calls = f.offer();
  f.button.click(); await tick(); assert.equal(calls(), 0);
  f.window.TRoomPwaInstall.setBlocked(false); f.button.click(); await tick(); assert.equal(calls(), 1);
});

test('standalone, fullscreen and minimal-ui launches suppress redundant installation controls', () => {
  for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
    const f = fixture({ mode }); assert.equal(f.button.hidden, true, mode);
    assert.equal(f.status.hidden, true, mode);
    f.media.get(`(display-mode: ${mode})`).matches = false;
    f.media.get(`(display-mode: ${mode})`).dispatchEvent(new Event('change'));
    assert.equal(f.button.hidden, false);
  }
});

test('both deployed copies match the shared installer', () => {
  for (const path of ['../apps/calculator/pwa-install.js', '../portfolio-worker/public/pwa-install.js']) {
    assert.equal(readFileSync(new URL(path, import.meta.url), 'utf8'), source, path);
  }
});
