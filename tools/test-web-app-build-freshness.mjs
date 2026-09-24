import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkWebAppBuilds } from "./check-web-app-builds.mjs";
import { runProductionDelivery } from "./release.mjs";
import { syncWebApps } from "./sync-web-app-builds.mjs";
import { expectedBuild, inspectBuildFreshness, syncContentHashApp } from "./web-app-registry.mjs";

const contract = {
  buildMeta: "troom-app-build",
  autoUpdateMeta: "troom-auto-update",
  autoUpdateValue: "enabled",
  serviceWorkerMeta: "troom-service-worker",
  updaterSource: "/assets/pwa-auto-update.js"
};

function fixtureApp(id, deployTarget) {
  return {
    id,
    name: id,
    publicUrls: [`https://example.test/${id}/`],
    entrypoints: [`${id}/index.html`],
    buildRoots: [id],
    buildConstants: [`${id}/build.js`],
    buildMode: "content-hash",
    serviceWorker: `${id}/sw.js`,
    serviceWorkerUrl: "./sw.js",
    cachePrefix: `${id}-cache-`,
    cacheNameConstant: "CACHE_NAME",
    precacheConstant: "APP_ASSETS",
    precacheMode: "html",
    deployTarget,
    deployCwd: ".",
    deployCommand: "unused"
  };
}

async function createFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "t-lain-build-freshness-"));
  await mkdir(resolve(directory, "assets"), { recursive: true });
  for (const file of ["pwa-auto-update.js", "line-browser-policy.mjs", "line-browser-worker.mjs", "line-browser-csp.mjs"]) {
    await writeFile(resolve(directory, "assets", file), `export const fixture = ${JSON.stringify(file)};\n`);
  }
  for (const id of ["site-app", "other-app"]) {
    await mkdir(resolve(directory, id), { recursive: true });
    await writeFile(resolve(directory, id, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><script src="./app.js"></script></body></html>\n`);
    await writeFile(resolve(directory, id, "app.css"), "body { color: black; }\n");
    await writeFile(resolve(directory, id, "app.js"), "console.log('fixture');\n");
    await writeFile(resolve(directory, id, "build.js"), `const APP_BUILD_ID = "old";\n`);
    await writeFile(resolve(directory, id, "sw.js"), `const CACHE_NAME = "old";\nconst APP_ASSETS = [];\n`);
  }
  return directory;
}

test("read-only freshness fails for stale markers and passes after synchronization", async () => {
  const directory = await createFixture();
  const app = fixtureApp("site-app", "t-room-site");
  try {
    const stale = await inspectBuildFreshness(app, contract, directory);
    assert.equal(stale.fresh, false);
    assert(stale.issues.some((issue) => issue.kind === "html-contract"));
    await syncContentHashApp(app, contract, directory);
    const fresh = await inspectBuildFreshness(app, contract, directory);
    assert.equal(fresh.fresh, true);
    const path = resolve(directory, app.entrypoints[0]);
    const before = await readFile(path, "utf8");
    const checked = await checkWebAppBuilds({ registry: { contract, apps: [app] }, target: "t-room-site", baseDirectory: directory });
    assert.equal(checked[0].fresh, true);
    assert.equal(await readFile(path, "utf8"), before, "freshness check must not write markers");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("target-scoped sync changes only apps on the selected deploy target and unknown targets fail closed", async () => {
  const directory = await createFixture();
  const selected = fixtureApp("site-app", "t-room-site");
  const other = fixtureApp("other-app", "t-room-other");
  const registry = { contract, apps: [selected, other] };
  const otherPath = resolve(directory, other.entrypoints[0]);
  const before = await readFile(otherPath, "utf8");
  try {
    const results = await syncWebApps({ registry, target: "t-room-site", baseDirectory: directory });
    assert.deepEqual(results.map((result) => result.app), ["site-app"]);
    assert.equal(await readFile(otherPath, "utf8"), before);
    await assert.rejects(() => syncWebApps({ registry, target: "missing-target", baseDirectory: directory }), /Unknown app id or deploy target/);
    await assert.rejects(() => checkWebAppBuilds({ registry, target: "missing-target", baseDirectory: directory }), /Unknown app id or deploy target/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("content hashes normalize JavaScript module line endings", async () => {
  const directory = await createFixture();
  const app = fixtureApp("site-app", "t-room-site");
  const modulePath = resolve(directory, "assets", "line-browser-csp.mjs");
  try {
    const before = await expectedBuild(app, contract, directory);
    const source = await readFile(modulePath, "utf8");
    await writeFile(modulePath, source.replaceAll("\n", "\r\n"));
    assert.equal(await expectedBuild(app, contract, directory), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production delivery stops before deploy on stale preflight and retains post-deploy verification", () => {
  const app = { deployTarget: "t-room-site", deployCwd: "." };
  const stopped = [];
  assert.throws(() => runProductionDelivery(app, {
    rootDirectory: "root",
    deployDirectory: "deploy",
    runCommand(cwd, args) {
      stopped.push([cwd, ...args]);
      if (args[0] === "tools/check-web-app-builds.mjs") throw new Error("stale");
    }
  }), /stale/);
  assert.equal(stopped.length, 1);

  const completed = [];
  runProductionDelivery(app, {
    rootDirectory: "root",
    deployDirectory: "deploy",
    runCommand: (cwd, args) => completed.push([cwd, ...args])
  });
  assert.match(completed[0][1], /check-web-app-builds/);
  assert.equal(completed[1].at(-1), "deploy");
  assert.match(completed[2][1], /verify-web-app-builds/);
});
