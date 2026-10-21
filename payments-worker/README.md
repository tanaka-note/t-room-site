# 支払明細・月次計上管理

公開先 `https://tanaka-note.com/payments/`、Worker `t-room-payments`、D1 `payments-db`。家計簿への入力を人が確認するサービスで、外部家計簿には自動登録しない。

## 月別の配分と操作

支払日・支払先・摘要・支払総額（整数円、1〜999,999,999,999円）・開始月・月数（1〜1200）・備考を登録する。既存の入力範囲は維持する。

月単価**目安**は総額÷月数の切り上げ。実際の配分は整数商と余りを使い、前半の余り個の月へ1円ずつ加える。JavaScriptはBigInt、DB制約はSQLite整数演算を使う。10,000円／12ヶ月は目安834円、前半4ヶ月834円、後半8ヶ月833円、合計10,000円。3円／12ヶ月は前半3ヶ月1円、残り9ヶ月0円。0円の月も確認の対象となる。

今月以前の対象月ごとに「計上済みにする」「計上を取り消す」を操作する。完了日時はUTCで保存し、画面では端末のタイムゾーンによらず日本時間で表示する。未来月の完了はAPIとDBで拒否する。未操作月は、月が変わっても未計上のまま残る。

残り計上回数＝対象月数−計上済み月数。年月経過による残り月数とは分離し、全対象月の完了時だけ「計上完了」とする。「対象期間終了」でも未計上は消さない。上部に当月未計上件数・実額、当月完了件数、過去未計上件数・実額、進捗、当月ボタンを表示する。下部の横長表と編集・削除を維持し、月別履歴は60ヶ月ずつ表示する。

計上済み月がある明細の金額・開始月・月数の変更、および削除は409で拒否する。**全ての完了を取り消し→修正→家計簿を確認して再計上**の順に操作する。支払先・摘要・支払日・備考の修正は可能。削除は既存と同じ論理削除で、記録は残る。取消前の実績額も操作履歴に保持する。

既存データの対象月は全て未計上として始まる。過去の家計簿への入力状況は推測しないため、初回は過去未計上が多く表示される場合がある。入力済みのものを確認しながら完了する。

## DBとAPI

`0002_monthly_ledger.sql` は追加migration。既存の `payments_accounts` / `payments_entries` / `payments_requests` の行を変更・削除しない。Security DBへのmigrationは不要。

- `payments_monthly_marks`: `(entry_id,target_month)`複合主キー、実配分額 `amount`、UTC完了日時 `completed_at`（取消時NULL）。操作した月だけ作る。未操作月は明細から導出し、全期間の行を初期生成しない。取消済み行は配分変更時だけリセットし、古い操作監査は残す。
- `payments_operation_audit`: 操作IDを主キーに、明細ID・対象月・操作・UTC時刻・認証済みIdentity/アカウント・明細version・必要な新旧金額/期間を保存。支払先・摘要・備考・Cookie・パスキー情報は保存しない。UPDATE/DELETEを禁止する。外部キーはRESTRICT、明細は論理削除。認証の監査は既存Security Centerのまま分離する。
- 完了実績保護、期間/実額/未来月検証をDBトリガーでも実施。完了月検索は部分インデックス、操作履歴は明細・時刻インデックスを使う。一覧は明細と完了記録の集計だけを読み、全月展開は詳細表示時のみ。全明細合算金額はBigIntで集計し、APIでは十進文字列として返す。

| API | 内容 |
| --- | --- |
| GET `/payments/api/entries` | 明細・実績に基づく残り回数・当月/過去集計 |
| GET `/payments/api/entries/:id/months` | 全対象月の実額・状態・現version、業務操作履歴最新100件（DBでは全件保持） |
| PUT `/payments/api/entries/:id/months/:YYYY-MM` | `{requestId,expectedVersion,completed:boolean}`。トグルではなく望む状態を指定 |
| POST/PUT/DELETE `/payments/api/entries[/:id]` | 既存CRUD。新旧配分・操作監査を同時保存 |

状態変更は明細versionも進め、完了・取消・編集・削除を同じversionで直列化する。競合は409、同じ操作IDと同じ内容の再送は保存済み応答を返す。同IDの異なる内容は409。既に望む状態なら変更・監査の重複を作らない。操作ID保存、状態変更、業務監査をD1 `batch()`の一つのトランザクションに入れ、監査失敗時は全てロールバックする。prepare中に同一操作が先にcommitした場合も再送照合する。

