# 体調管理

田中暢美名義の1アカウントを、本人と第一管理者がそれぞれのパスキーで共同管理するWebアプリ。新しいID・パスワードは発行しない。現在はレビュー版で、本番のWorker・D1作成、migration適用、公開は未実施。

## 記録と予測

- 未ログイン画面はサービス名と「パスキーでログイン」に限定する。HealthとSecurity Centerの公開HTMLに利用者の個人名を含めず、公開トップにはHealthのリンクを掲載しない。アカウントと2人の利用権限は変更しない。
- ホームは「今日の体調」が中心。次回の予測中心日と前回の開始日は補助情報として表示し、参考範囲・周期の詳細・設定は開閉できる欄に置く。
- 今日の調子（良い・普通・いまいち・悪い）、6症状、備考は任意。調子は同じボタンを再度押すと未選択に戻る。未入力を普通・症状なしと扱わない。
- 生理の項目は任意の開閉欄へまとめる。開始・終了・経血量がある記録は欄を開く。終了未記録時は「終了を記録」で今日の終了を選べ、保存まで変更しない。過去の終了日はカレンダーから選ぶ。
- 日曜始まりの月間カレンダー、新しい日付順の記録一覧、過去30日の振り返り。1日1記録。終了日は最後に出血した日で、自動補完しない。
- 2人の権限は同一。読み込み時のrevisionで保存・削除を照合し、競合は上書きせず409で拒否する。入力とログインを保ち、閉じて最新の記録を読み込むよう案内する。自動マージ、編集者名、履歴は残さない。
- 初期予測は任意入力の周期または28日と直近開始日から計算。4回の開始記録で3周期が集まったら、直近最大6周期の中央値（端数は四捨五入）へ切り替える。初期参考範囲は中心日の±3日、個別化後は実績の最短〜最長周期。外れ値は自動除外せず、期間超過後も日付を維持する。
- 設定の開始日は仮予測のための値であり、周期学習は実際に保存した開始記録から行う。終了日や症状は予測計算へ影響しない。
- 期間指定CSVは端末で作成する。今日の調子・症状を含み、未入力は空欄。CSVは平文なので、保存先の管理は利用者が行う。
- オンライン利用。通知、ホーム追加ボタン、排卵予測、医療判断は実装しない。

振り返りは今日を含む30日とその前の30日を別々に集計する。記録日数、調子別の日数、症状を記録した日数、備考のある日数を表示し、未記録と調子が未入力の記録を区別する。症状の未選択を「症状なし」と断定しない。実際の開始日がある場合だけ、直近最大6周期の中央値・最短〜最長・推移を表示する。開閉式の日別まとめは受診時に画面を見せる用途にも使える。改善・悪化、病名や原因を推測しない。

## データ互換性と競合

暗号方式、鍵委譲・復旧、AAD、日付HMAC識別子は変更しない。旧形式（schemaVersionなし／1）の症状番号0〜5は固定の歴史的対応表で安定IDへ読み替える。表示順の変更で意味が変わらない。読み込み・振り返り・CSVでは暗号文を自動再保存しない。明示的に保存した記録だけschemaVersion 2へ更新する。将来の未対応バージョンは保存せず、最新版で開くよう案内する。

```js
{ schemaVersion: 2, date: '2026-01-01', condition: null,
  symptoms: [{ id: 'headache', intensity: null }],
  start: false, end: false, flow: null, note: '' }
```

conditionのnullは普通と異なる。intensityはnull／light／normal／strongで、現在は入力UIを設けず、読み込み済みの強度は他項目の編集でも保持する。症状カタログを引数で渡せる純粋集計・検証を用意し、将来のカスタム症状や生理前後の任意期間集計に拡張できる。今回これらの入力UI・医療分析は追加しない。

PUTは暗号化envelopeとexpectedRevisionのみを受け取り、0は新規作成、1以上は既存の同番号への更新。DELETEもexpectedRevisionが必須。単一SQLの条件付き書き込みで並行更新を防ぐ。削除時は暗号文とIVを消去し、既存テーブルに不透明なHMAC識別子と単調増加revisionのみの削除目印を残す。GETには返さず、削除後の再作成に古い編集画面が上書きすることも防ぐ。平文migrationや新しいD1 migrationは不要。健康内容の履歴は保持しない。revision_conflictの409とsession_changedの409を区別し、後者のみ再ログインへ戻す。

APIのHTML・text/plain・空本文・不正JSON応答は、HTTP statusに応じた共通エラーへ変換する。非JSONの401／403でも画面をロックし、遅延応答はgenerationで拒否する。200のJSONもAPIごとの構造を検証し、PUT／DELETEはok=true・安全な整数revision・送信時の更新番号+1を確認してから端末状態を更新する。GETは暗号化記録の配列、handoffはsessionId・有効期限・暗号化鍵bundleを検証する。確認できない場合は保存成功と扱わず、入力を保持する。

アカウントIDは公開JavaScriptに固定せず、認証後の鍵bundleまたはSecurity Centerの認証済みAPIから取得する。IDの値、既存AAD・HMAC・RSAラベルは変えず、既存暗号文の互換性を維持する。画面ロック時にIDも端末状態から消去する。

## フロントエンドの構造

