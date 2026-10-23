# T-Cloudの完全削除

ゴミ箱の一括削除とファイル単体の完全削除は、D1へ対象を固定して保存し、専用Queueで実行する。HTTPは202を返し、処理はブラウザ・セッション・復号鍵に依存しない。

## ジョブと失敗の扱い

- `cloud_trash_jobs`と`purge_job_id`を同じD1 transactionで保存する。受付後の追加データは含めない。受付済みデータの復元と外部オブジェクト参照の変更はDB guardでも拒否する。
- 部分一意indexは`queued`/`running`だけを1件に制限する。`failed`は対象タグを保持し、新規削除は未受付の行だけを別ジョブへ固定できる。失敗を完了扱いにしたり、タグを解除したりしない。
- `GET /api/trash/jobs`は全未完了ジョブと直近ジョブを返す。画面は依頼ID、受付日時、ファイル・フォルダ数、削除済み件数、失敗理由を表示する。ジョブ単位で`POST /api/trash/jobs/:id/retry`を送る。新規一括削除とは別のボタンを使う。
- 再試行は、空いているactive slotの獲得、元の対象の試行回数初期化、監査を一つのtransactionで行う。他ジョブ実行中・重複再試行は409。新しい対象を追加しない。
- R2は通常80ファイル・最大240キーを一括削除する。失敗後は10ファイル単位、繰り返し失敗するグループはファイル単位に分け、正常な対象を先に完了する。各ファイルの失敗は1回のconsumer実行につき1回、5回まで。再試行間隔は60秒。
- R2 bindingの存在しないキーの削除は冪等。Streamの404も削除済みとして扱う。R2とStreamの両方が成功してからDB行・監査をtransactionで確定する。R2成功後のD1障害は同じ対象から再開する。
- 対象外のファイルが同じR2キーを参照している場合、外部削除より前に対象を保持し`referenced_object`を記録する。対象外参照があるフォルダも削除しない。参照問題は再試行だけで解決しないことがある。タグ解除や強制削除では解決しない。
- 削除数・容量は既存DB triggerで更新する。ファイルごとの削除監査とジョブ受付・再試行・完了・失敗監査を維持する。
- 未完了アップロードはmultipartを中止してからR2本体を削除する。中止の失敗は記録して再試行し、既に中止・完了済みの`NoSuchUpload`は冪等に扱う。受付済みの行は通常のアップロード完了/取消と既存清掃Cronから除外し、清掃が行を選んだ後で受付された競合もDB条件で保護する。

## 中断と画面表示

Queue consumerは最大同時実行1。D1 leaseは20分で、consumerの実行上限15分より長い。重複配信はleaseで抑止し、中断後はlease満了後に5分Cronから再送する。Queue送信失敗はD1に記録し、再試行枯渇や継続送信の失敗でもジョブを失わない。

画面は受付済み、削除処理中、中断・再開待ち、一部失敗、完了を区別する。送信失敗、次回試行待ち、lease期限切れは再開待ちとして表示する。実行中の即時クラッシュは外から断定できないため、lease期限までは処理中の表示が残り得る。画面の5秒pollは表示用で、処理継続・復旧に必須ではない。既存アップロード清掃は毎日18:17 UTCのまま維持する。

## 検証

SQLite/Queue/R2 fixtureで対象固定、複数失敗ジョブ、新規削除、ID指定再試行、R2グループ切り分け、参照保護、中断/再配信、件数/容量/監査を確認する。Chromium fixtureで再訪・5状態・操作の区別を確認する。PR #105のフォルダ表示回帰を維持する。

本番bindingを使わないMiniflareでも、実WorkerのQueue handlerとローカルD1/R2を組み合わせ、2個のダミーファイル、後から追加したデータの除外、重複配信、件数/容量/監査を確認する。本番の実ファイルを削除試験に使わない。

## 初回公開

Queue/consumer/CronとD1 migrationはversion公開とは別のインフラ作業。必須CIが失敗している間はマージ・本番変更しない。通常Actionsのversion公開はconsumer/Cronを反映せず、非version設定の差分を拒否するため、初回はローカルの正式なCloud releaseで反映する。

1. privateな作業ディレクトリへD1をexportし、署名付きdownload URLやデータをチャット/Gitへ出さない。exportログもprivateに保持する。Time Travel bookmarkと取得時刻を記録する。SQLをローカルへ読み戻し、`integrity_check`、`foreign_key_check`、件数を確認する。exportの挿入順が親子順とは限らないため、読み戻し中だけ外部キー検査を無効化し、読み戻し後に必ず全件検査する。
2. バックアップのローカルコピーで`0013_trash_deletion_jobs.sql`と`0014_trash_job_recovery.sql`を適用し、件数と整合性を再確認する。両migrationは既存ファイル行を削除せず、旧コードは対象タグが未設定の間は動作できる。
3. 必須CI成功と最新mainを確認し、専用Queueの有無を調べ、なければ作成する。remote migration一覧で未適用ファイルが今回の2件だけであることを確認して適用する。

   ```sh
   # cloud-workerで実行
   pnpm exec wrangler queues create t-room-cloud-trash-deletion
   pnpm exec wrangler d1 migrations list cloud-db --remote
   pnpm exec wrangler d1 migrations apply cloud-db --remote
   ```

4. PRをmainへ統合後、cleanな最新mainで`npm run release -- cloud`を実行する。対象verify、build freshness preflight、`wrangler deploy`、公開build検証を維持する。CI/ローカルで必要なffmpegを用意する。既存Secretや本番bindingを別のPreviewへコピーしない。
5. producer、consumer（batch 1、timeout 0、concurrency 1、retry 5/60秒）、2本のCron、Worker version、公開buildを読み戻す。監査Queueと既存Cronが維持されたことを確認する。認証なしAPIの拒否・app-version・静的画面を安全なGETで確認する。認証済み本番ブラウザを使えない場合、進捗表示はfixtureでの確認と区別して報告する。

利用増加はQueueの送受信・D1読み書きと5分Cron。通常は80ファイルごとに1メッセージを継続し、初回の大量1ファイル1メッセージを避ける。R2オブジェクトの読み出し・復号・転送は行わない。契約や残枠を取得できない場合は不明と報告し、課金設定を変更しない。

## 停止・復旧・ロールバック

- 受付停止用`TRASH_DELETION_PAUSED=true`は新規受付・明示再試行だけを503にする。既存ジョブの記録とGET進捗は維持する。検証済みmainの同じコードを正式なdeploy手順でこのvarだけ上書きし、Queue consumerの配信を一時停止する。実行中consumerは最大15分、leaseは20分なので、停止直後に旧版を重ねない。
- 原因を修正したconsumerを公開し、受付停止varをfalseへ戻し、Queue配信を再開する。Cronが未完了ジョブを回収する。失敗ジョブは管理者がIDを指定して再試行する。
- 未完了/失敗ジョブがある間は、`purge_job_id`や履歴を消さず、旧同期削除コードへ戻さない。修正版で前進復旧する。旧版へ戻せるのは全ジョブ完了・新規受付停止を確認した場合だけ。追加schemaを残し、専用consumerと追加Cronを解除する際も既存監査Queueと清掃Cronは維持する。
- R2の完全削除はD1復旧だけでは元に戻らない。Time Travelやexportの復旧はDB整合性を守るための手段であり、失われたオブジェクトを復活させない。本番DBの巻き戻しは新しい書込みを失う可能性があるため、consumer停止・現状保全・影響確認なしに実行しない。
