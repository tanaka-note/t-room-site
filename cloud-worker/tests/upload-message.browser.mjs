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
          makeTracker: createUploadTracker, formatBytes, escapeHtml, openFolderUploadDialog, continuePendingSafetyUpload,
          pauseFolderPlan() {
            const original = planFolderUpload;
            planFolderUpload = async (...args) => {
              this.folderPlanEntered = true;
              await new Promise(resolve => { this.releaseFolderPlan = resolve; });
              return original(...args);
            };
          },
          failStartup(boundary) {
            if (boundary === 'paint') waitForInterfacePaint = async () => { throw new Error('fixture paint failure'); };
            else {
              const original = syncTransferWakeLock;
              let first = true;
              syncTransferWakeLock = async () => {
                if (first) { first = false; throw new Error('fixture wake lock failure'); }
                return original();
              };
            }
          },
          setup(mode) {
            state.session.canUpload = true; state.crypto.fileEncryptionReady = true;
            syncAvailableActions = () => {}; syncTransferWakeLock = async () => {};
            loadItems = async () => {}; loadUsage = async () => {}; invalidateStoredConflicts = () => {};
            getUploadFileLimit = () => 1; getUploadConnectionLimit = () => 1; createUploadLimiter = () => ({});
            createUploadTracker = () => ({ stop() {}, finish() {}, defer() {} });
            this.saved = 0; this.attempts = 0; this.folderPlanEntered = false; this.folderPreparationFails = false;
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
              if (mode === 'folder-failure' || this.folderPreparationFails) throw new Error('fixture folder preparation failure');
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
    // Do not dismiss the previous notification: starting a folder must consume the previous intent.
    for (const previous of ['failure', 'safety']) for (const outcome of ['empty', 'files', 'failure']) {
      const before = await page.evaluate(async ({ previous, outcome }) => {
        __uploadTest.dismissUploadMessage(); __uploadTest.setup(previous);
        await __uploadTest.uploadFiles([new File(['fixture'], 'previous.txt')], null, { skipExisting: false });
        const selection = __test.state.folderUploadSelection;
        if (outcome === 'files') selection.files = [{ file: new File(['fixture'], 'current.txt'), relativePath: 'empty/current.txt' }];
        __uploadTest.folderPreparationFails = outcome === 'failure';
        __uploadTest.pauseFolderPlan();
        return { attempts: __uploadTest.attempts, saved: __uploadTest.saved, pending: Boolean(__test.state.pendingSafetyUpload) };
      }, { previous, outcome });
      assert.equal(before.pending, previous === 'safety');
      assert.equal(await page.locator('#upload-failure-summary').isVisible(), true);
      await page.evaluate(() => {
        __uploadTest.openFolderUploadDialog(__test.state.folderUploadSelection);
        globalThis.__pendingFolderTest = __uploadTest.uploadSelectedFolder({ preventDefault() {}, currentTarget: document.querySelector('#folder-upload-form') });
      });
      await page.waitForFunction(() => __uploadTest.folderPlanEntered);
      assert.equal(await page.evaluate(() => __test.state.uploading), true);
      assert.equal(await page.evaluate(() => __test.state.pendingSafetyUpload), null, 'folder start clears the previous confirmation intent');
      assert.equal(await page.locator('#upload-failure-summary').isVisible(), false);
      assert.equal(await page.locator('#upload-failed-list li').count(), 0);
      assert.equal(await page.locator('#upload-safety-actions').isVisible(), false);
      await page.evaluate(() => __uploadTest.continuePendingSafetyUpload());
      assert.equal(await page.evaluate(() => __uploadTest.attempts), before.attempts, 'no old transfer runs during folder preparation');
      await page.evaluate(async () => { __uploadTest.releaseFolderPlan(); await __pendingFolderTest; });
      assert.equal(await page.evaluate(() => __test.state.uploading), false);
      assert.equal(await page.evaluate(() => __test.state.activeFolderUploadOperationId), null);
      assert.equal(await page.locator('#upload-dismiss').isVisible(), true);
      assert.equal(await page.locator('#folder-upload-form button[type="submit"]').isDisabled(), false);
      if (outcome === 'files') {
        assert.deepEqual(await page.locator('#upload-failed-list strong').allTextContents(), ['empty/current.txt'], 'the list belongs to the current folder only');
        assert.deepEqual(await page.evaluate(() => (__test.state.pendingSafetyUpload?.files || []).map(file => file.name)), previous === 'safety' ? ['current.txt'] : []);
      } else {
        assert.equal(await page.locator('#upload-heading').textContent(), outcome === 'empty' ? 'フォルダ作成完了' : 'フォルダの準備に失敗しました');
        assert.equal(await page.locator('#upload-failure-summary').isVisible(), false);
        assert.equal(await page.locator('#upload-safety-actions').isVisible(), false);
        assert.equal(await page.evaluate(() => __test.state.pendingSafetyUpload), null);
        await page.evaluate(() => __uploadTest.continuePendingSafetyUpload());
        assert.equal(await page.evaluate(() => __uploadTest.attempts), before.attempts, 'the previous file cannot be continued after folder completion/failure');
      }
      assert.equal(await page.evaluate(() => __uploadTest.saved), before.saved + (outcome === 'failure' ? 0 : 1), 'only the current folder is stored');
      await click('#upload-dismiss');
    }
    // Missing markup must reject a new operation before changing busy flags or discarding the selection.
    for (const flow of ['folder', 'files']) {
      const rejected = await page.evaluate(async flow => {
        __uploadTest.setup('success');
        const heading = document.querySelector('#upload-heading'), parent = heading.parentNode, next = heading.nextSibling;
        const selection = __test.state.folderUploadSelection;
        heading.remove();
        try {
          if (flow === 'folder') await __uploadTest.uploadSelectedFolder({ preventDefault() {}, currentTarget: document.querySelector('#folder-upload-form') });
          else await __uploadTest.uploadFiles([new File(['fixture'], 'fixture.txt')], null, { skipExisting: false });
          return { uploading: __test.state.uploading, folderActive: __test.state.activeFolderUploadOperationId,
            abort: __test.state.uploadAbort, attempts: __uploadTest.attempts, saved: __uploadTest.saved,
            selectionPreserved: selection === __test.state.folderUploadSelection, notice: document.querySelector('#notice').textContent };
        } finally { parent.insertBefore(heading, next); }
      }, flow);
      assert.deepEqual(rejected, { uploading: false, folderActive: null, abort: null, attempts: 0, saved: 0,
        selectionPreserved: true, notice: 'アップロード画面を準備できませんでした。ページを再読み込みしてください。' });
      assert.equal(await page.locator('#folder-upload-form button[type="submit"]').isDisabled(), false);
      await page.evaluate(() => __uploadTest.dismissUploadMessage());
    }
    // Exceptions in the previously unprotected startup awaits still release transfer/UI state.
    for (const [flow, boundary] of [['folder', 'wake-lock'], ['folder', 'paint'], ['files', 'wake-lock']]) {
      await page.evaluate(async ({ flow, boundary }) => {
        __uploadTest.setup('success'); __uploadTest.failStartup(boundary);
        if (flow === 'folder') await __uploadTest.uploadSelectedFolder({ preventDefault() {}, currentTarget: document.querySelector('#folder-upload-form') });
        else await __uploadTest.uploadFiles([new File(['fixture'], 'fixture.txt')], null, { skipExisting: false });
      }, { flow, boundary });
      assert.deepEqual(await page.evaluate(() => ({ uploading: __test.state.uploading, folderActive: __test.state.activeFolderUploadOperationId,
        abort: __test.state.uploadAbort, attempts: __uploadTest.attempts, saved: __uploadTest.saved })),
        { uploading: false, folderActive: null, abort: null, attempts: 0, saved: 0 });
      assert.equal(await page.locator('#upload-dismiss').isVisible(), true);
      assert.equal(await page.locator('#upload-cancel').isVisible(), false);
      assert.equal(await page.locator('#folder-upload-form button[type="submit"]').isDisabled(), false);
      await click('#upload-dismiss');
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
    console.log('PASS upload presentation, chained folder reset, missing DOM/startup cleanup, safety cancel/continue, progress/retry, escaped names, scoped DOM and active transfer protection', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
