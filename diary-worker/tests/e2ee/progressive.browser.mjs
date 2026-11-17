// Exercise the real public login/bootstrap with delayed ciphertext and a
// deliberately blocked old document. No production data or WebAuthn is used.
process.argv.push('--progressive');
await import('./unified-passkey.browser.mjs');
