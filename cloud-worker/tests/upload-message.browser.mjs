import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 740 } : { width: 1280, height: 900 }, hasTouch: mobile });
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/cloud/api/**', route => {
      requests.push(route.request().method());
      return route.fulfill({ json: { fileIds: [], folderIds: [] } });
    });
    // Keep the real upload orchestration, DOM and close/stop handlers; replace storage and transfer I/O.
    await page.route('**/cloud/cloud.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + `
        globalThis.__uploadTest = { uploadFiles, uploadSelectedFolder, dismissUploadMessage,
          setup(mode) {
            state.session.canUpload = true; state.crypto.fileEncryptionReady = true;
            syncAvailableActions = () => {}; syncTransferWakeLock = async () => {};
            loadItems = async () => {}; loadUsage = async () => {}; invalidateStoredConflicts = () => {};
            getUploadFileLimit = () => 1; getUploadConnectionLimit = () => 1; createUploadLimiter = () => ({});
            createUploadTracker = () => ({ stop() {}, finish() {}, defer() {} });
            this.saved = 0; this.attempts = 0;
            uploadOne = async (...args) => {
              this.attempts++;
              if (mode === 'failure') throw new Error('fixture upload failure');
              if (mode === 'safety') throw safetyConfirmationError('fixture confirmation required');
              if (mode === 'cancel') { state.uploadAbort.abort(); throw new DOMException('fixture cancelled', 'AbortError'); }
              if (mode === 'active') return await new Promise((resolve, reject) => args[5].addEventListener('abort', () => reject(new DOMException('fixture cancelled', 'AbortError')), { once: true }));
              this.saved++; return { thumbnailPending: mode === 'warning' };
            };
            state.folderId = 8; state.crypto.folderKeys.set(8, __thumb.key); state.crypto.publicKey = {};
            state.folderUploadSelection = { directories: ['empty'], roots: ['empty'], files: [], looseFiles: [] };
            waitForInterfacePaint = async () => {};
            planFolderUpload = async () => {
              if (mode === 'folder-failure') throw new Error('fixture folder preparation failure');
              return { pendingFiles: [], duplicateSkipped: [], newFolderCount: 1, reusedFolderCount: 0,
                foldersByPath: new Map([['empty', { existing: false, name: 'empty', parentPath: '' }]]) };
            };
            createEncryptedFolder = async () => { this.saved++; return { id: 9, key: __thumb.key }; };
          }
        };
      ` });
    });
    await preparePage(page, fixture.origin, 1);
    const click = async selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    for (const mode of ['success', 'warning', 'cancel', 'failure', 'safety', 'conflict', 'empty', 'folder-only', 'folder-failure']) {
      await page.evaluate(async mode => {
        __uploadTest.dismissUploadMessage(); __uploadTest.setup(mode);
        if (mode.startsWith('folder-')) {
          await __uploadTest.uploadSelectedFolder({ preventDefault() {}, currentTarget: { querySelector: () => document.createElement('button') } });
        } else {
          const files = [new File(mode === 'empty' ? [] : ['fixture'], 'fixture.txt')];
          await __uploadTest.uploadFiles(files, null, { skipExisting: false,
            ...(mode === 'conflict' ? { precheckedSkipped: [{ displayName: 'existing fixture', reason: 'fixture conflict' }] } : {}) });
        }
      }, mode);
      assert.equal(await page.evaluate(() => __test.state.uploading), false, mode);
      assert.equal(await page.locator('#upload-cancel').isVisible(), false, mode);
      if (mode === 'success') {
        assert.equal(await page.locator('#upload-panel').isVisible(), false, 'ordinary success keeps automatic dismissal');
        continue;
      }
      assert.equal(await page.locator('#upload-panel').isVisible(), true, mode);
      assert.equal(await page.locator('#upload-dismiss').isVisible(), true, mode + ' must be dismissible');
      const before = await page.evaluate(() => ({ saved: __uploadTest.saved, attempts: __uploadTest.attempts }));
      const requestCount = requests.length;
      await click('#upload-dismiss');
      assert.equal(await page.locator('#upload-panel').isVisible(), false, mode);
      assert.deepEqual(await page.evaluate(() => ({ saved: __uploadTest.saved, attempts: __uploadTest.attempts })), before, 'closing changes no stored files and executes no upload');
      assert.equal(await page.evaluate(() => __test.state.pendingSafetyUpload), null, 'closing does not execute pending safety confirmation');
      assert.equal(requests.length, requestCount, 'closing makes no API request');
    }
    await page.evaluate(() => {
      __uploadTest.setup('active');
      globalThis.__pendingUploadTest = __uploadTest.uploadFiles([new File(['fixture'], 'fixture.txt')], null, { skipExisting: false });
    });
    await page.waitForFunction(() => __test.state.uploading && __uploadTest.attempts === 1);
    await page.evaluate(() => __uploadTest.dismissUploadMessage());
    assert.equal(await page.locator('#upload-panel').isVisible(), true, 'active upload cannot be dismissed');
    assert.equal(await page.locator('#upload-dismiss').isVisible(), false);
    assert.equal(await page.locator('#upload-cancel').isVisible(), true);
    assert.equal(await page.evaluate(() => __test.state.uploadAbort.signal.aborted), false, 'closing never means stopping');
    await click('#upload-cancel');
    await page.evaluate(() => __pendingUploadTest);
    assert.equal(await page.locator('#upload-dismiss').isVisible(), true, 'stop completion permits dismissal');
    await click('#upload-dismiss');
    assert.equal(await page.locator('#upload-panel').isVisible(), false);
    assert.equal(requests.some(method => method !== 'GET'), false, 'fixture never writes to an API');
    assert.deepEqual(errors, []);
    console.log('PASS upload notices close after warning/stop/failure/confirmation/conflict/empty/folder-only; ordinary success and active transfer protection preserved', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
