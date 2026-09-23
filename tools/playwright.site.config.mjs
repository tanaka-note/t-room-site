import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../diary-worker/package.json", import.meta.url));
const { defineConfig } = require("playwright/test");
const tools = fileURLToPath(new URL("./", import.meta.url));
const outputDir = process.env.TROOM_TRACE_DIR
  ? resolve(process.env.TROOM_TRACE_DIR, "public-site-visual")
  : resolve(tools, "../tmp/public-site-visual-results");

export default defineConfig({
  testDir: tools,
  testMatch: "public-site.visual.spec.mjs",
  outputDir,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.015,
      threshold: 0.2
    }
  },
  snapshotPathTemplate: "{testDir}/public-site-visual-baselines/{projectName}/{arg}{ext}",
  reporter: [["line"]],
  use: {
    browserName: "chromium",
    launchOptions: { args: ["--font-render-hinting=none"] },
    colorScheme: "light",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true }
    }
  ]
});
