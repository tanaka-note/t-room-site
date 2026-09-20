import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const prefix of ['', 'worker/', 'worker/nested/']) {
  test(`environment files are ignored; templates trackable: ${prefix || 'root'}`, () => {
    for (const name of ['.env', '.env.local', '.env.production', '.dev.vars', '.dev.vars.production']) {
      const r = spawnSync('git', ['check-ignore', '--no-index', '-q', prefix + name], { cwd });
      assert.equal(r.status, 0, prefix + name);
    }
    for (const name of ['.env.example', '.env.local.example', '.dev.vars.example', '.dev.vars.production.example']) {
      const r = spawnSync('git', ['check-ignore', '--no-index', '-q', prefix + name], { cwd });
      assert.equal(r.status, 1, prefix + name);
    }
  });
}
test('no non-template environment file is tracked', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0');
  assert.deepEqual(files.filter(f => /(^|\/)\.(env|dev\.vars)(\.|$)/.test(f) && !f.endsWith('.example')), []);
});
