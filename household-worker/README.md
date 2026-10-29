# 家計簿

公開先 `/household/`、Worker `t-room-household`、専用D1 `household-db`。機能要件は[設計書](../docs/household-design.md)を参照する。

## 初版

手入力の収入・支出・振替、計算対象／対象外、月別／年別集計、分類・口座・フリーワード検索、自由な口座と内訳、月末資産合計・口座別チャート、CSV出力、バックアップ保存・復元を提供する。予算管理とCSV・PDF・画像からの明細取り込みは含めない。

初期の明細と資産履歴は空。「減価償却」口座の内訳1件だけを0円で用意する。各明細と現在の口座残高・月末記録は独立し、一方の操作で他方を増減しない。マイナス残高に対応する。過去チャートの入力は完成直前の別作業とし、現在残高を変更しない。

## 認証と共有

既存Security Centerのパスキー、60秒・一回限りhandoff、サービス専用Secret、12時間rolling session、毎回のIdentity／credential／link失効確認、監査を使用する。新しい認証方式・暗号鍵管理・Passwordログインは追加しない。

サービスアカウントは `owner`（田中宏知、編集可能）と `viewer`（共有ページ、全データを閲覧可能）。編集用は既存 `primary-admin` Identityだけが利用できる。閲覧専用の連携は第一管理者が既存の招待・承認・サービス連携手順で明示的に付与する。同じ共有アカウントを複数Identityへ割り当てられる。アカウント名は権限の根拠にしない。

共有用でも検索・集計・書き出しができる。APIは読み取り用と変更用を分け、共有用からの明細・口座・月末残高・分類の変更と復元を403で拒否する。画面でボタンを隠すだけの制御にしない。

## 保存と更新

- `household_accounts`: サービスアカウントとrole・有効状態・session version。バックアップ復元の対象外。
- `household_state`: 現在のデータ世代と全体revision。
- `household_records`: 世代・記録種別・安定したIDごとのJSON。口座、明細、分類、月末残高、過去チャートを分離する。
- `household_requests`: 操作ID・入力のハッシュ・結果。通信再送を冪等にする。

更新では期待revisionを必須とし、revisionの連番をDB triggerでも検証する。操作IDの記録、revision更新、対象行の変更を一つのD1 batchで確定し、競合は409で全体をロールバックする。別タブの変更は通知し、古い編集の暗黙上書きを防ぐ。

個々の値は整数円。明細20,000件、口座200件・各内訳100件、分類500件、月末／過去記録はそれぞれ3,600件まで。保存するJSON本文の合計は10MiBまでとし、上限では明示的に拒否する。バックアップのアップロードは16MiBまで、画面のファイル選択は12MiBまで。JSON・D1の上限を超えた不完全な保存を成功扱いしない。

## バックアップと復元

形式 `troom-household` v1。口座・内訳・明細・分類・月末記録・過去チャートを含め、Identity、認証用アカウント、パスキー、Cookie、Secretは含めない。バックアップから権限を作成しない。

復元前に全レコードの型・ID・参照・標準分類・金額・年月を検証する。新しい非公開世代へ50行ずつ準備し、完了後に期待revisionのCASと操作ID保存を一つのbatchで確定する。同時再送も準備世代を分ける。失敗した準備世代や旧世代はそのままではAPIから見えず、現行世代を削除しない。旧世代の削除や自動整理は初版では行わない。

CSVはUTF-8 BOM付き、金額は収入が正・支出が負。内容・メモ等の文字列で表計算の式が実行されないようにする。

## API

| API | 内容 |
| --- | --- |
| GET `/api/session` | 認証状態・表示名・role |
| POST `/api/passkey/handoff` | 既存パスキー認証の一回限り引き換え |
| POST `/api/logout` | セッション終了 |
| GET `/api/data` | 有効世代のデータとrevision |
| POST `/api/mutate` | `{requestId,expectedRevision,operation,value}` |
| GET `/api/backup` | アプリの全データを書き出す |
| GET `/api/export.csv` | 家計明細のCSV出力 |
| POST `/api/restore` | `{requestId,expectedRevision,backup}` |

変更APIには同一Origin・JSONを要求する。HTTPS、no-store、CSP、画面埋め込み拒否、LINE内ブラウザ制限を使用する。入力値・金融情報・資格情報をログへ出力しない。既存の共通dialogで戻る・Esc・背景・閉じる・未保存入力の保護を統一する。Web自動更新は未保存入力・処理中に延期する。オフラインキャッシュ・PWA manifestは初版に設けない。

## 検証と初回公開

```sh
pnpm run check
pnpm test
# ルートから、合成データとローカルSQLiteだけで実施
node household-worker/test/household.browser.mjs
node tools/verify.mjs --target household --build
```

単体試験は残高と収支の独立、共有用権限、実Security連携、既存データを維持する追加migration、再送・競合、壊れた復元・準備中の失敗・同時復元を検証する。ブラウザfixtureはPCとタッチ幅で入力・未保存保護・口座・月末記録・チャート・閲覧専用表示を確認する。実端末WebAuthnの操作とは区別する。

初回は専用D1に `0001`〜`0003` を適用し、専用 `SESSION_SECRET` を安全な乱数で新規設定する。既存Secretは上書き・共有しない。Securityのサービス追加migrationは既存データと外部キーを維持し、利用者へのアクセスを自動付与しない。既存のSecurity Centerで第一管理者が編集用・共有用の必要な連携を設定する。

初回のWorker作成・route・D1・Service Bindingの準備は、通常のversion昇格とは別のインフラ手順で行う。既存サービスのrouteを変更しない。コード公開は対象CIが成功したmainを使用し、Securityと家計簿の双方が準備できた後にインデックスへ入口を公開する。切り戻しでは新規D1や記録を削除せず、入口を戻し、サービスを停止または修正版へ進める。
