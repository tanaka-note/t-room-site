const coreUrl = new URL(`photo-migration-core.js${new URL(import.meta.url).search}`, import.meta.url);
const { PhotoMigration, validateManifest } = await import(coreUrl.href);

export async function mountMigration(initialSession) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL(`photo-migration.css${new URL(import.meta.url).search}`, import.meta.url).href;
  document.head.append(stylesheet);
  document.querySelector('#boot-view').hidden = true;
  document.querySelector('#login-view').hidden = true;
  const view = document.querySelector('#app-view');
  view.hidden = false;
  view.innerHTML = `<main class="migration-panel"><h1>2025年 写真移行</h1>
    <p id="migration-account"></p><p>指定したフォルダの画像を撮影日ごとにまとめ、日付をタイトルにして保存します。元のZIPは変更しません。</p>
    <button id="migration-folder">移行フォルダを選択</button>
    <p id="migration-summary" role="status">manifest.json がある package フォルダを選択してください。</p>
    <label>今回の終了日 <input id="migration-through" type="date" value="2025-12-31" min="2025-01-01" max="2025-12-31"></label>
    <button id="migration-test" disabled>未処理の1日分を取り込む</button><button id="migration-start" disabled>終了日まで取り込む</button>
    <button id="migration-verify" disabled>保存結果を照合</button><button id="migration-stop" disabled>中断する</button>
    <progress id="migration-progress" value="0" max="1"></progress><p id="migration-state" role="status">待機中</p>
    <pre id="migration-log" aria-label="移行ログ"></pre><a href="/diary/">日記へ戻る</a></main>`;
  const element = id => document.getElementById(`migration-${id}`);
  element('account').textContent = `保存先：${initialSession.accountDisplayName || initialSession.accountName} / ${initialSession.activeHouseholdId}`;
  let directory, manifest, journal, running = false, stop = false;
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
  async function readFile(path) { return (await (await fileHandle(path)).getFile()).arrayBuffer(); }
  async function readJson(path) { return JSON.parse(new TextDecoder().decode(await readFile(path))); }
  async function saveJournal(value) {
    checkpointQueue = checkpointQueue.then(async () => {
      const handle = await fileHandle('migration-progress.json', true);
      const stream = await handle.createWritable();
      try { await stream.write(JSON.stringify(value, null, 2)); await stream.close(); }
      catch (error) { await stream.abort().catch(() => {}); throw error; }
      journal = value;
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
        if (attempt + 1 === attempts) throw new Error('通信が中断しました。保存結果を照合してから再開できます。');
        await new Promise(resolve => setTimeout(resolve, [1000, 3000, 7000][attempt]));
        continue;
      }
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
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
    for (const name of ['folder', 'test', 'start', 'verify', 'through']) element(name).disabled = value || (!manifest && name !== 'folder');
    element('stop').disabled = !value;
    if (!value) document.dispatchEvent(new Event('troom:auto-update-ready'));
  }
  document.addEventListener('troom:before-auto-update', event => { if (running) event.preventDefault(); });
  window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
  element('folder').addEventListener('click', async () => {
    try {
      if (!window.showDirectoryPicker) throw new Error('PC版ChromeまたはEdgeで開いてください。');
      directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'diary-photo-migration-2025' });
      manifest = validateManifest(await readJson('manifest.json'));
      try { journal = await readJson('migration-progress.json'); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; journal = null; }
      // No writes until a migration/verification button is explicitly selected.
      new PhotoMigration({ manifest, journal, destination, api, readFile, saveJournal });
      element('summary').textContent = `${manifest.days.length}日分 / ${manifest.days.reduce((n, day) => n + day.photos.length, 0)}枚。完了済み ${refreshProgress()}日。`;
      element('state').textContent = '準備完了';
      setRunning(false);
    } catch (error) { manifest = null; element('state').textContent = error.message; setRunning(false); }
  });
  async function run(options) {
    stop = false;
    setRunning(true);
    element('state').textContent = options.verifyOnly ? '照合中' : '取り込み中';
    try {
      await navigator.locks.request('diary-photo-migration-2025', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('別のタブで移行中です。');
        // Reload the durable journal after acquiring the lock, including when another tab finished.
        try { journal = await readJson('migration-progress.json'); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; journal = null; }
        checkpointQueue = Promise.resolve();
        try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
        const engine = new PhotoMigration({ manifest, journal, destination, api, readFile, saveJournal,
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
  element('stop').addEventListener('click', () => { stop = true; element('state').textContent = '現在の画像の保存後に中断します。'; });
}
