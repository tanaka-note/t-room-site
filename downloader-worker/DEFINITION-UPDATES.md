# ClamAV定義の自動更新・監視

## 処理と安全条件

GitHub Actions `ClamAV daily definitions` を毎日04:37 JSTに実行する（scheduleは遅延し得る）。本番applicationのdigestを取得し、同じコードを継承する候補imageの定義だけをfreshclamで取得し直す。日々の定義layerを積み重ねないよう、通常のコード公開時のimageをbaseとして保持する。Workerコード・認証・ネットワーク制限・資源上限・保存期限・scan設定は変更しない。

main/daily/bytecodeの欠落・署名異常・内部生成日時異常を拒否する。dailyの生成後5日以上の候補も公開しない。Docker build cacheは実行IDで無効化する。ファイルmtimeを鮮度として使わず、7日という有効期間も延長しない。候補内でネットワークを切り、実ClamAV/YARAの正常fixtureとClamAV EICAR拒否を確認する。検証失敗・build失敗では既存imageを変更しない。

検証後にregistryへpushし、digestを確定する。待機・取得処理・解析中のjobがある場合はrolloutを延期する。同時更新を45分leaseで防ぎ、非同期build/push中を含め毎分CASで更新する。反映直前にもlease・本番image・version・設定・rollout履歴を確認する。通常コード公開と並行させない。現行900秒のrollout grace、SIGTERM drain、deadlineを維持する。ジョブ確認後に来る新規処理は既存drain/retryが扱うため、更新中に一時的な待機や再試行が発生する可能性は残る。

imageのみのrolling rolloutを実状態と照合し、本番applicationのdigestが検証済みpending targetと一致し、active rolloutがなくなった後で成功記録を確定する。取得できるrolloutはcompletedであることも確認し、reverted/replaced/未知状態では成功にしない。API受付やWorker deploy成功だけでは完了扱いしない。途中のAPI失敗・timeoutで反映状態が不明ならintentを保持し、次回も照合する。自動的に未検証imageへ戻さない。

## Rollout結果の照合と復旧

| 実状態 | 動作 |
| --- | --- |
| target digest反映済み・activeなし | 保存した署名検証結果と7日期限、最終Application再取得を確認し、所有runのCASだけで成功確定 |
| 同じtargetのpending/progressing rollout | IDを引き継ぎ、追加POSTなしで監視 |
| active IDのGETが404 | Application前後取得・全rollout一覧・個別GETを10/20秒backoffで3回照合。一時404・状態変化をstaleと即断しない |
| 同一active ID・同一Applicationが継続し、個別GETと一覧にも不存在 | `stale_rollout`。自動修復mutationを行わずIssueへ通知 |
| activeなし・旧digest/version/設定/履歴が一致・まだ未送信 | lease/target/ジョブ件数/本番状態/送信予算を再確認し、送信マーカーをD1へ保存して1回だけ作成 |
| 送信済みだが繰り返し旧digestのまま、作成記録もなし | `reconciliation_stuck`。不存在という観測だけで非実行を断定せず再POSTを保留 |
| 旧/target以外のimage、別target、versionや設定変更、別rollout | `rollout_conflict`。自動上書き・rollbackなし |
| GET等の読込エラー | `rollout_ambiguous`。intentを残し次回の照合へ |
| reverted / replaced | `rollout_reverted` / `rollout_replaced`。自動再送なし |
| 未知status | `rollout_unknown_status`。待ち続けず状態を保存して通知 |

通常のrollout待機は最大60回・30分、buildからの処理予算は38分を目安とし、Actionsの45分制限を維持する。各API読込にも独立したtimeout/retry上限があり、極端に遅いAPIやrunner強制終了ではその場の終了記録を保証できないが、先に保存したintentとleaseは残る。正常進行中のローカル待機期限はprovider failureに変換しない。`rollout_pending`を保存してleaseを解放し、次回の日次実行でbuild前に続行する。36時間を超えるpendingは監視で`reconciliation_stuck`も通知する。成功・pending処理で毎時monitor heartbeatを捏造しない。

