# 支払明細・月次計上管理

公開先 `https://tanaka-note.com/payments/`、Worker `t-room-payments`、D1 `payments-db`。家計簿への入力を人が確認するサービスで、外部家計簿には自動登録しない。

## 月別の配分と操作

支払日・支払先・摘要・支払総額（整数円、1〜999,999,999,999円）・開始月・月数（1〜1200）・備考を登録する。既存の入力範囲は維持する。

月単価**目安**は総額÷月数の切り上げ。実際の配分は整数商と余りを使い、前半の余り個の月へ1円ずつ加える。JavaScriptはBigInt、DB制約はSQLite整数演算を使う。10,000円／12ヶ月は目安834円、前半4ヶ月834円、後半8ヶ月833円、合計10,000円。3円／12ヶ月は前半3ヶ月1円、残り9ヶ月0円。0円の月も確認の対象となる。

今月以前の対象月ごとに「計上済みにする」「計上を取り消す」を操作する。完了日時はUTCで保存し、画面では端末のタイムゾーンによらず日本時間で表示する。未来月の完了はAPIとDBで拒否する。未操作月は、月が変わっても未計上のまま残る。

残り計上回数＝対象月数−計上済み月数。年月経過による残り月数とは分離し、全対象月の完了時だけ「計上完了」とする。「対象期間終了」でも未計上は消さない。上部に当月未計上件数・実額、当月完了件数、過去未計上件数・実額、進捗、当月ボタンを表示する。下部の横長表では、対象期間欄に「期間終了まで：残り○ヶ月」も表示する。これは今月を含み、開始前は対象月数、終了後は0ヶ月となる。残り計上回数と編集・削除を維持し、月別履歴は60ヶ月ずつ表示する。

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

### 標準機能による保管と権限

`payments-db` はproduction世代、APAC、read replication disabled。本番アカウントのWorkers Paid契約とbookmark取得を確認済み。Time Travelは常時有効で保持上限30日（DB作成前の履歴は存在しない）。[公式Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)を参照。期限内でも本番DBの復元は上書きと実行中クエリの中止を伴うため、**本番での復元試験は禁止**。

日記の自動バックアップは `diary-db` の許可されたテーブルと写真を扱う形式v6で、paymentsには非互換。支払明細Workerにはcron/R2バックアップbindingがなく、paymentsの定期export運用はまだない。

今回の公開前SQL exportは、既存の非公開R2バケット `t-room-diary-backups` の `payments/pre-migration/<UTC日時と一意ID>/` へ保管する。日記の `daily/`・`monthly/` と復元形式を分け、その世代削除対象にも入れない。公開r2.devは無効、カスタムドメインなし、対象prefixを消すLifecycleなしを毎回確認する。バケットロックは未設定で、認可された管理者や日記Workerのバケットbindingはこのprefixにもアクセスできる。prefixはIAMの分離ではない。

