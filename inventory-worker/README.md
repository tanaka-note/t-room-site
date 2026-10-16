# 在庫照会

日用品・消耗品の現在庫と使用履歴を管理する、単一利用者向けのサービス。
初期版では「何を、いつ、何個使用したか」を記録し、品目ごとの月別・年間使用数を確認できる。

状態: **初期版。HTTPS＋D1標準暗号化、共通パスキー連携、単一ownerの方針を承認済み。**
この文書に実際の利用者氏名、認証情報、在庫、使用履歴を記載しない。

## 初期版の操作

| 操作 | 入力 | 結果 |
|---|---|---|
| 品目を登録 | 品目名、数える単位、初期在庫数 | 一覧に追加。初期在庫は使用数に含めない |
| 補充 | 品目、数量、日時 | 在庫を増やし、補充履歴を残す |
| 使用 | 品目、数量、日時 | 在庫を減らし、使用履歴と集計へ反映 |
| 在庫を合わせる | 品目、実際の在庫数、日時 | 差分を調整として記録。使用数へ加算しない |
| 誤入力を取り消す | 対象の記録 | 記録を取消状態にし、在庫・使用集計を戻す |
| 過去の実績を見る | 品目、年 | 1〜12月の使用数、年間合計、使用履歴を表示 |

使用・補充の数量は正の整数、初期在庫・実際の在庫は0以上の整数とする。
単位は「個」「本」「枚」「袋」「ロール」等、利用者が品目ごとに決める。
同じ品目では同じ単位を使い、使用履歴がある品目の単位変更は許可しない。
液体の残量、開封中の割合、箱から個への自動換算は初期版では扱わない。

例: 架空の「サンプル消耗品」を10個で登録し、3個補充して2個使用すると現在庫は11個。
年間使用数は2個で、初期在庫10個と補充3個は使用数へ含めない。
使用の2個を取り消すと現在庫は13個、年間使用数は0個へ戻る。

## 画面

一覧を主画面とし、品目名・現在庫・今年の使用数を1行に表示する。
各行に「使用」「補充」を置き、品目名から集計・履歴へ移動する。
品目追加、使用、補充、在庫調整は必要な入力だけの小さなフォームにする。

```text
在庫照会                              [品目を追加]
[品目名で検索]

品目                  現在庫     今年の使用数     操作
サンプル消耗品        11 個       2 個          [使用] [補充]

品目を選択 → 詳細
サンプル消耗品       現在庫 11 個
[2026年 ▼]           年間使用数 2 個
[1〜12月の使用数を棒グラフで表示]
[同じ12か月の数値表]
日時                  種別       数量           [取消]
```

グラフは選択した品目だけを対象とし、使用のない月も0で表示する。
単位の違う品目を合算した「全品目の使用総数」は表示しない。
集計表を併設して、グラフだけに情報を依存させない。
対象年を変更しても在庫は現在時点の数とし、「現在庫」と「対象年の使用数」を区別する。
一覧から戻る際は検索条件・選択元・スクロール位置を復元する。
フォームの戻る・背景・閉じる・Escは共通の閉じる処理へ接続し、未保存入力・送信中を保護する。
詳細は[画面遷移仕様](../docs/navigation-and-dialogs.md)に従う。

デザインは機能・データ設計を先に確定し、実装をGitへPushした段階で調整する。
既存サービスのロゴ、アイコン、ブランド資産は変更しない。
共有、家族アカウント、発注、金額管理、写真、バーコード、通知、消費予測は初期版に追加しない。

## データと集計

独立したCloudflare WorkerとD1を使用する。R2、Queueによる在庫処理、Containerは不要。
候補: Worker `t-room-inventory`、D1 `inventory-db`、URL `https://tanaka-note.com/inventory/`。
公開先は実装時に`web-apps.json`へ登録し、対象限定のbuild同期・公開手順へ追加する。

| テーブル | 主な項目 | 役割 |
|---|---|---|
| `inventory_accounts` | id、display_name、is_active、session_version | 初期版はownerの1件のみ。氏名は本番作成時に入力 |
| `inventory_items` | id、account_id、name、unit、stock、version、archived_at | 品目と現在庫。更新versionで競合を検知 |
| `inventory_movements` | id、account_id、item_id、kind、quantity_delta、occurred_at、created_at、voided_at、request_id | 初期在庫・補充・使用・調整の履歴と再送防止 |

