# ClamAV定義の自動更新・監視

## 処理と安全条件

GitHub Actions `ClamAV daily definitions` を毎日04:37 JSTに実行する（scheduleは遅延し得る）。本番applicationのdigestを取得し、同じコードを継承する候補imageの定義だけをfreshclamで取得し直す。日々の定義layerを積み重ねないよう、通常のコード公開時のimageをbaseとして保持する。Workerコード・認証・ネットワーク制限・資源上限・保存期限・scan設定は変更しない。

main/daily/bytecodeの欠落・署名異常・内部生成日時異常を拒否する。dailyの生成後5日以上の候補も公開しない。Docker build cacheは実行IDで無効化する。ファイルmtimeを鮮度として使わず、7日という有効期間も延長しない。候補内でネットワークを切り、実ClamAV/YARAの正常fixtureとClamAV EICAR拒否を確認する。検証失敗・build失敗では既存imageを変更しない。

検証後にregistryへpushし、digestを確定する。待機・取得処理・解析中のjobがある場合はrolloutを延期する。同時更新を45分leaseで防ぎ、反映直前にもlease・本番imageを確認する。通常コード公開と並行させない。現行900秒のrollout grace、SIGTERM drain、deadlineを維持する。ジョブ確認後に来る新規処理は既存drain/retryが扱うため、更新中に一時的な待機や再試行が発生する可能性は残る。

imageのみのrolling rolloutがcompletedとなり、本番applicationのdigestが一致し、active rolloutがなくなった後で成功記録を確定する。API受付やWorker deploy成功だけでは完了扱いしない。途中のAPI失敗・timeoutで反映状態が不明なら成功記録を更新せず、次の監視で不一致を警告する。自動的に未検証imageへ戻さない。

## 初回設定

1. Securityの追加migration `0014_clamav_definition_updates.sql` とWorkerを先に公開する。
2. 対象Cloudflare accountだけを許可する専用API tokenを作成する。必要なaccount権限は Containers Edit と D1 Edit（API表記ではWrite）。registry一時credential、application/rollout、Security D1更新、Downloader D1のジョブ件数確認に使用する。Workers Scripts・DNS・ユーザー認証鍵の権限は不要。API tokenをチャットやソースへ貼らない。
3. GitHub repository Settings → Secrets and variables → Actions に `CLAMAV_CLOUDFLARE_API_TOKEN` を登録する。個人のWrangler OAuthやGit credentialを転用しない。ActionsとIssuesを有効にする。
4. `ClamAV daily definitions` をworkflow_dispatchで1回実行する。成功後に独立monitorも実行し、Securityの生成日時・期限・更新結果・監視日時を確認する。GitHubからの初回実行まで「自動更新未設定」を残す。
5. 管理者 `tanaka-note` はGitHubの通知設定で割り当てIssueのOn GitHub / Emailを有効にする。メール自体はGitHub登録メールを利用し、メール送信サービスの追加契約は不要。

定義の更新・GitHub通知用の権限に限る。GitHubの組み込みGITHUB_TOKENにはworkflowごとにcontents:read、通知jobだけissues:writeを指定する。registry passwordは一時Docker設定にだけ置き、終了時に削除する。ログにはURL・ファイル内容・token・サブプロセスの生エラーを出さない。

## 監視と通知

Security Workerが毎時17分にD1記録だけを監視する。Containerを起動しない。管理者dashboardに生成日時、有効期限、最終署名検証、最終更新試行、更新結果、監視日時を表示する。未取得・migration未適用・本番image不一致を正常扱いしない。

別workflow `ClamAV independent monitor` が6時間ごと（UTC 00/06/12/18:23）に本番imageとの一致とSecurityのheartbeatを確認する。更新job終了後にも同じ監視を実行する。次の場合に管理者割り当ての単一Issueを作成・更新する。

- 生成から5日経過（7日超では既存Container側が取得停止）
- 連続2回以上の更新失敗、更新処理のlease切れ
- 更新実行を36時間確認できない
- Security監視を3時間確認できない
- 状態取得不能、認証設定不足、本番imageとの不一致

状態が同じ間はIssue/commentを追加しない。状態変化時にcomment、全条件復旧時に復旧commentとcloseを行う。通知jobを直列化して重複を抑制する。Securityの状態変化履歴は180日保持する。既存認証・利用履歴は変更しない。

監視workflowの成功は通知処理が成功したという意味であり、定義の正常性ではない。異常状態はIssue・Security表示に残す。同じ異常を監視のたびにActions失敗メールとして重送しない。更新job自体の失敗メールも不要な場合はGitHubのActions通知設定で調整する。

更新workflowだけの停止は独立workflowが検知し、Security cronの停止はGitHub側が検知する。GitHub Actions全体が無効・予算停止・サービス障害になった場合もSecurity内では更新停止を検知するが、GitHub経由の外部通知は送れない。完全に独立した外部通知を必要とする場合は別通知経路の設定が必要。全基盤停止時の配信保証はしない。GitHubの通知メールが実際に受信されたかは管理者側で確認する。

## 費用と日常運用

定義更新は利用者の取得ごとには実行しない。1日1回のDocker build/小容量検査はGitHub runnerで行う。監視は軽量なAPI/D1処理だけで、Cloudflare Containerを常時起動・監視起動しない。GitHub標準通知に連絡先ごとの追加料金はないが、private repositoryのActions実行時間には契約枠・超過料金があり、他workflowと共有する。毎日定義を含むimage layerをpushするためregistry容量も増える。既存の本番・base・previous imageを不用意に削除しない。費用ゼロや固定請求上限とは扱わない。

