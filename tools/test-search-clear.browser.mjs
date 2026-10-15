import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const { chromium, webkit } = createRequire(new URL('../diary-worker/package.json', import.meta.url))('playwright');
const cases = [
  ['diary', 'diary-worker/public/index.html', '#diary-search-input', '#diary-search-clear'],
  ['diary', 'diary-worker/public/index.html', '#tag-search-input', '[data-clear-search="tag-search-input"]'],
  ['diary', 'diary-worker/public/index.html', '#photo-entry-search', '[data-clear-search="photo-entry-search"]'],
  ['diary', 'diary-worker/public/index.html', '#photo-file-name-search', '[data-clear-search="photo-file-name-search"]'],
  ['cloud', 'cloud-worker/public/index.html', '#search-input', '[data-search-clear="search-input"]'],
  ['cloud', 'cloud-worker/public/index.html', '#floating-search-input', '[data-search-clear="floating-search-input"]'],
  ['cloud', 'cloud-worker/public/share.html', '#share-search', '#share-search-clear'],
  ['inventory', 'inventory-worker/public/index.html', '#search', '#search-clear'],
  ['site', 'diary.html', '#diary-search-input', '[data-diary-search-clear]'],
  ['site', 'learning/index.html', '#learning-global-search', '[data-learning-search-clear]'],
  ['site', 'learning/sharoushi/logs/index.html', '#learning-log-search', '[data-learning-search-clear]']
];
const selected = cases.filter(([target]) => !process.env.VERIFY_TARGET || process.env.VERIFY_TARGET === target);
assert.ok(selected.length, 'Select a service with search clear buttons');
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://fixture').pathname.replace(/^\/(cloud|diary|inventory)\//, '/$1-worker/public/');
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', extname(path) === '.css' ? 'text/css' : 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let count = 0;
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => !process.env.TROOM_BROWSER || process.env.TROOM_BROWSER === name)) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile });
        try {
          for (const [target, file, inputSelector, buttonSelector] of selected) {
            const page = await context.newPage();
            await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
            // Use the actual markup and styles, without booting services or making authenticated requests.
            const html = (await readFile(resolve(root, file), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
            await page.setContent(html.replace(/<head>/i, `<head><base href="${origin}/${file}">`), { waitUntil: 'load' });
            await page.evaluate(({ inputSelector, buttonSelector }) => {
              const input = document.querySelector(inputSelector), button = document.querySelector(buttonSelector);
              for (let node = input.parentElement; node; node = node.parentElement) {
                node.hidden = false;
                if (node instanceof HTMLDialogElement) node.showModal();
                if (node.id === 'floating-toolbar') { node.classList.add('visible'); node.style.cssText = 'position:static;transform:none;visibility:visible;opacity:1;pointer-events:auto'; }
              }
              input.value = '検索'; button.hidden = false;
              for (const node of [input, button]) node.scrollIntoView({ block: 'center', behavior: 'instant' });
            }, { inputSelector, buttonSelector });
            const actual = await page.evaluate(({ inputSelector, buttonSelector }) => {
              const input = document.querySelector(inputSelector), button = document.querySelector(buttonSelector);
              const field = input.getBoundingClientRect(), box = button.getBoundingClientRect(), style = getComputedStyle(button);
              const hits = (x, y) => document.elementFromPoint(x, y)?.closest('button') === button;
              return { width: box.width, height: box.height, background: style.backgroundColor, color: style.color,
                inputPadding: parseFloat(getComputedStyle(input).paddingRight),
                inside: box.top >= field.top - 1 && box.bottom <= field.bottom + 1 && box.right <= field.right,
                center: hits(box.x + 17, box.y + 17), edge: hits(box.x + 2, box.y + 17),
                outside: hits(box.x - 2, box.y + 17), corner: hits(box.x + 1, box.y + 1) };
            }, { inputSelector, buttonSelector });
            assert.deepEqual(actual, { width: 34, height: 34, background: 'rgb(245, 243, 237)', color: 'rgb(93, 102, 115)', inputPadding: 54, inside: true, center: true, edge: true, outside: false, corner: false }, `${name} ${mobile ? 'touch' : 'desktop'} ${file} ${inputSelector}`);
            if (target === 'inventory' || inputSelector.startsWith('#photo-') || inputSelector === '#tag-search-input') {
              await page.locator(inputSelector).fill('');
              assert.equal(await page.locator(buttonSelector).isVisible(), false, `No hit target remains when ${file} ${inputSelector} is empty`);
            }
            if (inputSelector === '#share-search') {
              await page.addScriptTag({ content: await readFile(resolve(root, 'cloud-worker/public/ui.js'), 'utf8') });
              const source = await readFile(resolve(root, 'cloud-worker/public/share.js'), 'utf8');
              await page.addScriptTag({ content: source.replace('document.addEventListener("DOMContentLoaded", initialize);', '') + '\nbindEvents();' });
              await page.locator(inputSelector).fill('検索');
              if (mobile) await page.locator(buttonSelector).tap();
              else await page.locator(buttonSelector).click();
              assert.equal(await page.locator(inputSelector).inputValue(), '');
              assert.equal(await page.locator(buttonSelector).isVisible(), false);
              assert.equal(await page.locator(inputSelector).evaluate(node => node === document.activeElement), true);
            }
            count++; await page.close();
          }
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`PASS ${count} search-clear geometry cases: diary-sized round hit target, input padding, outside/corner protection and empty state`);
} finally { await new Promise(resolve => server.close(resolve)); }
