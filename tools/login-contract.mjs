import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This is intentionally discovered from HTML rather than a fixed service list:
// newly registered passkey login pages must adopt the same presentation contract.
export async function assertLoginContract(source, app, workspace) {
  if (!/passkey-login-button|パスキーでログイン/.test(source)) return;
  assert.match(source, /class="[^"]*\btlain-login-view\b/, `${app.id}: common login view is required`);
  assert.match(source, /class="[^"]*\btlain-login-card\b/, `${app.id}: common login card is required`);
  for (const file of ['tlain-login.css', 'tlain-login.js']) {
    assert.ok(source.includes(file + '?v='), `${app.id}: versioned ${file} is required`);
    const canonical = `tools/shared/${file}`;
    assert.ok(app.buildFiles?.includes(canonical), `${app.id}: ${canonical} must participate in its build`);
    const copy = app.assetCopies?.find(copy => copy.source === canonical);
    assert.ok(copy, `${app.id}: common login asset copy is required`);
    assert.equal(await readFile(resolve(workspace, copy.copy), 'utf8'), await readFile(resolve(workspace, canonical), 'utf8'), `${app.id}: ${file} differs from canonical presentation`);
  }
}
