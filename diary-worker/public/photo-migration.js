const coreUrl = new URL(`photo-migration-core.js${new URL(import.meta.url).search}`, import.meta.url);
const { PhotoMigration, validateManifest } = await import(coreUrl.href);

export async function mountMigration(initialSession, year = 2025) {
  if (![2024, 2025].includes(year)) throw new Error('移行対象の年が不正です。');
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL(`photo-migration.css${new URL(import.meta.url).search}`, import.meta.url).href;
  document.head.append(stylesheet);
  document.querySelector('#boot-view').hidden = true;
  document.querySelector('#login-view').hidden = true;
  const view = document.querySelector('#app-view');
  view.hidden = false;
  view.innerHTML = `<main class="migration-panel"><h1>${year}年 写真移行</h1>
    <p id="migration-account"></p><p>指定したフォルダの画像を撮影日ごとにまとめ、日付をタイトルにして保存します。元のZIPは変更しません。</p>
    <button id="migration-folder">移行フォルダを選択</button>
    <label>標準のフォルダー選択 <input id="migration-files" type="file" webkitdirectory multiple></label>
    <p id="migration-storage">選択方法に応じて、フォルダーまたはこのブラウザーに進捗を保存します。</p>
    <p id="migration-summary" role="status">manifest.json がある package フォルダを選択してください。</p>
    <label>今回の終了日 <input id="migration-through" type="date" value="${year}-12-31" min="${year}-01-01" max="${year}-12-31"></label>
    <button id="migration-test" disabled>未処理の1日分を取り込む</button><button id="migration-start" disabled>終了日まで取り込む</button>
    <button id="migration-verify" disabled>保存結果を照合</button><button id="migration-stop" disabled>中断する</button>
    <progress id="migration-progress" value="0" max="1"></progress><p id="migration-state" role="status">待機中</p>
    <pre id="migration-log" aria-label="移行ログ"></pre><a id="migration-export" download="migration-progress.json" hidden>再開用の進捗ファイルを保存</a><p><a href="/diary/">日記へ戻る</a></p></main>`;
  const element = id => document.getElementById(`migration-${id}`);
  element('account').textContent = `保存先：${initialSession.accountDisplayName || initialSession.accountName} / ${initialSession.activeHouseholdId}`;
  let directory, selectedFiles, manifest, journal, running = false, stop = false;
  let databasePromise, exportUrl;
  let degraded = false;
  let wakeLock;
  let checkpointQueue = Promise.resolve();
  const destination = { origin: location.origin, householdId: initialSession.activeHouseholdId,
    loginId: initialSession.loginId, role: initialSession.role };
  const lines = [];
  function log(message) {
    lines.push(`${new Date().toLocaleTimeString('ja-JP')} ${message}`);
    element('log').textContent = lines.slice(-100).join('\n');
    element('log').scrollTop = element('log').scrollHeight;
  }
  async function fileHandle(path, create = false) {
    const pieces = path.split('/');
    if (pieces.some(piece => !piece || piece === '.' || piece === '..')) throw new Error('ファイル指定が不正です。');
    let parent = directory;
    for (const piece of pieces.slice(0, -1)) parent = await parent.getDirectoryHandle(piece);
    return parent.getFileHandle(pieces.at(-1), { create });
  }
  async function readFile(path) {
    if (selectedFiles) {
      const file = selectedFiles.get(path);
      if (!file) throw new DOMException('ファイルが見つかりません。', 'NotFoundError');
      return file.arrayBuffer();
    }
    return (await (await fileHandle(path)).getFile()).arrayBuffer();
  }
  async function readJson(path) { return JSON.parse(new TextDecoder().decode(await readFile(path))); }
  function database() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('diary-photo-migration-progress', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('journals');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('進捗の保存先を開けません。別の移行タブを閉じてください。'));
    });
    return databasePromise;
  }
  function journalKey() { return `${manifest.id}:${JSON.stringify(destination)}`; }
  async function browserJournal(value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('journals', value === undefined ? 'readonly' : 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('journals');
      const request = value === undefined ? store.get(journalKey()) : store.put(value, journalKey());
      transaction.oncomplete = () => resolve(value === undefined ? request.result || null : value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('進捗を保存できませんでした。'));
    });
  }
  function updateExport() {
    if (!journal) return;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(new Blob([JSON.stringify(journal, null, 2)], { type: 'application/json' }));
    element('export').href = exportUrl;
    element('export').hidden = false;
  }
  async function loadJournal() {
    let fileJournal;
    try { fileJournal = await readJson('migration-progress.json'); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    const stored = await browserJournal();
    for (const value of [fileJournal, stored].filter(Boolean)) new PhotoMigration({ manifest, journal: value, destination, api, readFile, saveJournal });
    journal = !stored || (fileJournal?.checkpoint || 0) > (stored?.checkpoint || 0) ? fileJournal || null : stored;
    updateExport();
  }
  async function saveJournal(value) {
    checkpointQueue = checkpointQueue.then(async () => {
      value.checkpoint = Math.max(value.checkpoint || 0, journal?.checkpoint || 0) + 1;
      if (directory) {
        const handle = await fileHandle('migration-progress.json', true);
        const stream = await handle.createWritable();
        try { await stream.write(JSON.stringify(value, null, 2)); await stream.close(); }
        catch (error) { await stream.abort().catch(() => {}); throw error; }
      }
      await browserJournal(value);
      journal = value;
      updateExport();
    });
    return checkpointQueue;
  }
  function refreshProgress() {
    const done = Object.values(journal?.days || {}).filter(day => day.status === 'complete').length;
    element('progress').max = manifest?.days.length || 1;
    element('progress').value = done;
    return done;
  }
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'X-Diary-Request': '1' };
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const request = { method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) };
    // PUT uses optimistic revision and is reconciled by the engine on resume, never blindly retried.
    const attempts = method === 'PUT' ? 1 : 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await fetch(`/diary/api${path}`, { ...request, signal: AbortSignal.timeout(body instanceof FormData ? 900000 : 60000) });
      } catch (error) {
        degraded = true;
        if (attempt + 1 === attempts) throw new Error('通信が中断しました。保存結果を照合してから再開できます。');
        await new Promise(resolve => setTimeout(resolve, [1000, 3000, 7000][attempt]));
        continue;
      }
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        degraded = true;
        const retryAfter = response.headers.get('Retry-After');
        const requestedWait = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
        if (requestedWait > 30000) throw new Error('サーバーが待機を求めています。時間を置いて再開してください。');
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, Math.max([1000, 3000, 7000][attempt], requestedWait)));
        continue;
      }
      const value = await response.json();
      if (!response.ok) {
        const error = new Error(`${response.status}: ${value.error || '保存できませんでした。'}`);
        error.status = response.status;
        throw error;
      }
      return value;
    }
  }
  function setRunning(value) {
    running = value;
    view.dataset.troomUpdateBlock = value ? 'true' : 'false';
    for (const name of ['folder', 'files', 'test', 'start', 'verify', 'through']) element(name).disabled = value || (!manifest && !['folder', 'files'].includes(name));
    element('stop').disabled = !value;
    if (!value) document.dispatchEvent(new Event('troom:auto-update-ready'));
  }
  document.addEventListener('troom:before-auto-update', event => { if (running) event.preventDefault(); });
  window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
  element('folder').addEventListener('click', async () => {
    try {
      if (!window.showDirectoryPicker) throw new Error('PC版ChromeまたはEdgeで開いてください。');
      directory = await window.showDirectoryPicker({ mode: 'readwrite', id: `diary-photo-migration-${year}` });
      selectedFiles = null;
      await prepareSelection();
    } catch (error) { manifest = null; element('state').textContent = error.message; setRunning(false); }
  });
  async function prepareSelection() {
    manifest = validateManifest(await readJson('manifest.json'), year);
    await loadJournal();
    new PhotoMigration({ manifest, journal, destination, api, readFile, saveJournal });
    element('storage').textContent = directory ? '進捗をこのフォルダーとブラウザーに保存します。' : '進捗はこのブラウザーに保存します。再開時は同じChromeプロファイルで同じフォルダーを選択してください。写真本体はブラウザーへ永続保存しません。';
    element('summary').textContent = `${manifest.days.length}日分 / ${manifest.days.reduce((n, day) => n + day.photos.length, 0)}枚。完了済み ${refreshProgress()}日。`;
    element('state').textContent = '準備完了';
    setRunning(false);
  }
  element('files').addEventListener('change', async event => {
    try {
      const files = [...event.target.files];
      if (!files.length) return;
      selectedFiles = new Map();
      const root = files[0].webkitRelativePath.split('/')[0];
      for (const file of files) {
        const path = file.webkitRelativePath;
        if (!path.startsWith(`${root}/`) || path.split('/').some(piece => !piece || piece === '.' || piece === '..')) throw new Error('フォルダーの指定が不正です。');
        const relative = path.slice(root.length + 1);
        if (selectedFiles.has(relative)) throw new Error('同じ名前のファイルが重複しています。');
        selectedFiles.set(relative, file);
      }
      directory = null;
      await prepareSelection();
    } catch (error) { manifest = null; element('state').textContent = error.message; setRunning(false); }
  });
  async function run(options) {
    stop = false;
    degraded = false;
    setRunning(true);
    element('state').textContent = options.verifyOnly ? '照合中' : '取り込み中';
    try {
      // Keep the original lock name so old and new tabs, across both years, exclude each other.
      await navigator.locks.request('diary-photo-migration-2025', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('別のタブで移行中です。');
        // Reload the durable journal after acquiring the lock, including when another tab finished.
        await loadJournal();
        checkpointQueue = Promise.resolve();
        try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
        const engine = new PhotoMigration({ manifest, journal, destination, api, readFile, saveJournal,
          canParallel: () => !degraded && !navigator.connection?.saveData && !/(^|-)2g$/.test(navigator.connection?.effectiveType || ''),
          shouldStop: () => stop, onProgress: progress => {
            element('state').textContent = `${progress.date} ${progress.stage === 'uploading' ? `${progress.uploaded}/${progress.photos}枚` : progress.stage === 'verified' ? '照合済み' : '保存完了'} / 全体 ${refreshProgress()}/${manifest.days.length}日`;
            if (progress.stage !== 'uploading' || progress.uploaded % 10 === 0) log(element('state').textContent);
          } });
        await engine.run({ ...options, through: element('through').value });
      });
      element('state').textContent = stop ? '中断しました。保存済みの続きから再開できます。' : `処理完了：${refreshProgress()}/${manifest.days.length}日を保存済み`;
      log(element('state').textContent);
    } catch (error) { element('state').textContent = `停止：${error.message}`; log(element('state').textContent); }
    finally { await wakeLock?.release().catch(() => {}); setRunning(false); }
  }
  element('test').addEventListener('click', () => void run({ maxDays: 1 }));
  element('start').addEventListener('click', () => void run({}));
  element('verify').addEventListener('click', () => void run({ verifyOnly: true }));
  element('stop').addEventListener('click', () => { stop = true; element('state').textContent = '送信中の画像を保存してから中断します。'; });
}
