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
          makeTracker: createUploadTracker, formatBytes, escapeHtml,
          setup(mode) {
            state.session.canUpload = true; state.crypto.fileEncryptionReady = true;
            syncAvailableActions = () => {}; syncTransferWakeLock = async () => {};
            loadItems = async () => {}; loadUsage = async () => {}; invalidateStoredConflicts = () => {};
            getUploadFileLimit = () => 1; getUploadConnectionLimit = () => 1; createUploadLimiter = () => ({});
            createUploadTracker = () => ({ stop() {}, finish() {}, defer() {} });
            this.saved = 0; this.attempts = 0;
            uploadOne = async (...args) => {
              this.attempts++;
              if (mode === 'failure' || mode === 'escaped-failure') throw new Error('fixture upload failure');
              if (mode === 'safety' && !args[8]) throw safetyConfirmationError('fixture confirmation required');
              if (mode === 'cancel') { state.uploadAbort.abort(); throw new DOMException('fixture cancelled', 'AbortError'); }
              if (mode === 'active') return await new Promise((resolve, reject) => args[5].addEventListener('abort', () => reject(new DOMException('fixture cancelled', 'AbortError')), { once: true }));
              this.saved++; return { thumbnailPending: mode === 'warning' };
            };
            state.folderId = 8; state.crypto.folderKeys.set(8, __thumb.key); state.crypto.publicKey = {};
            state.folderUploadSelection = { directories: ['empty'], roots: ['empty'], files: [], looseFiles: [] };
            waitForInterfacePaint = async () => {};
            planFolderUpload = async (selection) => {
              if (mode === 'folder-failure') throw new Error('fixture folder preparation failure');
              return { pendingFiles: selection.files.map(item => item.file), duplicateSkipped: [], newFolderCount: 1, reusedFolderCount: 0,
                foldersByPath: new Map([['empty', { existing: false, name: 'empty', parentPath: '' }]]) };
            };
            createEncryptedFolder = async () => { this.saved++; return { id: 9, key: __thumb.key }; };
          }
        };
      ` });
    });
    await preparePage(page, fixture.origin, 1);
    const click = async selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    const headings = {
      success: 'アップロード完了', warning: '動画の保存完了（サムネイル未生成あり）',
      cancel: 'アップロードを停止しました', failure: '一部のアップロードに失敗しました',
      'escaped-failure': '一部のアップロードに失敗しました', safety: 'アップロードの確認が必要です',
      conflict: '差分アップロード完了', 'conflict-only': '差分アップロード完了',
      empty: 'アップロード対象を確認してください', 'folder-only': 'フォルダ作成完了',
      'folder-files': 'アップロード完了', 'folder-failure': 'フォルダの準備に失敗しました'
    };
    for (const mode of Object.keys(headings)) {
      await page.evaluate(async mode => {
        __uploadTest.dismissUploadMessage(); __uploadTest.setup(mode);
        if (mode.startsWith('folder-')) {
          if (mode === 'folder-files') __test.state.folderUploadSelection.files = [{ file: new File(['fixture'], 'fixture.txt'), relativePath: 'empty/fixture.txt' }];
          await __uploadTest.uploadSelectedFolder({ preventDefault() {}, currentTarget: { querySelector: () => document.createElement('button') } });
        } else {
          const files = mode === 'conflict-only' ? [] : [new File(mode === 'empty' ? [] : ['fixture'], mode === 'escaped-failure' ? '<img src=x onerror=alert(1)>.txt' : 'fixture.txt')];
          await __uploadTest.uploadFiles(files, null, { skipExisting: false,
            ...(mode.startsWith('conflict') ? { precheckedSkipped: [{ displayName: 'existing fixture', reason: 'fixture conflict' }] } : {}) });
        }
      }, mode);
      assert.equal(await page.evaluate(() => __test.state.uploading), false, mode);
      assert.equal(await page.locator('#upload-cancel').isVisible(), false, mode);
      assert.equal(await page.locator('#upload-heading').textContent(), headings[mode], mode);
      const expectedSaved = ['success', 'warning', 'conflict', 'folder-only'].includes(mode) ? 1 : mode === 'folder-files' ? 2 : 0;
      assert.equal(await page.evaluate(() => __uploadTest.saved), expectedSaved, mode + ' preserves saved count');
      if (mode === 'escaped-failure') {
        assert.equal(await page.locator('#upload-failed-list strong').textContent(), '<img src=x onerror=alert(1)>.txt');
        assert.equal(await page.locator('#upload-failed-list img').count(), 0, 'file names remain text');
      }
      if (mode === 'success' || mode === 'folder-files') {
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
    // Real confirmation controls keep ownership of pending files and transfer intents.
    for (const action of ['cancel', 'continue']) {
      await page.evaluate(async () => {
        __uploadTest.setup('safety');
        await __uploadTest.uploadFiles([new File(['fixture'], 'fixture.txt')], null, { skipExisting: false });
      });
      await click('#upload-safety-' + action);
      await page.waitForFunction(() => !__test.state.uploading && !__test.state.pendingSafetyUpload);
      assert.equal(await page.evaluate(() => __uploadTest.saved), action === 'continue' ? 1 : 0);
      assert.equal(await page.evaluate(() => __uploadTest.attempts), action === 'continue' ? 2 : 1);
      assert.equal(await page.locator('#upload-heading').textContent(), action === 'continue'
        ? 'アップロード完了' : '確認対象のアップロードをキャンセルしました');
      await page.evaluate(() => __uploadTest.dismissUploadMessage());
    }
    // Use the actual accounting-to-view adapter, including retry reset and completed count.
    await page.evaluate(() => {
      const file = { name: 'progress fixture.txt', size: 1000 };
      const tracker = __uploadTest.makeTracker([file], 1000);
      tracker.start(file); tracker.partProgress(file, 1, 1, 250, 1000);
      globalThis.__progressTest = { file, tracker };
    });
    assert.equal(await page.locator('#upload-progress').evaluate(node => node.style.width), '25%');
    assert.equal(await page.locator('#upload-file-progress').textContent(), '25.0%');
    assert.equal(await page.locator('#upload-bytes').textContent(), '250 B / 1000 B');
    assert.equal(await page.locator('#upload-file-name').textContent(), 'progress fixture.txt');
    await page.evaluate(() => __progressTest.tracker.retry(__progressTest.file, 1, 2, 4));
    assert.equal(await page.locator('#upload-progress').evaluate(node => node.style.width), '0%');
    assert.equal(await page.locator('#upload-activity').evaluate(node => node.classList.contains('waiting')), true);
    await page.evaluate(() => { __progressTest.tracker.finish(__progressTest.file, 1); __progressTest.tracker.stop(); });
    assert.equal(await page.locator('#upload-status').textContent(), '1 / 1件完了');
    assert.equal(await page.locator('#upload-progress').evaluate(node => node.style.width), '100%');
    assert.equal(await page.locator('#upload-eta').textContent(), '送信完了');
    // Another panel with the same child IDs must remain scoped to its own root.
    const scoped = await page.evaluate(() => {
      const original = document.querySelector('#upload-panel'), before = original.outerHTML;
      const panel = original.cloneNode(true); panel.removeAttribute('id'); document.body.append(panel);
      const view = TCloudUploadView.create({ panel, formatBytes: __uploadTest.formatBytes, escapeHtml: __uploadTest.escapeHtml });
      view.beginFiles(1, 1000, false, []);
      view.renderConflicts([{ name: '<img src=x>', reason: '<script>unsafe</script>', details: ['<b>path</b>'] }]);
      view.renderFailures([{ name: '<img src=x>', message: '<script>unsafe</script>' }]);
      view.syncActions(false);
      const result = { unchanged: before === original.outerHTML, markup: panel.querySelectorAll('img,script').length,
        name: panel.querySelector('#upload-conflict-list strong').textContent, dismissible: !panel.querySelector('#upload-dismiss').hidden };
      view.dismiss(); result.hidden = panel.hidden; result.unchanged &&= before === original.outerHTML; panel.remove(); return result;
    });
    assert.deepEqual(scoped, { unchanged: true, markup: 0, name: '<img src=x>', dismissible: true, hidden: true });
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
    console.log('PASS upload presentation, saved counts, safety cancel/continue, actual progress/retry, escaped names, scoped DOM and active transfer protection', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
