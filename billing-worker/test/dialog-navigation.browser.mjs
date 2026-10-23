import { runDialogs } from '../../diary-worker/tests/browser/dialog-fixture.mjs';
await import('./performance.browser.mjs');
await runDialogs('billing');
