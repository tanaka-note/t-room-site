/* Upload presentation receives display values; transfer, confirmation and keys stay with the caller. */
(() => {
  function create({ panel, formatBytes, escapeHtml }) {
    const node = name => panel?.querySelector(`#upload-${name}`);
    function assertReady() {
      const required = ["heading", "status", "progress", "plan-summary", "file-name", "file-progress", "speed",
        "bytes", "eta", "activity", "failure-summary", "failed-list", "safety-actions", "cancel", "dismiss",
        "conflict-summary", "conflict-list"];
      if (!panel || required.some(name => !node(name))) {
        throw new Error("アップロード画面を準備できませんでした。ページを再読み込みしてください。");
      }
    }
    assertReady();
    const text = (name, value) => { node(name).textContent = value; };
    const completed = (count, total) => text("status", `${count} / ${total}件完了`);
    const savedStatus = (count, total, conflicts) => text("status", conflicts
      ? `${count}件保存・${conflicts}件を競合候補として保留` : `${count} / ${total}件保存`);

    function renderConflicts(records) {
      const summary = node("conflict-summary"), list = node("conflict-list");
      if (!summary || !list) return;
      summary.hidden = !records.length;
      list.innerHTML = records.map(item =>
        `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.reason)}</span>${item.details.map(detail => `<span>${escapeHtml(detail)}</span>`).join("")}</li>`).join("");
    }

    function renderFailures(records) {
      const summary = node("failure-summary"), list = node("failed-list");
      if (!summary || !list) return;
      summary.hidden = !records.length;
      list.innerHTML = records.map(item =>
        `<li><strong>${escapeHtml(item.name)}</strong>${item.message ? ` — ${escapeHtml(item.message)}` : ""}</li>`).join("");
    }

    function begin(conflicts) {
      panel.hidden = false;
      panel.classList.remove("upload-complete", "upload-error");
      node("plan-summary").hidden = true;
      renderConflicts(conflicts);
      renderFailures([]);
      node("safety-actions").hidden = true;
      node("dismiss").hidden = true;
    }

    function planSummary(newFolders, files, reusedFolders, conflicts, emptyFiles = 0) {
      const added = `${Number(newFolders || 0)}フォルダ・${Number(files || 0)}ファイルを追加`;
      const existing = `${Number(reusedFolders || 0)}フォルダを再利用・${Number(conflicts || 0)}ファイルを競合候補として保留`;
      const excluded = Number(emptyFiles || 0) ? `・${Number(emptyFiles)}件は空ファイル` : "";
      text("plan-summary", `差分確認：${added}／${existing}${excluded}`);
      node("plan-summary").hidden = false;
    }

    return Object.freeze({
      assertReady, renderConflicts, renderFailures, planSummary, completed,
      beginFolder(count, names) {
        begin([]);
        text("heading", "アップロード内容を確認中");
        text("status", `0 / ${count}フォルダ確認`);
        text("file-name", names);
        text("file-progress", "準備中…");
        node("progress").style.width = "0%";
      },
      folderInspection(count, total) {
        text("status", `${count} / ${total}フォルダ確認`);
        text("file-progress", `${Math.round(count / total * 100)}%`);
      },
      folderChecked(newFolders, files, reusedFolders, conflicts, emptyFiles) {
        text("heading", "差分確認完了");
        text("status", `${newFolders}フォルダ・${files}ファイルを追加`);
        text("file-progress", `${reusedFolders}フォルダを再利用・${conflicts}ファイルを競合候補として保留${emptyFiles ? `・${emptyFiles}件は空ファイル` : ""}`);
        node("progress").style.width = "100%";
      },
      creatingFolders() { text("heading", "新しいフォルダを作成中"); },
      folderCreated(count, total) { text("status", `${count} / ${total}フォルダ作成`); },
      folderComplete() {
        panel.classList.add("upload-complete");
        text("heading", "フォルダ作成完了");
        text("file-progress", "保存完了");
      },
      folderFailure() {
        panel.classList.add("upload-error");
        text("heading", "フォルダの準備に失敗しました");
        text("file-progress", "開始できませんでした");
      },
      beginFiles(count, bytes, checkExisting, conflicts) {
        begin(conflicts);
        text("heading", checkExisting ? "アップロード内容を確認中" : "アップロード中");
        completed(0, count);
        node("progress").style.width = "0%";
        text("speed", "");
        text("bytes", `0 B / ${formatBytes(bytes)}`);
        text("eta", "残り時間：計算中");
        text("activity", "送信準備中");
        node("activity").classList.remove("waiting");
        node("cancel").hidden = false;
        node("cancel").disabled = false;
      },
      checkingConflicts() {
        text("heading", "競合候補を確認中");
        text("file-progress", "差分を確認しています");
      },
      checkingStoredFiles() { text("activity", "保存済みデータの競合候補を確認中"); },
      preparedFiles(count, bytes) {
        text("heading", count ? "アップロード中" : "差分確認完了");
        completed(0, count);
        text("bytes", `0 B / ${formatBytes(bytes)}`);
        text("activity", count ? "送信準備中" : "競合候補は保留しました");
      },
      stopped(count, total) {
        text("heading", "アップロードを停止しました");
        completed(count, total);
        text("file-progress", "未完了分は保存されていません");
      },
      retrying() { text("heading", "エラー分を再試行中"); },
      filesFailed(count, total, conflicts, unavailable, confirmation) {
        panel.classList.add("upload-error");
        text("heading", confirmation ? "アップロードの確認が必要です" : "一部のアップロードに失敗しました");
        savedStatus(count, total, conflicts);
        text("file-progress", `${unavailable}件を保存できませんでした`);
      },
      filesExcluded(count, total, conflicts, excluded) {
        panel.classList.add("upload-complete");
        text("heading", count ? "アップロード完了（対象外あり）" : "アップロード対象を確認してください");
        savedStatus(count, total, conflicts);
        text("file-progress", `${excluded}件は対象外`);
      },
      conflictsComplete(count, conflicts) {
        panel.classList.add("upload-complete");
        text("heading", "差分アップロード完了");
        text("status", `${count}件保存・${conflicts}件を競合候補として保留`);
        text("file-progress", count ? "競合しないデータだけ保存しました" : "競合候補のため保存を保留しました");
      },
      filesComplete() {
        panel.classList.add("upload-complete");
        text("heading", "アップロード完了");
        text("file-progress", "Cloudflareへの保存確認済み");
      },
      hide() { panel.hidden = true; },
      thumbnailWarnings(count, changeHeading) {
        panel.hidden = false;
        if (changeHeading) text("heading", "動画の保存完了（サムネイル未生成あり）");
        node("file-progress").textContent += ` ${count}件のサムネイルを作成できませんでした。再生時の作成、またはアカウントの全動画点検で再確認できます。`;
      },
      startFailure(message, checkExisting) {
        panel.classList.add("upload-error");
        text("heading", checkExisting ? "差分確認に失敗しました" : "アップロードを開始できませんでした");
        text("status", "データは追加していません");
        text("file-progress", message);
      },
      finishFiles() {
        node("cancel").hidden = true;
        node("cancel").disabled = false;
      },
      progress(view) {
        node("progress").style.width = view.width;
        text("file-progress", view.percent);
        text("speed", view.speed);
        text("bytes", view.bytes);
        text("eta", view.eta);
        text("activity", view.activity);
        node("activity").classList.toggle("waiting", view.waiting);
        text("file-name", view.fileName);
      },
      stopping() {
        node("cancel").disabled = true;
        text("file-progress", "停止処理中…");
      },
      syncActions(active) { node("dismiss").hidden = active || panel.hidden; },
      dismiss() {
        node("safety-actions").hidden = true;
        renderFailures([]);
        renderConflicts([]);
        panel.classList.remove("upload-complete", "upload-error");
        panel.hidden = true;
        node("plan-summary").hidden = true;
        node("dismiss").hidden = true;
      },
      showSafety(visible) { node("safety-actions").hidden = !visible; },
      safetyCancelled(count) {
        node("safety-actions").hidden = true;
        text("heading", "確認対象のアップロードをキャンセルしました");
        text("file-progress", `${count}件は保存されていません`);
      }
    });
  }
  globalThis.TCloudUploadView = Object.freeze({ create });
})();
