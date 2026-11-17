// Exercise mobile public login/bootstrap through workerd's actual HTTP
// compression, with delayed ciphertext and a blocked old document. No
// production data, resources or WebAuthn is used.
process.argv.push('--progressive', '--mobile', '--workerd');
await import('./unified-passkey.browser.mjs');
