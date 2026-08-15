import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["troom-date-picker.js", "troom-date-picker.css"];
const targets = ["diary-worker/public", "billing-worker/public"];

for (const targetDirectory of targets) {
  const absoluteTarget = resolve(root, targetDirectory);
  await mkdir(absoluteTarget, { recursive: true });
  for (const source of sources) {
    await copyFile(resolve(root, "tools/shared", source), resolve(absoluteTarget, source));
  }
}

process.stdout.write("Synchronized the shared T-ROOM date picker assets.\n");
