# Downloader 1・2 と AI Chat のサービス終了

| サービス | 旧URL | 旧Worker |
| --- | --- | --- |
| T-lain Downloader 1 | `/downloader/` | `t-room-downloader` |
| T-lain Downloader 2 | `/downloader2/` | `t-room-downloader2` |
| AI Chat（Android `jp.tanaka.troom.ai`） | `/ai/api/` | `t-room-ai` |

Windowsの「X動画ダウンローダー」0.4.0（`XDownloader.exe`）はPCから直接Xへ接続する。今回の対象は上表の3サービス。Downloader 2の拡張機能とCompanionはWeb経由のペアリングを終了する。AI Chatのインストール済みAndroidアプリは、API停止後に会話機能を利用できなくなる。

## PR承認後の本番反映

1. PRのCI成功を確認してからmainへ統合する。通常Actionsで `t-room-site` と `t-room-security` を反映し、公開バージョンを照合する。日記は共用backup dispatchを参照するため、既存の定期保存・公開buildを回帰確認する。Securityは対象サービスの新規パスキー認証、連携候補、handoff、既存セッションを拒否する。第一管理者の共通credentialと日記・T-Cloud等の連携は維持する。
2. Cloudflareの `tanaka-note.com` Custom Domainが `t-room-site` を指すことを確認し、`tanaka-note.com/downloader*`、`tanaka-note.com/downloader2*`、`tanaka-note.com/ai*` の3ルートを、旧Worker名を照合して解除する。旧URLがCustom Domain経由で `410 Gone`、`Cache-Control: no-store` を返すことを確認する。旧3 Workerの `workers.dev` とPreview URLは無効の状態を確認する。`/downloader/` と `/downloader2/` のWeb画面・認証API・ペアリングAPI、`/ai/` と `/ai/api/` の代表URLを照合する。
3. Downloader 1の実行中ジョブとClamAVの既存Actions実行が終端したことを確認する。`t-room-downloader` の10分間隔のCronと `t-room-downloader-jobs` の当該WorkerへのQueue consumerを解除し、設定を読み戻す。処理中のジョブやキューに残ったデータは削除対象外。Cloudflareの旧Worker・D1・Queue・DLQ・Container・一時R2は保持する。旧Workerのコードと構成を参照する場合は終了前の[履歴](https://github.com/tanaka-note/t-room-site/tree/abee933e)を使う。
4. `security-db` の対象3サービスの連携・handoff・challenge・セッション件数を読み取る。保留中migrationが `0032_retire_downloader_ai_links.sql` だけであることを `wrangler d1 migrations list security-db --remote` で確認し、承認後に `wrangler d1 migrations apply security-db --remote` で適用する。対象件数が0で、他サービスの連携と共通credentialが維持されていることを確認する。対象連携を含んでいた未使用の有効な招待は失効する。必要な場合は残存サービスで再発行する。監査原本と過去のSecurityバックアップは保持する。
5. [Backup Workerの専用公開手順](../../backup-worker/README.md#初回切り替えこのprのmerge自動diary公開より前)に従い、検証済みmainから `t-room-backup` を公開する。`AI_DB` と `DOWNLOADER_DB` のbindingが外れ、共用Cron・Workflow・他のbindingが維持されていることを読み戻す。T-Cloudの「Backup-data」で「AI Chat」と「Downloader利用集計」が消え、他の項目が引き続き表示されることを確認する。次回の定期実行でも対象2サービスのdispatchが発生しないことを確認する。

## 既存バックアップの削除

データ削除の承認後、CloudflareアカウントとR2バケット **`t-room-service-backups`** を照合する。対象は末尾の `/` を含む **`d1/ai/`** と **`d1/downloader/`** の配下全体。日次・月次の旧形式、現行manifestと本文partを含む。調査時点では各43オブジェクト。実行時は最新の一覧で承認範囲を決める。

1. `t-room-backup` の新バージョンが100%であることを確認する。`t-room-d1-backup` の `ai-` と `downloader-` で始まる既存インスタンスを確認し、キュー待ち・実行中・再試行待ち・一時停止中のものが終端するまで削除を保留する。権限不足などで状態を確認できない場合も保留する。
2. R2の **List Objects** を各prefixでページ末尾まで実行し、key・ETag・サイズの一覧と合計件数を取得する。対象外オブジェクトもメタデータだけを照合用に記録する。対象キー全件が開始位置で2つのprefixのどちらかに一致し、prefix自体と空キーを含まないことを検査する。件数や内容が承認済み一覧から変わったら削除を保留し、再一覧・再確認する。
3. Cloudflare R2 API `DELETE /accounts/{account_id}/r2/buckets/t-room-service-backups/objects` に、承認済みのキーだけをJSON文字列配列で最大1,000件ずつ渡す。成功時は `success: true` と `result` のキー一覧を照合する。一部失敗時は `result` がnullになり、成功したキーは既に削除されている。`errors` を確認する。失敗時は対象prefixを再一覧し、削除が確認できていない承認済みキーだけを再試行する。共用バケット、ワイルドカード、Lifecycleルール、他サービスのprefix、`security-audit/`、`_metadata/`、元のD1とDownloader一時R2は対象外。
4. 各prefixの残存が0件であることを改めて確認する。対象外の一覧を読み戻し、key・ETag・サイズを比較する。定期バックアップによる通常の新規作成・保持期限削除の有無は実行記録と照合する。日時・対象件数・成否を作業記録に残す。

削除前であれば、切替を中止して旧ルートと検証済みバージョンへ戻せる。連携migration適用後に再開する場合は、承認された利用者に新しい連携を作る。既存バックアップの削除後は、そのR2オブジェクトを使った復元はできない。
