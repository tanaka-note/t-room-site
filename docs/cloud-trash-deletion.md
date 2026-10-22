# T-Cloudの完全削除

ゴミ箱の一括削除とファイル単体の完全削除は、D1へ対象を確定して保存し、専用Cloudflare Queueから実行する。HTTPは202とジョブの進捗を返す。ブラウザ、ログインセッション、復号鍵に依存せず処理を継続する。

## 処理と復旧

- `cloud_trash_jobs`と各行の`purge_job_id`を同じD1 batch transactionで保存する。後からゴミ箱へ入ったデータは対象に含まない。同時に受け付けるジョブは1件。重複依頼は同じジョブを返す。
- 受け付け後は復元できない。DB triggerでも、受け付けと復元の競合を防止する。一部削除後の復元で破損データを作らないため、失敗後もこの制限を維持する。
- 1回80ファイル、本体・暗号化サムネイル・表示サムネイルを最大240キーでR2へ一括削除する。Stream参照がある場合はそちらの削除も確認してから、DB行と監査ログをtransactionで更新する。削除数・容量はDB triggerで更新する。
- フォルダは受け付け済みの対象だけを、子フォルダ・ファイルの参照がなくなった葉から削除する。対象外の参照が残るフォルダは削除しない。
- Queue consumerは最大同時実行1、D1 leaseは20分（consumerの実行上限15分より長い）。重複配信と中断を許容し、R2削除後のDB障害でも同じキーの削除を再実行する。
- R2/Stream失敗は60秒間隔でファイルごとに5回まで再試行し、他の対象は処理を進める。失敗した対象を残したまま`failed`にし、画面の「削除を再試行」から同じ対象だけを再開する。
- 5分ごとのCronが、初回送信・継続送信の失敗、Queue側の再試行枯渇、実行中断をD1から回収する。中断直後はlease期限まで待機する。既存の毎日18:17 UTCのアップロード清掃はその時刻だけ実行する。
- 画面を開き直すと`GET /api/trash`の`job`を表示する。表示中は`GET /api/trash/job`を5秒ごとに読み取り、変化時だけ一覧と容量を更新する。復旧にブラウザのポーリングは不要。

## 初回公開の準備

Queue作成、D1 migration、consumer/Cronは通常のversion公開とは別のインフラ設定。**このPRでは本番操作を行わない。** mainの通常公開が未作成のbindingで失敗しないよう、公開時は次の順で準備する。既存の本番データの削除を検証目的で実行しない。

1. 対象CI成功を確認し、Cloud Workerディレクトリで専用Queueを作成する。

   ```sh
   pnpm exec wrangler queues create t-room-cloud-trash-deletion
   pnpm exec wrangler d1 migrations apply cloud-db --remote
   ```

   migration `0013_trash_deletion_jobs.sql`はテーブル・列・index・trigger追加のみ。既存コードは未使用の列を参照せず、既存データを削除しない。

2. 検証済みPRをmainへ反映し、最新mainのCloudだけを、`docs/development-flow.md`のローカル`npm run release -- cloud`で公開する。この経路の`wrangler deploy`がproducer/consumerと追加Cronも反映する。Actionsの通常version公開だけではconsumer/Cron適用の確認にならない。
3. Queue consumer、producer binding、追加Cronの設定を読み戻し、公開buildの一致を確認する。実削除の確認は安全な専用fixtureを別途用意できる場合だけ行う。

Queue送受信・Cron/D1の利用量が増えるため、公開前に既存契約と利用量を確認する。ローカル試験はSQLiteとR2/Queueの合成fixtureを使い、課金対象の実削除・転送を行わない。

## ロールバック

新規依頼を止め、進行中ジョブがないことを確認してから旧versionへ戻す。進行中や一部失敗のジョブを残したまま旧コードへ戻すと、対象を復元・再削除できる旧UIと競合するため行わない。問題のあるconsumerは修正版で再開し、DBのジョブ・対象タグを消さない。追加schemaは旧コードと互換性があるので残す。全ジョブ完了後にのみ専用consumerと追加Cronを解除できる。既存の監査Queueとアップロード清掃Cronは維持する。
