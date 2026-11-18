import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../",import.meta.url);
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const result = await build({
  absWorkingDir:fileURLToPath(root),
  entryPoints:["billing-worker/restore-checkpoint.mjs"],
  bundle:true,platform:"browser",format:"esm",target:"es2022",write:false,legalComments:"inline",
  nodePaths:[fileURLToPath(new URL("security-worker/node_modules",root))]
});
const output = new URL("billing-worker/public/billing-checkpoint-restore.mjs",root);
if (process.argv.includes("--check")) {
  if (await readFile(output,"utf8") !== result.outputFiles[0].text) throw new Error("Billing restore bundle is stale");
} else await writeFile(output,result.outputFiles[0].text);
console.log("Billing isolated SQLite restore bundle "+(process.argv.includes("--check") ? "verified" : "built"));