`quantity_delta`は初期在庫・補充が正、使用が負、調整は正または負。
初期在庫0の登録も扱う。取消は履歴を物理削除せず、元の記録へ`voided_at`を設定する。
在庫は有効な履歴の差分合計と一致し、品目更新と履歴更新を同一トランザクションで確定する。
使用集計は`kind=use`かつ取消されていない記録だけを対象とする。
使用数は`-quantity_delta`の合計とし、補充・初期在庫・調整を混入させない。

日時はUTCで保存し、入力・表示・月別／年別の境界は日本時間（Asia/Tokyo）に統一する。
使用日時の既定値は現在時刻。過去の日時も入力できるが、未来の実績は拒否する。
集計年は1月1日から翌年1月1日未満。例えば日本時間の1月1日0時は新年へ含める。
過去の記録を追加・取り消した場合は、その記録の月・年へ反映する。
初期版の現在庫は現在までの有効な差分合計で、過去日の在庫推移グラフは提供しない。
利用者・品目・発生日時で索引を設け、選択年の対象品目だけを集計する。

在庫不足の使用、取消によって現在庫が負になる操作は全体を拒否する。
二重タップ・応答消失後の再送は`request_id`の一意制約で1件に限定する。
同じIDで内容の異なる再送は競合として拒否し、失敗時に在庫だけ／履歴だけを更新しない。
別タブから同時に使用しても在庫が負にならないよう、DBの条件付き更新・制約で保証する。
誤入力は取消後に正しい記録を追加する。取消不能な補充は事情を表示して在庫調整へ案内する。
在庫調整は入力時のversionを確認し、途中の使用を上書きする場合は再読み込みを要求する。
初期版は履歴や品目の完全削除を提供せず、在庫0の品目をアーカイブして過去の集計を保持する。
取消によって在庫が戻ったアーカイブ品目は自動的に通常一覧へ戻し、再び使用できるようにする。

## 認証・暗号化（承認済み）

### アカウントとパスキー

- 在庫照会専用のownerアカウントを1件作成する。氏名は本番D1への初期設定でのみ入力し、migrationやソースへ固定しない。
- ローンチ後、本人がSecurity Centerで既存の第一管理者Identityへこのアカウントを紐づける。新しいIdentityやパスキーの自動作成は行わない。
- 連携前はログイン案内だけを表示し、在庫データの読み書きを拒否する。公開登録、共通の仮パスワード、公開bootstrap APIは作らない。
- ownerへの連携は第一管理者Identityだけに限定し、直近5分以内の管理者パスキー再認証をサーバー側で要求する。
- Security Centerの明示的なservice registry・allowlist・Service Bindingと、Inventoryの`SecurityIntegration` providerを追加する。連携候補は本番DBの有効accountから取得する。
- 60秒・一回限りのhandoffを引き換え、Inventory独自の署名鍵とCookieでサービス固有sessionを発行する。別サービス用handoffを拒否する。
- 現行の共通パスキーsession仕様を使う。正常な実操作時だけ12時間rolling更新し、pollingや静的ファイルでは延長しない。Secure・HttpOnly・SameSite=Strictを適用する。
- 保護APIごとにInventory accountとSecurityのIdentity・credential・service link・epoch・session台帳を検証し、停止・解除・ログアウト後の利用や再送を拒否する。
- session署名鍵はサービス専用の暗号学的乱数をWrangler Secretで管理し、Git・ログへ保存しない。
- 既存の第一管理者PW復旧経路を維持する。パスキー紛失時はSecurity Centerの既存招待・承認で復旧し、Inventory独自のPW認証や鍵復旧を増やさない。

既存パスキーのRP、登録・承認方式、他サービスの認可、T-Cloudの暗号鍵は変更しない。
Identityとサービスaccountの役割は[共通Identity仕様](../docs/security/passkeys.md)に従う。

### 最小限の暗号化

