# Passwordログインの失敗監査

Cloud・Diary・BillingのPassword認証結果、HTTP status、既存の試行制限・停止ポリシーは維持する。Passkey、session、暗号方式・鍵管理は変更しない。

## 配送と追跡

Password拒否は`await recordSecurityAudit`でSecurity Service Bindingへ同期保存し、失敗時だけ同じevent IDでQueueへ送る。Security D1はevent IDで再送を重複排除する。両経路の障害では認証を成功させず、従来の拒否結果を維持する。Workersログの`Security audit delivery`に`sync_failed`／`delivery_failed`とservice、eventType、event ID、検証済みの相関IDだけを出す。例外本文や認証入力は出さない。

ブラウザは送信ごとにランダムUUIDを生成し、`X-Login-Correlation-ID`でauth-mode／loginへ渡す。Service Workerは既存のPOST通信をネットワークへ通し、WorkerはUUID v4形式だけを監査detailsへ追加する。相関IDは認証・認可には使用しない。

各サービスの`POST /api/password-login-audit`は、同一Origin、JSON、実body最大1024 byte、固定schema・enum、UUIDを要求する。サービスはURLから決まり、ID・Password・authProof・自由文・例外・form bodyは受け付けない。`PASSWORD_AUDIT_RATE_LIMITER`はサービス別namespaceで接続元ごと30件/60秒を設定する。認証用のD1カウンタとは独立する。binding障害では503、上限超過では429で監査受付を止める。この制限はWorkersのrate limit bindingの範囲で働く。

イベントは次のとおり。

| eventType | 意味 |
|---|---|
| `password_login_submit` | フォーム送信操作の端末申告。認証成功・失敗件数へ含めない |
| `password_login_client_failure` | サーバー認証判定以外の端末側失敗。`reportedBy=client`。本人・IDは推定しない |
| `password_login_failure` | WorkerのPassword拒否 |
| `login_blocked` / `login_locked` | 既存のロック・制限イベント。失敗reasonを追加 |

端末申告はSecurity CenterのPassword履歴・要注意履歴に含めるが、サーバー認証失敗の集計と混同しない。HTMLのrequired検証でsubmit handlerが呼ばれない場合も、invalidイベントから記録する。通常の400/401/429拒否はWorkerが記録するため端末失敗を重複送信しない。500系レスポンス・通信異常・ログイン後の画面処理異常は端末イベントを併記できる。

## stage / reason

| stage | reason |
|---|---|
| `form_submit` | `submitted` |
| `form_validation` | `login_id_invalid`, `password_length_invalid`, `input_invalid`, `unexpected_client_error` |
| `auth_mode` | `request_failed`, `network_error`, `unexpected_client_error` |
| `credential_derivation` | `password_length_invalid`, `login_id_invalid`, `crypto_unavailable`, `credential_derivation_failed` |
| `login_request` | `network_error`, `unexpected_client_error` |
| `login_response` | `request_failed`, `unexpected_client_error` |
| `request_validation` / `authentication` (Worker) | `invalid_request`, `invalid_credentials`, `password_auth_disabled`, `account_disabled`, `login_locked`, `rate_limited`, `authentication_error` |

Cloudの8文字未満／256文字超、空／254文字超ID、Crypto・Argon2・salt等の異常は既存のcredential deriveで拒否され、`/login`に届かない。CloudのPassword accountはadmin/subadminであり、folder-memberにはPasswordログインを追加しない。停止ポリシーの`password_auth_disabled`は対象Diary／Billing accountで記録する。

## カウンタと秘密情報

資格情報を実際に照合して失敗したときは、従来のカウンタ更新後に監査を待つ。`counterUpdated`はその拒否による更新有無を示す。既存の入力拒否・未知account・Password停止・ロック中の扱いを変更しない（未知accountの更新有無はサービスの既存仕様による）。未処理の500エラーでは更新状態を推測せずnullとする。端末監査はカウンタを増やさない。Billing accountカウンタとsourceカウンタも既存更新を維持する。

監査にはaccount IDとsalt付き接続元hashを使用し、入力loginIdを保存しない。Billingの新規Password監査からも`attempted_login_id`入力を除く。過去の監査行を削除・変更しない。Password、hash、credential master、authProof、鍵、PRF、cookie、token、recovery codeはdetailsで拒否し、ネストしたobjectは保持しない。

## 保存保証の範囲

同期成功時はDB保存完了後に応答する。Queue受付成功はDB保存完了を意味せず、既存consumerのretry／DLQで補完する。両経路停止・Worker強制終了まで含む完全な保存保証や、サービスD1とSecurity D1の分散transactionはない。

署名Secret設定が不正な場合は既存の設定guardを優先し、他bindingへ触れず503で停止する。監査のためにこのguardを迂回しない。監査endpointからsessionの検証・更新やCookie発行は行わない。

端末は送信を最大2回試し、届かなければallowlistで組み直した監査項目だけをsessionStorageへ最大20件・1時間保持する。オンライン復帰／同じタブの再読込時に再送し、event IDを安定化して重複排除する。Password・ID・認証body・例外は保存しない。JS未起動、旧版、タブ破棄、完全な通信断、保存制限・保持期限超過では端末記録を回収できない。端末申告だけで実在ユーザーに帰属させない。

## 2026-10-05の事象とDiary確認

その朝の本人の入力内容・端末例外は旧実装に記録がなく、今回の修正から遡って特定できない。fixtureでは`/login`前のderive失敗と、`waitUntil`なしでの失敗監査欠落を再現した。`enqueueSecurityAudit`はQueue bindingやwaitUntil欠落時に送信せず、build／Queueエラーでも認証応答と独立するため、サーバー到達後も欠落し得た。

本番の読み取りSELECTで、Diary `wife-admin`のD1行なし、Password停止（2026-09-11更新）、Security側の有効link1件・active credential1件を確認した。Diaryの`DIARY_ACCOUNTS`と`findAccountById`はこのaccountを固定定義から解決し、管理用inspectもD1との重複を禁止している。DB行がないことは削除・restore失敗・stale linkの証拠ではなく現行仕様と整合する。account作成やlink変更による修復は不要。過去の退役linkは履歴として維持する。本番データは変更していない。

## テスト

Securityの`password-login-audit.test.js`は3サービスの本物のWorker handler、SQLite、Security同期保存／Queue replayを使用する。`password-login-client.test.js`は本物のsubmit handlerとCloud deriveを使用する。`password-login-client.browser.mjs`はChromium、実HTMLのrequired検証・本物のhandler・ローカルWorker／Security SQLiteをつなぐ。実在アカウントのPasswordや本番認証は使用しない。