画面はpublic/index.html、CSSはpublic/health.cssを正本とする。CSSは色・余白・角丸・focus等の共通変数、部品別の定義（今日の体調／周期／カレンダー／一覧／振り返り／フォーム／dialog）、狭い画面向けmedia queryに整理し、末尾に上書きパッチを重ねない。hiddenの優先以外は!importantを使用しない。既存の青色とブランド資産を維持する。

Vanilla JSを維持し、新しいライブラリは追加していない。

- health.js：構成・イベント接続・busyと画面ロック
- health-state.mjs：auth（session／master／generation）、data（records／settings／revision）、ui（month／tab／busy）の寿命
- health-api.mjs：通信と認証失効／保存競合の区別
- health-session.mjs：パスキーログイン、PRF消去、有効期限
- health-records.mjs：暗号化保存・復号読み込み・revision管理
- health-editor.mjs：選択日と編集中スナップショット、フォーム、未保存判定
- health-calendar.mjs／health-render.mjs／health-format.mjs：描画と表示整形
- health-domain.mjs／health-insights.mjs：DOMに依存しない検証・予測・期間集計
- health-crypto.mjs：既存暗号処理（変更なし）

画面離脱・失効はgenerationを進め、暗号鍵・記録・フォーム・振り返りDOMを消去する。遅延した認証・復号・保存応答は画面へ戻さない。Back／Esc／背景／閉じるは既存の共通dialog navigationを維持する。

## 暗号化と認可

健康情報と予測設定はブラウザ内でAES-GCM-256により暗号化し、D1にはHMAC日付識別子・IV・暗号文・更新メタデータのみ保存する。日付・調子・症状・備考・設定値をAPI、ログ、監査へ送らない。識別子と更新時刻、通信元、データ量はサーバーから見える。

記録鍵はランダム32バイト。パスキーごとのRSA-OAEP-3072公開鍵に包んで委譲する。その秘密鍵はパスキーPRFからHKDFで導出した鍵で暗号化する。PRF結果、復号鍵、平文秘密鍵をCloudflareへ送らない。ログアウト・画面離脱時はブラウザ内の記録と鍵を消去する。PRF非対応時は平文へ切り替えず停止する。

Security CenterがIdentity、招待・連携、パスキー承認、鍵準備を管理する。共通Identityと体調管理アカウントは別の概念。本人枠は最初にオーナーが連携したIdentityに固定し、第三者追加をAPIとDB triggerで拒否する。2人それぞれの追加パスキーは利用者鍵準備後にオーナーが承認する。

復旧用の記録鍵は既存T-Cloud管理者公開鍵で暗号化してSecurity Centerへ保存する。管理者復旧でT-Cloud管理者秘密鍵を端末で解除し、新しいパスキーへ再委譲する。サービス独自のPWはない。既存管理者鍵・復旧手段が失われた場合は暗号文から復元できない。失効した端末へ新たなAPIアクセスは許可しないが、既に取得・書き出した記録を遠隔消去するものではない。

Webアプリの配信コードと端末は信頼境界に含まれる。端末側暗号化によって、侵害された配信コード・端末からの情報取得まで防げるとは保証しない。

## ローカル確認

```powershell
node tools/install-verify-dependencies.mjs health security
node tools/verify.mjs --target health --browser --build
node tools/verify.mjs --target security --browser --build
node health-worker/tools/review-server.mjs
```

http://127.0.0.1:8793/health/ で確認できる。レビューサーバーはローカル専用で、仮の2人・仮のPRF・メモリ内SQLiteを使う。実際の暗号化と記録APIを使用するが、本物のWebAuthn・Security Center復旧を試す環境ではない。終了するとテスト記録は消える。テスト認証コードはレビュー用Nodeサーバーのみで提供し、Workerの公開資産には含めない。

以前のレビューサーバーを終了せず別ポートへ記録を引き継ぐ場合は以下を使う。暗号文と鍵はメモリ内だけで引き継ぎ、ファイルへ出さない。起動時点のコピーで、以後は2つの環境の記録は独立する。元のサーバーは停止しない。

```powershell
$env:HEALTH_REVIEW_PORT='8794'
$env:HEALTH_REVIEW_IMPORT_URL='http://127.0.0.1:8793/health/'
node health-worker/tools/review-server.mjs
```

## 公開前に必要な作業（別途公開承認後）

1. 専用D1を作成し、wrangler.jsoncのゼロ値database_idを置き換える。独立したSESSION_SECRETをSecretとして登録する。
2. Security側0022_health_service.sqlとhealth側0001_init.sqlを対象DBへ適用する。既存Securityテーブルを作り直すmigrationなのでバックアップ・対象確認を行う。
3. 相互service bindingを満たす順番でhealth／securityを公開し、registryのbuild一致を確認する。PASSKEY_ENABLEDは準備完了後に有効化する。
4. Security Centerでオーナー連携、本人の招待・連携、各パスキーの鍵準備、既存T-Cloud管理者鍵による初期化・委譲承認を行う。
5. 本物の2人のパスキーで共同記録・PRF対応・失効、テストデータで復旧を確認する。既存日記・請求書・T-Cloudのログインも確認する。

本番bindingを持つWorkerをPreviewへ公開しない。本番公開と初期設定は今回のレビュー作業に含めない。