通信はHTTPS/TLS、保存はD1標準の保存時暗号化を使用する。
Cloudflareの[公式D1仕様](https://developers.cloudflare.com/d1/reference/data-security/)では、
DB・metadataは保存時に自動暗号化され、WorkerとD1間もTLSで保護される。
この構成ではCloudflare管理の鍵を使用し、Cloudflare上のWorkerで在庫データを平文として処理する。
Cloudflare運用者にも内容を見せない端末内暗号化／E2EEは初期版に含めない。
その要件が必要になった場合は、集計・端末間共有・紛失時復旧を含む別の設計承認が必要。

### Gitとログからの個人情報漏洩防止

- 実氏名、メール、在庫、使用日時、Identity対応表、本番DB dumpを新規ソース・テスト・文書・PR本文へ入れない。
- migrationはschemaだけ。ownerの表示名は本番初期設定時の標準入力等から渡し、出力・追跡ファイルへ残さない。設定用一時ファイルが必要な場合はignoreされた領域へ限定して作業後に削除する。
- テストは架空の氏名・品目・履歴を使用する。実ユーザーデータでブラウザTraceやスクリーンショットを取得しない。
- 環境ファイル・ローカルD1・Secretは既存Git除外を適用する。公開前に今回の差分と追跡対象を検査する。
- ログにリクエスト本文、品目名、数量、認証情報を出さない。共通監査へは必要な認証イベントと安全な識別子だけを送る。
- 保護APIはno-storeとし、認証応答・在庫・使用履歴をService Workerや公開cacheへ保存しない。
- 同一originの検証、CSRF対策、CSP、入力制限、account境界、共通LINEブラウザ制限を適用する。

## 実装と公開の順序

1. この認証・暗号化案の承認後、schema、在庫・履歴API、集計、基本UIを実装する。
2. Security CenterへInventoryの明示的な連携・監査・session検証を追加し、既存の認証方式を回帰確認する。
3. `web-apps.json`へInventoryを登録し、安全な自動更新、未保存入力／送信中の更新延期、対象限定verify・releaseを組み込む。
4. 架空fixtureでローカル検証・必要なbuildを通し、Git commit／pushとPRのCI確認を行う。
5. 個人データのないschemaを専用D1へ適用し、Secret・単一ownerを安全に設定する。Securityの`0022_inventory_service.sql`は既存全行・cloud scope・暗号化済みenvelopeを保持してサービス制約を拡張する。在庫データは既存DBへ保存しない。
6. 相互Service Bindingの初回作成順をdry-runで確認する。必要な場合はデータAPIを閉じたInventoryを先に作成し、Security、Inventoryの順で連携対応を公開する。
7. 公開先のbuild一致と未認証アクセス拒否を確認する。本人がローンチ後にパスキーを紐づける。

## 実装時の必須検証

- 初期在庫・補充・使用・調整・取消で在庫と履歴が一致する。使用以外は使用集計へ入らない。
- 在庫0、在庫不足、同時使用、二重送信、内容の異なる再送、トランザクション失敗、古いversionでの在庫調整を検証する。
- 日本時間の月末・年末、0件の月、過去日時、取消、異なる単位、アーカイブ品目を含む集計を検証する。
- 未認証・別account・無効Identity・解除済みlink・再利用handoff・別サービスhandoff・期限切れ／ログアウト済みsession・署名鍵未設定を拒否する。
- Inventory ownerを第一管理者以外へ連携できないこと、再認証と既存の招待・承認を迂回できないことを検証する。
- PC・タッチの代表fixtureで登録→補充→使用→取消→集計、フォームの未保存保護、戻ると一覧位置復元、自動更新延期を確認する。
- 新規verify profile、Web build registry、Service Worker cache除外、秘密情報のGit除外を契約テストで確認する。
- 本番はbuild一致・安全な読み取り・未認証拒否を中心に確認し、実使用データを試験で変更しない。

対象限定の検証・公開は[開発フロー](../docs/development-flow.md)に従う。
パスキーの本人端末操作はローカルfixtureと区別して報告する。

## 開発・初回設定

```sh
node tools/verify.mjs --target inventory --browser --build
node tools/sync-web-app-builds.mjs --target inventory
npm run release -- inventory
```

`inventory-worker`で`wrangler d1 migrations apply inventory-db --remote`を実行する。
初回Worker作成後、`node tools/bootstrap.mjs --remote`の標準入力へ
`{"displayName":"<本番だけで設定する表示名>"}`を渡す。
helperは未設定の場合だけ独立したランダムSESSION_SECRETを設定し、ownerを1件作成する。
Secret・氏名は出力せず、SQL用のOS一時ファイルを処理後に削除する。
個人データを入力した設定ファイル・実行履歴をGitへ追加しない。
通常のコード公開でbootstrapを再実行・Secretをローテーションする必要はない。

## セキュリティ改善レビュー（2026-10-16、Draft・本番未反映）

### P1: 認証handoffのRate Limiting（手動反映待ち）

対象は `POST /inventory/api/passkey/handoff`。Cloudflareのルール本体はこのリポジトリで管理していない。
監査依頼で示された既存ルール名は **T-lain authentication burst protection**、条件は **20 requests / 10 seconds、10 seconds block**。
今回の読み取り専用MCPによる `/zones?name=tanaka-note.com` 取得はポリシーで拒否され、現行の式・計数式・除外条件は独立確認できていない。
書き込み可能な経路へ切り替えず、Cloudflareの設定変更・ルール新規作成・上書きは行わない。

本番担当者は既存ルールをエクスポートし、共通のhost／method／IP除外条件を残して、**現在の認証パスのOR列挙に次の実式を1件追加**する。

```text
http.request.uri.path eq "/inventory/api/passkey/handoff"
```

変更後の式の構成は次の通り。`C` は現行の共通条件、`P` は現行の認証パス条件を一文字も変えず保持したもの。
これは差分の定義であり、`C`・`P`を置換していない文字列をCloudflareへ貼り付けてはいけない。

```text
変更前: C and (P)
変更後: C and ((P) or (http.request.uri.path eq "/inventory/api/passkey/handoff"))
```

現行式が別の形なら、上記へ勝手に正規化せず、同じ共通条件内のパス列挙だけへ追加する。
計数式がパスを別途列挙している場合も、同じ条件下へ同じ1件を加える。
しきい値20、期間10秒、block 10秒、計数単位、他のパス、除外、ルール順序は維持する。
現行式を取得できていないため、**そのまま適用できる完成した全体式は未確定**。現行式と変更後の全体式の差分レビューを本番反映の前提とする。
反映後はこのパスの通常の一度限りのログインだけを確認し、本番でのburst試験は行わない。

### P2・P3: クライアントの失効・エラー境界

ログアウトと、Content-Typeに関係しない401で、フォーム・一覧・詳細・メモリ上の品目・操作再送情報・スクロール位置・opener参照を解除する。
フォーム値とdirty／busy状態をリセットし、URLと現在のHistory stateから品目・年・dialog状態を取り除く。
失効前の通信をabortし、世代番号でも古い応答・描画・finally処理を排除して再ログイン後の画面へ戻さない。
通常のdialog終了時には編集対象・opener参照を解除し、フォーム初期化は次回の編集開始とセッション終了時に行う。認証・Cookie・rolling sessionの仕様は変更しない。

APIはContent-Typeを確認し、JSONでも空・不正な応答は安全な固定メッセージへ変換する。
429は再試行を案内し、HTML・text/plain・ネットワーク例外・未知のJSONエラー本文を表示しない。
既存Workerの固定された公開用HttpErrorメッセージだけを許可する。将来そのメッセージを追加する場合は、クライアントの許可リストと境界の契約試験も更新する。
在庫ロジック、D1スキーマ、requestIdの意味、フォームの数量・日時制約は変更しない。

### P4: Chromium／WebKitの共通fixture

`test/inventory.browser.mjs` は `TROOM_BROWSER=chromium`（既定）と `webkit` の同じ操作をPC・タッチで実行する。
datetime-localが秒00を省略する既存挙動には送信時だけ`:00`を補い、APIの日時検証・JSTの意味は変えない。明示的な秒00の入力も共通試験へ含める。
登録・補充・使用・調整・取消・集計、戻る／進む・位置復元、dialog・Esc・背景タップ・未保存保護、ログアウト／401／再ログイン、XSS、Cookie属性、横スクロールとpage errorを確認する。
beforeunloadは全ケースでハンドラを確認し、PCでは実際の再読み込みを取り消して入力の保持も確認する。
タッチ端末のブラウザ終了時にbeforeunloadが必ず発生するとは扱わない。
パスキーの端末操作だけは合成authenticatorへ差し替え、引換え・署名Cookie・Security台帳はfixtureの実装を通す。
実機Safari／iOSのWebAuthn・OS終了操作とは区別する。本番データ・本番パスキーをTraceへ渡さない。
CIでのWebKit導入・追加実行はInventoryターゲットだけのmacOS 15ジョブに限定し、最終verifyの必須結果に含める。
InventoryのPlaywrightは専用packageで1.64.1に固定し、他サービスの共用1.56.1と独立させる。Chromium導入とTraceのpreloadも同じ専用packageへ接続する。
Windowsの旧共用Playwright 1.56.1 WebKitでは、独立した最小Set-CookieサーバーでもStrict CookieがAPI上Noneとなり、cross-siteで送られる挙動を再現した。
Windows WebKitでStrict属性を取得できない環境だけSameSiteの実送信試験を明示的にskipし、WorkerのStrictヘッダーとHttpOnly／Pathは確認する。
macOS CIではskipせず、CookieのStrict属性とcross-site navigationが401となる実挙動を必須にする。Windowsの操作試験だけでSafariのSameSite確認済みとはしない。
Ubuntu 24.04のWebKit build 2215では、修正版・main版ともTraceなしの同じ操作後のreloadでC++の`std::optional`内部assertionが発生した。
macOS 15の旧共用1.56.1でも同じreloadでPage crashedとなった。この既存の組合せでの失敗を成功扱いにせず、専用1.64.1によるSafari向けの必須検証をmacOS上へ分離する。Linuxの単体・Chromium検証は継続する。
比較結果は[CI診断run](https://github.com/tanaka-note/t-room-site/actions/runs/38855682935)に保持する。ブラウザ内部のassertionの根本修正や実機Safari検証は本PRの確認範囲外。

```powershell
node tools/verify.mjs --target inventory --browser --build
$env:TROOM_BROWSER = 'webkit'
node inventory-worker/test/inventory.browser.mjs
Remove-Item Env:TROOM_BROWSER
```

### P5: Observability（調査済み・無効を維持）

`observability.enabled=false` を維持する。Cloudflareの[Workers Logs仕様](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)では、
Invocation LogsにRequest／Responseと関連metadataが入り、FetchのmessageはmethodとURLを含む。
`logs.invocation_logs=false` でInvocation Logsを停止できるが、console等のログに付く関連metadata・例外の収集まで、必要な固定フィールドだけへ制限できることは確認できていない。
サンプリングは情報の削除にならない。今回、リクエスト情報・handoff・Cookie・品目・数量等の混入を避ける要件を優先し、有効化しない。
「Never log exception messages」を維持し、DB例外・レスポンス本文・新しいconsoleログも追加しない。

当面はHTTPステータス／失敗率の集計、既存の固定schemaのSecurity監査、ローカル再現fixtureを調査手段とする。
将来必要なら、rawなrequest／exception／console本文を保存せず、service・version・固定operation・固定result・timestampだけを投影する経路を別途設計し、metadataを含めて保存前の境界試験を行う。
本PRはログ用binding・Tail Worker・外部転送先・課金を伴う収集設定を追加しない。

### P6: request recordの長期蓄積（設計と回帰試験のみ）

現時点では**削除しない**。Cron、利用時cleanup、maintenance API、migrationを追加しない。
requestIdは発行時刻を検証できないUUIDなので、90日を経過した行の削除だけでは、古い同一リクエストが新規操作として再実行される。
`inventory_movements`にもrequestIdとの永続的な対応はない。movementを残すだけでは重複を検出できない。
不明な復元条件で削除するより、単一利用者の冪等性を全期間維持する。

`response_json`は現在、品目／movementのID等の小さな操作結果であり、在庫名・履歴一式ではない。
まずレコード数とDBの保存容量だけを監視し、容量上の必要性が生じた時に次の設計を審査する。

1. `(account_id, request_id)`とfingerprint、同じ結果を返せる最小情報を**無期限のtombstone**として保持する。古いキーを忘れるTTL削除は認めない。
2. 将来、大きい応答を保存する場合だけpayloadを段階的に圧縮・分離し、tombstoneと対応情報の移行を同一トランザクションで確定する。現行の応答は既に小さいため当面は不要。
3. maintenanceは通常操作から独立し、失敗しても通常の操作を停止・部分更新しない。直近90日は対象外とし、未来日時／境界／同時再送／変更内容の再送／失敗ロールバックをfixtureで先に試験する。
4. movementと在庫値は削除・再計算しない。schemaを変える必要がある場合は、別PRで移行・ロールバックを提示する。

今回の回帰試験は古いrequest recordをfixture内で2000年へ遡らせ、同じ内容は同じ結果・在庫不変、異なる内容は409、movement増加なしを確認する。
未実装のcleanupの成功・失敗を確認済みとは扱わない。
