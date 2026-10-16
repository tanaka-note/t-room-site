import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
for (const directory of ['public', 'src']) {
  for (const file of (await readdir(new URL(`../${directory}/`, import.meta.url))).filter(name => /\.(?:js|mjs)$/.test(name)).sort()) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`../${directory}/${file}`, import.meta.url))], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