[R2標準の保存時暗号化](https://developers.cloudflare.com/r2/reference/data-security/)（Cloudflare管理鍵によるAES-256）とTLS、認証付きAPIを使う。SQL/gzip自体に追加の公開鍵暗号化は行わず、利用者に新しい秘密鍵の管理を要求しない。今回の支払明細バックアップは既存のCloudflare管理データと同じ信頼境界で保管する。T-Cloudの端末暗号化ファイル・動画・ユーザー鍵には適用せず、それらの方式や鍵を変更しない。

インフラ操作はクラウド環境のHTTPS宛先限定 `CLOUDFLARE_API_TOKEN` を使う。調査用Cloudflare MCPは読み取り専用のまま。SQL本文、支払先、備考、署名URL、credentialはログ・Git・CI Artifactへ出さない。SQLはメモリ内で受け渡し、通常のクラウド作業ディスクへ平文保存しない。

### 公開前のバックアップと復元検証

1. 最新main・PRのVerify/CodeQL・対象テスト・build markerを確認し、本番Worker Version、DB UUID、適用済みmigration、UTC/JST時刻、保持期間を記録する。
2. `/payments/api/entries` とその子pathのPOST/PUT/DELETEを保守中だけゲートウェイで止める。直接workers.dev経路も有効なら止める。アプリに保守モードはないため、停止が有効なことを実HTTPで確認する。
3. 新しいTime Travel bookmarkを取得し、D1標準SQL export APIで全schema/dataを出力する。一時署名URLは表示せずTLSでメモリへ読み込み、gzip化したSQLを上記R2へ保存する。取得した時刻、元DB UUID、Worker Version、SQL/gzipのSHA-256・byte数、各テーブルの行数・内容hash、schema hashをmanifestに記録する。
4. **保存したR2オブジェクトを読み戻して**圧縮前後のSHA-256を照合する。空の隔離検証D1を作り、UUIDが本番 `066196b0-25d4-4c92-acfd-066dae61530b` と異なることをコードで強制する。Worker binding・公開route・cron・SESSION_SECRETを付けず、D1標準import APIで読み戻したSQLを復元する。
5. 既存 `payments_accounts` / `payments_entries` / `payments_requests` / `d1_migrations` の全行hash、schema/index/trigger、明細version・論理削除、`PRAGMA quick_check` と `PRAGMA foreign_key_check` を照合する。隔離DBだけで0002を適用し、既存行保持、新テーブルが空、実配分のDB検証・完了済み編集保護・操作監査の不変性を確認する。検証DBのbookmarkへのTime Travel復元も同DBだけで試験し、元の全行・schemaへ戻ることを確認する。
6. 検証成功・取得時刻をmanifestへ追記し、R2へ保存・再読込する。検証DBはUUIDガード付きで削除する。書込停止前の予備検証が済んでいても、公開前には停止中の最新snapshotでこの検証を行う。**復元検証に成功するまで本番migration・merge・公開をしない**。
7. 未適用が0002だけであることと、書込停止後の本番全行hashがバックアップと一致することを確認してから `wrangler d1 migrations apply payments-db --remote` 相当の原子的なmigrationを適用する。既存全行が不変、新テーブルが空、foreign key/quick_checkとmigration記録を再確認する。Security DB・bootstrap・既存Secretは変更しない。
8. payments Workerを正規の公開手順で反映し、公開versionと `node tools/verify-web-app-builds.mjs --target t-room-payments` の一致を確認する。実機パスキーでの個人データ操作は利用者認証が必要なため、未実施の場合はそう報告する。可能な読み取り確認後に書込停止を解除する。

2026-10-22の事前検証では、本番SQL export→非公開R2への保存・再読込→隔離remote D1への復元→全既存行/schema/制約一致→0002の保持/監査/配分guard→隔離DBのTime Travel復元を確認し、検証DBを削除した。公開直前のsnapshotでも同じ検証を行う。

### 復旧と今後の自動バックアップ

復旧時はmanifestの元DB UUID・取得時刻・SHA-256・検証結果を確認し、認証付きR2 APIでSQL gzipを読み出す。隔離DBへのimportで再検証してから、別途承認した災害復旧手順で切り替える。SQLにはmigration/schema/index/triggerも含む。0002適用後のSQLは月別実績・取消状態・全操作監査・再送記録も含めて復元する。

公開後はpayments専用の定期export、保持日数、失敗通知、復元の定期検証、専用バケットによるIAM分離を別作業で検討する。Cloudflare Workflows→R2の公式方式を候補とし、今回の公開に定期ジョブや恒久的な新Workerは追加しない。

通常の切り戻しでは**追加テーブル・監査・完了実績を残し、migrationを逆適用しない**。不具合時はまず業務書込を停止し、現時点のexport/bookmarkを保護して修正版へ進める。旧Worker Versionへの切替は可能だが、旧版は月別管理・業務監査を生成しないため、書込停止を保って一時的な閲覧用途だけにする。DB全体のTime Travel巻戻しは新しい支払/計上/監査を失うため通常のrollbackに使わない。災害復旧時のみ、別の承認と停止時間を確保し、失われる変更を照合して運用者が実施する。

初回新規構築は0001からmigrationを適用し、既存 `tools/bootstrap.mjs` の手順に従う。既存環境の今回の更新ではアカウント・Secret・Security連携を作り直さない。
