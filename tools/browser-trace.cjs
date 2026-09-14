// Preload only for localhost fixture tests. The runner discards successful runs.
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const dir = process.env.TROOM_TRACE_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const playwright = createRequire(join(__dirname, '../diary-worker/package.json'))('playwright');
  let sequence = 0;
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const engine = playwright[name];
    const launch = engine.launch.bind(engine);
    engine.launch = async (...args) => {
      const browser = await launch(...args);
      const contexts = new Set();
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) => {
        const context = await newContext(...options);
        const id = `${name}-${++sequence}`;
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        const close = context.close.bind(context);
        let saved = false;
        context.close = async (...closeArgs) => {
          if (!saved) {
            saved = true;
            for (const [i, page] of context.pages().entries()) {
              await page.screenshot({ path: join(dir, `${id}-${i}.png`), timeout: 3000 }).catch(() => {});
            }
            await context.tracing.stop({ path: join(dir, `${id}.zip`) });
            contexts.delete(context);
          }
          return close(...closeArgs);
        };
        contexts.add(context);
        return context;
      };
      browser.newPage = async options => (await browser.newContext(options)).newPage();
      const close = browser.close.bind(browser);
      browser.close = async (...args) => {
        for (const context of contexts) await context.close();
        return close(...args);
      };
      return browser;
    };
  }
}