### API契約とretryの限界

確認対象はリポジトリの`wrangler@4.128.0`、`@cloudflare/containers@0.3.7`、公式rollout文書、および**wrangler@4.128.0タグのgenerated client/model**。

- `ApplicationRollout.status`は`pending / progressing / completed / reverted / replaced`。旧処理のfailed/cancelled/rolled_backはこの契約にはないため未知状態として停止する。
- GET Application、GET rollout、GET rollout一覧を使用する。一覧のlimit省略はgenerated clientの説明で全件。古いrolloutが後からreplacedへ変わるため、baselineはstatusではなくIDで比較する。
- 作成POSTにidempotency keyやexpected-version/If-Matchによる条件付き作成の契約は確認できない。GETの整合性が何秒で確定するという保証も確認できない。**1 intentの自動送信予算は1回**。全安全条件が成立しても、既に送信した要求を再送して安全という証明にはならないため、5xx後に旧imageが見えるだけでは自動再送しない。これは二重rollout回避を優先した代替設計。
- 更新actionは`next / previous / revert`。削除APIは「使用中でないrolloutを清掃する」操作であり、不存在のactive IDの修復を保証しない。Application PATCHにもactive_rollout_idはない。**安全な公式のdangling ID修復契約は確認できず、自動修復には採用していない**。同一imageの新rollout作成が手動復旧で成功した実績だけを、自動修復の保証にしない。
- 外部のDashboard/別CLIはD1 leaseに従うとは限らず、条件付き作成APIもないため、最終GETとPOSTの間の外部deployを原子的には排除できない。通常のコード公開もこの同じworkflowを使い、Dashboardからの並行変更はしない。検出できた競合は必ず停止する。