画面は通信失敗時に操作IDを維持し、再試行可能。409時は状態を読み直して再確認を促す。同一ブラウザの別タブへ変更を通知し、モーダル中は再描画を延期する。月切替・画面復帰時にも安全な状態で更新する。未保存入力・保存/計上操作中の自動更新延期、既存の戻る/Esc/背景/未保存保護を維持する。

## 認証とセキュリティ

`owner` 1アカウント、Security Centerの `primary-admin` だけを許可。登録・承認済みパスキーのみ。自動連携、新Identity作成、Password認証は追加しない。既存の60秒・一回限りhandoff、独立Secret、rolling session・毎回の失効照会・認証監査を維持する。

新APIも既存と同じ認証後に実行し、同一Origin・JSON、UUID・version・年月・boolean等を検証する。CookieはHttpOnly/Secure（HTTPS）/SameSite=Strict、個人情報はno-store、CSP/XSS対策を維持。動的表示はtextContentで描画する。例外や入力内容をconsoleへ出力しない。Cloudflare observabilityは既存の無効設定のまま。データをGitHub Actionsへ渡さない。

## 検証

Node.js 24、固定lockfileで依存を導入する。

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false
npm run check
npm test
npm run test:restore
# リポジトリルート。restoreはnpm test内にも含む
node tools/verify.mjs --target payments --browser --build
node --test tools/test-session-secret.mjs tools/test-secret-ignore.mjs tools/test-password-auth.mjs tools/test-passkey-rolling.mjs
# Security全体のunit回帰
cd security-worker
node --test test/*.test.js
```

`test/monthly.test.js` は端数/最大値/0円月、年越し/JST、未計上継続、取消、競合/同一ID同時再送、完了済み編集/削除、監査失敗の原子性、追加migrationのデータ保持、認証、2,000明細/120,000記録の負荷を確認する。`test/security.test.js` は実Security実装の連携・handoff/rolling/失効と既存Securityデータ保持を確認する。

ブラウザfixtureはPC1440pxと390pxタッチで、CRUD、丸め、完了/取消、応答消失再送、タブ更新、XSS文字列、未保存入力・Back/Esc/背景タップ・44px以上の操作ボタンを検証する。`TROOM_CHROMIUM_PATH` はローカルの互換Chromiumを指定する場合のみ使用。実機WebAuthn・iOS Safari・Android実機とは区別する。

`test/backup-restore.mjs` は本番configを使わずOS一時ディレクトリに合成データ専用D1を2つ作る。Wrangler local export→空の別local D1へimportし、全5テーブルの内容、完了/取消状態、監査、再送記録、トリガー、integrity/foreign_key_checkを照合し、一時データを削除する。local exportには `--persist-to` がないため、生成config配下の既定 `.wrangler/state` をexport元とする。

## バックアップ・復元

### 調査結果と権限

2026-10-21の読み取り確認では `payments-db` はproduction世代、APAC、read replication disabled、53,248 bytes。Time Travel bookmark取得APIの利用可を確認した（現時点のbookmarkは公開前バックアップの代用にはしない）。契約プランの実保持期間は未確認。支払明細Workerにはcron/R2バックアップbindingがなく、リポジトリ内にもpaymentsの定期export運用はない。

日記の自動バックアップは日記専用テーブル許可リストと写真を扱う形式v6で、paymentsには非互換。既存の日記バケット/復元コードを流用すると支払履歴を取りこぼすため、今回は変更しない。

[Cloudflare公式Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)によるとproduction世代で常時有効、Wrangler 3.4.0以上が必要。Workers Freeは過去7日、Paidは30日まで。復元は元DBをその場で上書きし、実行中クエリが中止される。別DBへのclone/forkとして使わない。**本番での復元試験は禁止**。

実施済みは合成データでのlocal D1 export/import復元。remote D1作成・export・Time Travel restoreは未実施（読み取り専用接続のため）。本番データは取得していない。remoteでの確認が必要なら、権限のある運用者が次の同じ手順を専用の検証DBと合成データで行う。MCPの読み取り権限を回避しない。

### 本番migration前（公開担当者が実施）

1. 最新main・PRのVerify/CodeQL・対象テスト・build marker一致を確認する。本番反映は別途実施する。
2. 本番のWorker Version ID、DB UUID、適用済みmigration、UTC/JST時刻、Time Travel保持期間を記録する。新旧Workerをまたぐ変更を避けるため、保守時間中は `/payments/api/entries` 配下へのPOST/PUT/DELETEをゲートウェイ等で停止する。アプリには保守モード切替を実装していないため、公開担当者が書込停止を確認する。
3. 安全な管理端末でアクセス権を制限した暗号化ディスク上のディレクトリを用意する。以下は**本番データをファイルへ保存する運用コマンド**。CI・共有端末・画面共有・公開Artifactでは実行しない。SQL本文、支払先、備考を出力しない。

```sh
# payments-worker/。BACKUP_DIRは運用者が用意した保護領域
umask 077
pnpm exec wrangler d1 time-travel info payments-db
pnpm exec wrangler d1 export payments-db --remote --output "$BACKUP_DIR/payments-before-0002.sql"
# 出力ファイルのハッシュ/サイズ・取得時刻・commit・DB UUIDを非公開で記録する
# exportを安全な検証DBへimportして検証するまで本番migrationしない
pnpm exec wrangler d1 migrations list payments-db --remote
pnpm exec wrangler d1 migrations apply payments-db --remote
```

4. 未適用が `0002_monthly_ledger.sql` であることを確認し、既存行数・外部キー・新テーブルが空であることを検証する。Security DBのIdentity/連携/パスキー/session/監査/Health/Cloudへ操作しない。既存bootstrapやSecurity `0025` を再実行する必要はない。
5. migration後にpayments Workerだけを公開する。`node tools/check-web-app-builds.mjs --target t-room-payments` →正規release手順→公開build一致を確認する。パスキー認証・一覧・月別配分・既存行保持を読み取りで確認してから書込停止を解除する。今回の作業では本番反映を実施しない。

### 検証用remote DBへの復元（運用者向け・未実施）

運用者が空の専用検証DBを準備し、本番route/Service Binding/cron/SESSION_SECRETを含まない別configへそのUUIDだけを設定する。復元先UUIDが本番 `066196b0-25d4-4c92-acfd-066dae61530b` と異なることを人とコマンドの両方で確認する。先に合成データによるexport/import、次に必要な場合のみ保護領域の本番exportで試験する。

```sh
# RESTORE_CONFIGには検証DBのみ。中身は事前レビューする
pnpm exec wrangler d1 execute payments-restore-check --remote --config "$RESTORE_CONFIG" --file "$BACKUP_DIR/payments-before-0002.sql"
```

復元先で全テーブルの行数、明細version/論理削除、月別実額/完了UTC日時/取消状態、操作IDと監査行の対応、配分の合計、DB制約・index/trigger、`PRAGMA integrity_check` と `PRAGMA foreign_key_check` を照合する。前migrationのexportには新テーブルがないため、復元後に0002を適用し全て未計上になることも確認する。月別履歴を含むpost-migration exportの復元も別途行う。検証用DBだけで書込み・取消の試験をする。結果は件数・整合性のみ記録し個人データをログへ出さない。

Time Travel自体の試験は、専用検証DBで合成データを登録→bookmark記録→合成データ変更→**その検証DBだけ**restore→照合する。export/import試験はTime Travel復元試験の代わりと報告しない。

### 長期保存と切り戻し

Time Travelの期限を越える保管には、一貫したD1全体のexport（明細・marks・requests・audit・migration情報とschema/trigger/index）を推奨する。管理端末で暗号化し、秘密鍵をCloudflare/Git/CIへ置かず、非公開の別保管先へ保存する。日次・月次世代、保存期間、アクセス権、削除規則、復号と復元の定期試験を運用者が定める。Cloudflare Workflows→R2の公式export方式もあるが、平文バックアップ・権限・暗号鍵の管理を設計してから導入する。今回は定期ジョブや課金リソースを追加していない。

通常の切り戻しでは**追加テーブル・監査・完了実績を残し、migrationを逆適用しない**。不具合時はまず業務書込を停止し、現時点のexport/bookmarkを保護して修正版へ進める。旧Worker Versionへの切替は可能だが、旧版は月別管理・業務監査を生成しないため、書込停止を保って一時的な閲覧用途だけにする。DB全体のTime Travel巻戻しは新しい支払/計上/監査を失うため通常のrollbackに使わない。災害復旧時のみ、別の承認と停止時間を確保し、失われる変更を照合して運用者が実施する。

初回新規構築は0001からmigrationを適用し、既存 `tools/bootstrap.mjs` の手順に従う。既存環境の今回の更新ではアカウント・Secret・Security連携を作り直さない。