通常のContainerコード公開でも手動buildの `CLAMAV_DEFINITION_REFRESH` を当日の固有値へ進める。通常公開後は自動更新を手動実行し、新しいコードbaseの検証済み記録へ更新する。Workerだけの公開では `--containers-rollout=none` を用い、定義imageを古いbuildへ戻さない。

参考: [Cloudflare rolloutの完了・drain](https://developers.cloudflare.com/containers/configuration/rollouts/)、[API token権限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[GitHub通知](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)、[Actions課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

## 切り戻し

自動更新workflowを停止してから、Security D1の`previous_image`と本番application/active rolloutを読み取り確認する。以前のimageでも署名・内部日時・現時点の7日制限・実エンジン検証を通ることが必要。期限切れなら戻さず、新しい候補を作成する。実行中rolloutを上書きせず、その状態を解決してから行う。

通常の手順と同じジョブ確認・grace/drainを使い、Container application APIのimageのみrolling rolloutで有効な旧digestへ戻す。completedとdigestを再確認する。D1の成功記録を推測で書き換えない（不一致警告を保持）；その後daily workflowを再実行して検証済み状態へ復旧する。Worker rollbackはContainer imageを戻さない。Security Workerだけ戻す場合も0014の追加tableを削除せず保持する。

## 検証

`node --test downloader-worker/test/definition-updates.test.js` はSQLite実行とAPI/Docker mockで正常更新、署名/鮮度候補拒否、更新失敗、active job延期、lease競合、rollout完了待ち、期限前/期限切れ/監視停止、通知重複抑制・復旧を確認する。実エンジンの確認は`tools/verify-definitions.py`を候補imageにread-only mountし、`--network none --cpus 1 --memory 4g --entrypoint python -e PYTHONPATH=/app`で実行する。小容量の正常/EICAR試験であり、大容量media検査の速度・検出網羅性を検証したものではない。

## 2026-09-06 初回導入記録

- Security migration 0014適用、Worker `20a798ae-d542-4810-a641-0fd0f9064dcd`、build `security-ec7f431cfd8e`。本番HTML/JS一致と未認証dashboard 401を確認。
- Container version 8、digest `sha256:21b2fb59ef49b9d0befa36e5e03646374ff99ba758ed9ceade01128b57569e73`。rollout `863a2dbe-ced2-4cc2-abae-ebdabbc94c5a` completed・active rolloutなし。CPU 1、memory 6144 MiB、disk 12000 MB、private network、grace 900秒の維持を読み取り確認。
- 定義の内部生成日時は2026-09-06 15:26:06 JST、有効期限は2026-09-13 15:26:06 JST。Downloader Worker `bd836330-5b09-4333-b055-0628ffcc2e2e`は今回更新していない。
- 切り戻し候補はD1 previous_image（`sha256:6c3d248dae07b77ed20ed1ea3d68e5273f9ee48aacd56e539a31d5f4825707a9`）。必ず切り戻し時点の署名・鮮度を再検証する。Security旧Workerは `78f17926-81de-4971-ab2b-00358f7ea4b5`。追加tableは保持する。
- Downloader Node 63件、Security Node 99件、両サービスのChromium/Firefox表示・回帰試験がPASS。Windows Python 112件中87件PASS、外部ツール依存25件skip。定義更新・障害・監視・通知の11件はSQLite/API/Docker mock試験を含む。
- サービス横断のパスキー失効・HTTP連携E2EもPASS。初回はローカルのWrangler依存不足で開始できず、依存を補って再実行した。認証方式・鍵の運用は変更していない。
- 候補imageで実sigtool署名・内部時刻、実ClamAV正常/EICAR拒否、YARA正常性を確認。実定義を用いた時刻注入で7日超過拒否、空の定義directoryと無害な破損定義fixtureで欠落/署名不正拒否も確認。本番の大容量取得は実施していない。
- 初回候補検証のsubprocessが一度失敗した（詳細を保存していないため原因は未確定）。同じ候補の再検証は通過。rollout要求の段階指定不足も本番APIで判明し、明示的なsteps指定と回帰テストを追加後に反映完了した。候補buildは1回だけで、途中の失敗時には本番の旧imageを維持した。
- 全サイトcontractは既存calculator build不一致で失敗。Downloaderにも着手前からbuild marker不一致があり、今回はWorker/UIを変更していない。今回変更したSecurityのbuild/HTML契約とdry-runは個別にPASS。
- GitHub標準通知Issue [#1](https://github.com/tanaka-note/t-room-site/issues/1)を管理者へ割り当て、同じ未設定状態の再送でIssue/commentが増えないことを確認。通知メールの受信、実障害からの外部復旧通知は未確認（復旧・重複抑制はmockで確認）。
- 自動更新用 `CLAMAV_CLOUDFLARE_API_TOKEN` は未登録。手元の既存ログインによる初回更新だけ完了しており、自動運転完了とは扱わない。登録後daily workflowを実行する。Securityの毎時cronは登録済みだが、初回導入確認時点では本番heartbeatは未観測。未設定/未観測を正常扱いしていない。