参照: [公式rollout/drain](https://developers.cloudflare.com/containers/configuration/rollouts/)、[固定版のApplicationsService](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.128.0/packages/containers-shared/src/client/services/ApplicationsService.ts)、[statusモデル](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.128.0/packages/containers-shared/src/client/models/ApplicationRollout.ts)、[作成モデル](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.128.0/packages/containers-shared/src/client/models/CreateApplicationRolloutRequest.ts)、[変更モデル](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.128.0/packages/containers-shared/src/client/models/ModifyApplicationRequestBody.ts)。

GETと明示的なD1 SELECTだけを最大4回、指数backoff+jitter（基準1/2/4秒）、90秒のretry予算で再試行する。429/5xx/transport/読込異常が対象。Retry-Afterの秒数またはHTTP-dateを尊重し、予算を超えれば早期再送せずそのrunの照合を保留する。D1 UPDATE、registry credential要求、rollout POSTにgeneric retryを適用しない。structured errorはHTTP status・数値エラーcode・Retry-After・検証済みcf-ray・method・固定pathカテゴリ・エラー種別だけを保持し、HTTPが非JSONでもstatusを失わない。

### Leaseと安全な再開

GHAのconcurrency group/cancel-in-progress=falseを維持する。run IDにはUUIDを付ける。leaseは毎分、および各重い工程・rollout操作前に`run_id=? AND lease_until>now`のCASで更新する。同期spawnを非同期spawnへ変更し、Dockerが長時間動いてもheartbeatを実行する。renew失敗/所有権喪失はstickyに扱い、新規mutationと成功書込を止め、実行中Dockerも中断する。更新・成功確定のD1書込は所有runと未失効lease、および必要時pending targetを条件にする。所有権喪失後のrunが他runのleaseを消すこともない。

日次実行はpendingがあれば候補を作り直さず照合だけを続ける。手動input `reconcile_only=true` は新しい候補のbuildをしない。ただし**未送信の検証済みprepared intentがある場合は、安全条件確認後に初回rolloutを開始し得る**ため、常にread-onlyとは扱わない。intentも異常もなければ読込だけで終了し、成功日時やupdater/monitor heartbeatを進めない。`release_code / analysis_only`との併用は拒否する。

### 人間の対応が必要な場合

`stale_rollout / reconciliation_stuck / rollout_conflict / rollout_unknown_status / rollout_reverted / rollout_replaced / candidate_expired`は既存の単一GitHub Issueに通知する。同じ状態でIssue/commentを増やさない。5日警告、7日超過での取得停止、digest不一致、毎時heartbeat停止も同時に評価し、pendingを理由に隠さない。

まずD1 pending/成功記録、Applicationのimage/version/active ID、rollout一覧/個別GET、Actions runとcf-rayを読み取り照合する。照合だけでtarget反映が確認できれば次回runが成功へ復旧する。Cloudflare側の不整合が継続する場合は管理者がproviderに確認し、無関係deployとjobがないことを確認して承認された正規手順で復旧する。Application削除・非公開PATCH・無条件rollbackは行わない。

送信済みintentのカウンターやpendingを消して「再試行可能」に見せてはいけない。未反映が確認できない限り再POSTしない。別の正規deployへ移行する場合は、旧要求が進行中でないことをprovider側でも確認し、旧intentの必要なdigest/ID/状態をIssueへ記録してから、管理者が所有run不在条件付きで整理する。自動処理はこの判断を推測しない。candidateが期限切れでも未確定の旧要求は無視できない。旧intent解決後に新しい検証済み候補を作る。

## 初回設定

1. Securityの追加migration `0014_clamav_definition_updates.sql` とWorkerを先に公開する。
2. 対象Cloudflare accountだけを許可する専用API tokenを作成する。必要なaccount権限は Containers Edit と D1 Edit（API表記ではWrite）。registry一時credential、application/rollout、Security D1更新、Downloader D1のジョブ件数確認に使用する。Workers Scripts・DNS・ユーザー認証鍵の権限は不要。API tokenをチャットやソースへ貼らない。
3. GitHub repository Settings → Secrets and variables → Actions に `CLAMAV_CLOUDFLARE_API_TOKEN` を登録する。個人のWrangler OAuthやGit credentialを転用しない。ActionsとIssuesを有効にする。
4. `ClamAV daily definitions` をworkflow_dispatchで1回実行する。成功後に独立monitorも実行し、Securityの生成日時・期限・更新結果・監視日時を確認する。GitHubからの初回実行まで「自動更新未設定」を残す。
5. 管理者 `tanaka-note` はGitHubの通知設定で割り当てIssueのOn GitHub / Emailを有効にする。メール自体はGitHub登録メールを利用し、メール送信サービスの追加契約は不要。

定義の更新・GitHub通知用の権限に限る。GitHubの組み込みGITHUB_TOKENにはworkflowごとにcontents:read、通知jobだけissues:writeを指定する。registry passwordは一時Docker設定にだけ置き、終了時に削除する。ログにはURL・ファイル内容・token・サブプロセスの生エラーを出さない。

## 監視と通知

Security Workerが毎時17分にD1記録だけを監視する。Containerを起動しない。管理者dashboardに生成日時、有効期限、最終署名検証、最終更新試行、更新結果、監視日時を表示する。未取得・migration未適用・本番image不一致を正常扱いしない。

毎時監視の判定は`hourly_monitor_checked_at`専用とし、未記録・未来の異常値・3時間超過を`monitor_stopped`とする。日次cleanupや定義更新成功でこの値を補完しない。`hourly_monitor_started_at`は毎時分岐の起動記録、完了値は状態履歴と同じD1 batchが成功した時だけ更新する。既存`monitor_checked_at`は日次を含む定義状態確認の履歴として保持し、画面では毎時の起動・完了と区別する。GitHub監視も同じ判定関数を使う。

追加migration `0015_hourly_definition_heartbeat.sql`をSecurity Worker公開前に適用する。既存値から毎時実行を推測して埋めない。consoleには固定の`clamav_monitor`、source、stage（started/completed、失敗時start_record/read/complete_record）だけを出し、生の例外・SQL値・秘密情報は記録しない。Workers Logsの保存は今回有効化していないため、consoleの過去ログを取得できるとは限らない。自然発火後はCron Events（GraphQL `workersInvocationsScheduled`）と専用D1列を読み取る。開始のみなら読込/完了batchの失敗を確認し、開始も実行履歴もなければ配信・Trigger側の調査を続ける。時刻変更・手動heartbeat・手動Issue closeで復旧を装わない。

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

参考: [GitHub標準runnerのpublic repository条件](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Containers料金・付帯枠](https://developers.cloudflare.com/containers/platform/pricing/)、[課金利用量の取得](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)。

通常のContainerコード公開でも手動buildの `CLAMAV_DEFINITION_REFRESH` を当日の固有値へ進める。通常公開後は自動更新を手動実行し、新しいコードbaseの検証済み記録へ更新する。Workerだけの公開では `--containers-rollout=none` を用い、定義imageを古いbuildへ戻さない。

Dockerを使えない開発環境では、`ClamAV daily definitions` の手動入力 `release_code=true` でcheckoutしたDownloaderコードをbuild・offline検証し、同じlease/job/rollout確認を経て公開できる（詳細はDownloader README）。このモードは成功時に新しいimageを`source_image`にも設定するので、直後に通常の日次更新を重ねて実行する必要はない。定期scheduleの動作は従来の定義更新のみ。

参考: [Cloudflare rolloutの完了・drain](https://developers.cloudflare.com/containers/configuration/rollouts/)、[API token権限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[GitHub通知](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)、[Actions課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

## 切り戻し

自動更新workflowを停止してから、Security D1の`previous_image`と本番application/active rolloutを読み取り確認する。以前のimageでも署名・内部日時・現時点の7日制限・実エンジン検証を通ることが必要。期限切れなら戻さず、新しい候補を作成する。実行中rolloutを上書きせず、その状態を解決してから行う。

通常の手順と同じジョブ確認・grace/drainを使い、Container application APIのimageのみrolling rolloutで有効な旧digestへ戻す。completedとdigestを再確認する。D1の成功記録を推測で書き換えない（不一致警告を保持）；その後daily workflowを再実行して検証済み状態へ復旧する。Worker rollbackはContainer imageを戻さない。Security Workerだけ戻す場合も0014の追加tableを削除せず保持する。

## 検証

`node --test downloader-worker/test/definition-updates.test.js` はSQLite実行とAPI/Docker mockで正常更新、署名/鮮度候補拒否、更新失敗、active job延期、lease競合、rollout完了待ち、期限前/期限切れ/監視停止、通知重複抑制・復旧を確認する。実エンジンの確認は`tools/verify-definitions.py`を候補imageにread-only mountし、`--network none --cpus 1 --memory 4g --entrypoint python -e PYTHONPATH=/app`で実行する。小容量の正常/EICAR試験であり、大容量media検査の速度・検出網羅性を検証したものではない。

## 解析コードだけの公開

依存・エンジン・scanner・定義を変更しない解析修正では、手動workflowの `release_code=true, analysis_only=true` を使用できる。`tools/analysis.Dockerfile` は現在本番の検証済みdigestを継承し、resolver.py / main_video.py / server.py と対象fixtureだけをCOPYする。freshclam・OS/pip更新・ClamAV実スキャンは繰り返さず、署名・内部日時・7日期限・YARAルール整合は再検証する。小容量のLinuxブラウザfixtureが失敗した候補はpush/rolloutしない。ジョブ/drain/lease/digest照合と更新後source_image確定は通常手順と共通。scannerや依存変更にはこのモードを使わない。日次自動更新は従来どおり定義更新と実エンジンfixtureを実施する。

## 履歴

初回導入、当時のversion／digest／workflow、rollout障害、検証件数は[2026-09の履歴](../docs/history/downloader/definition-updates-2026-09.md)へ分離しています。
