# 請求書高速化と共通認証性能調査（2026-10-24）

対象は `tanaka-note/t-room-site`、比較元は作業開始時の最新main `b71a02d`。Billingの実装・関連テストだけを変更した。Security Worker・共通認証ライブラリ・schema・migration・本番設定は変更していない。mainへのマージ、本番公開、本番DB操作は行っていない。

## 原因と今回の変更

パスキー本人確認後も、従来の `enterApp()` はaccountsとsummaryを順番に待っていた。それぞれの前面GETが `readSession → readSession → touch` を実行し、各read/touchがSecurity D1にもアクセスする。`/api/session` も更新対象外なのに2回readしていた。OSのWebAuthnそのものが遅いかは未測定であり、原因と断定しない。

Summaryの管理者経路は、対象存在確認、対象名称取得、当月明細、当月入出金、月初・月末の書類集計2本、月初・月末の入出金集計2本の計8本を逐次実行していた。前面GETの認証・Cookie更新の3本を加えるとBilling SQLは11本になる。小規模データでは索引不足より通信と認証の重複が目立つ構造だった。

- GETの最初の検証結果は、fetch内のPromiseだけで再利用する。リクエストをまたぐキャッシュはない。
- 最終処理の対象を共通 `foregroundSessionActivity()` と一致させ、session、認証、エラー、非前面通信では追加の更新検証をしない。
- 前面rolling GETは最終 `touch` のlive Identity/credential/link/epoch/ledger検証を残す。その後Billing accountのactive/role/versionとglobal versionを再確認してから署名・Cookieを発行する。
- legacy GETにはtouchがないので最後のreadを残す。POST/PUT/DELETEも最後のreadを残す。途中で無効になったsessionがnullの場合、用意済みの成功bodyを返さず401にする。
- 既存 `/api/accounts?includeSummary=1&month=YYYY-MM` へ初期Summaryを同梱する。通常のaccountsとsummaryは互換性を維持する。初期対象はサーバーが認可した一覧の先頭（一般利用者は本人）で、同じリクエスト内の対象情報を再利用する。旧accounts応答にはUIが従来のsummary取得で対応する。
- Summaryの対象確認と名称取得を1本にし、各テーブルの月初・月末を条件付きSUMで統合する。当月一覧2本＋集計2本をD1 batchにまとめる。業務SQLは8→5本、認証込み11→7本。初期同梱経路はaccounts一覧の対象を再利用するため同じ7本で一覧とSummaryを返す。
- 金額の符号、incomeの除外、deleted_at、offsetの残高影響ゼロ、月の日付境界、端数処理は維持する。新しい金融データの永続キャッシュはない。
- アカウント/月の変更時に旧明細・残高を消して読み込み状態を表示し、印刷・編集開始・入出金履歴を一時無効化する。AbortController、世代番号、session一致、応答のaccount/月一致で古い応答を排除する。書類種別は描画時の最新選択を使う。401では保有データとsessionを破棄してログイン画面へ戻る。

ログイン成功・session復帰の同期監査、管理者アクセスの既存Queue監査、Cookie属性、12時間rolling、Passwordログインの恒久拒否は維持した。

## 計測条件と限界

Windows、Node 24.19.0、既存PlaywrightのChromium（このPCではEdge実行ファイル）、ローカルHTTPとin-memory SQLite。全migrationを適用した合成DBに5利用者、書類120件、入出金60件を投入した。本番データは使っていない。

Worker計測は実handlerと実Security RPCメソッドを使い、D1 bindingをSQLite adapterへ置換した。同期audit helperは実コードだが、Security監査保存とQueue送信はmockなのでその実DB負荷・通信は含めない。WebAuthnとhandoff token消費の外部通信はmock。未使用のWebAuthnサーバー関数は呼ばれたら失敗するstubへ明示置換し、Security用の外部パッケージがないBilling単独CIでも実行できる。実Securityのregister/read/touch、Billingのsession署名・Cookie生成は実行する。

`performance-fixture.mjs` は読み込んだWorkerソースをメモリー内だけでラップし、readSession、session発行、最終更新、同期audit helper、SQL、Security呼び出しを `performance.now()` で測る。runtimeや共通コードには計測変更を加えていない。計測出力は固定endpoint名、処理名、回数、時間、SQL実行計画だけで、Cookie/token/credential/Identity/金額/明細/鍵を出力しない。

Workerは各endpoint 5回warmup＋30回の中央値。ブラウザはPC 1280×900とタッチ390×844で、WebAuthn stub完了から描画後2 animation frameまでのログイン10標本（warmup2回除外）、全5アカウント切替15標本。数十msのブラウザ結果にはframe待ちと測定揺らぎが含まれる。改善率はこのローカル標本の比較であり、本番の改善率ではない。

### 修正前後

| 対象 | 修正前 | 修正後 | 削減率・観測結果 |
| --- | ---: | ---: | --- |
| ログイン後描画 PC（WebAuthn stub） | 51.0 ms | 41.6 ms | 18.4% |
| 同 スマートフォン相当 | 54.9 ms | 43.9 ms | 20.0% |
| アカウント切替描画 PC | 27.8 ms | 27.6 ms | 0.7%、実質小差 |
| 同 スマートフォン相当 | 28.2 ms | 28.0 ms | 0.7%、実質小差 |
| Summary handler | 4.712 ms | 3.871 ms | 17.8% |
| accounts単独 handler | 4.793 ms | 3.567 ms | 25.6% |
| session handler | 3.885 ms | 2.810 ms | 27.7% |
| handoff handler（外部引換・監査保存mock） | 3.050 ms | 2.801 ms | この段階の主要処理は変更なし |
| 初期同梱accounts handler | 対応なし | 3.622 ms | 旧accounts単独との比較不可 |
| 前面GETの認証RPC | read×2＋touch×1 | read×1＋touch×1 | 3→2、33.3% |
| sessionの認証RPC | read×2 | read×1 | 50% |
| Summary Billing SQL（認証含む） | 11 | 7 | 36.4% |
| Summary Security SQL（監査除く） | 13 | 9 | 30.8% |
| 初期データのHTTP通信数（handoff/session除く） | 2 | 1 | 50% |
| 初期データの認証RPC合計 | 6 | 2 | 66.7% |
| 初期データのBilling SQL合計 | 15 | 7 | 53.3% |
| 初期データのSecurity SQL合計（監査除く） | 26 | 9 | 65.4% |
| 実端末WebAuthn本人確認 | 未測定 | 未測定 | 本人操作なし |
| 本番ブラウザ/API通信/Worker wall time | 未測定 | 未測定 | 本番計測設定の変更なし |

### 処理の分離（ローカル中央値、ms）

| 処理 | Summary前 | Summary後 | session前 | session後 |
| --- | ---: | ---: | ---: | ---: |
| readSession合計（内包するRPC/SQLを含む） | 2.254 | 1.243 | 2.777 | 1.617 |
| Security RPC合計（同一process内） | 1.430 | 1.021 | 1.054 | 0.568 |
| Billing SQL実行合計 | 0.706 | 0.636 | 0.178 | 0.117 |
| 最終更新（内包する再検証/touch/署名を含む） | 2.393 | 1.243 | 1.397 | 0.012 |
| session発行関数（更新Cookie用） | 0.270 | 0.305 | 対象外 | 対象外 |
| 同期audit helper（保存mock） | 対象外 | 対象外 | 0.636 | 0.686 |

内包関係があるので各行は足し合わせない。handoffのsession発行は1.378→1.285ms、同期audit helperは0.617→0.531ms。これらは外部監査保存の時間を表さない。実Security Service Bindingのネットワーク時間、実D1アクセス時間、実監査保存時間、Worker CPU/wall timeは未測定。

ブラウザResource Timingの最終ログイン標本では、PCのhandoff/accounts/summaryは修正前5.8/6.2/7.4ms、修正後handoff/accounts同梱は5.2/7.3msだった。スマートフォン相当は修正前10.5/4.7/5.3ms、修正後6.4/6.4ms。これは単一標本のローカルHTTP通信（body受信を含む）で、Workerのwall timeと同一視しない。

## SQL・batchの比較

現行migrationのEXPLAIN QUERY PLANでは、当月明細は `idx_billing_entries_account_date`、書類集計は `idx_billing_entries_active`、入出金の一覧・集計は `idx_billing_settlements_account_date` を使う。入出金一覧にはORDER BY末尾の一時B-treeが残る。小規模データで追加索引の効果を裏付ける根拠はなく、索引・DB構造は変更していない。書類・入出金の履歴集計はそれぞれ2走査から1走査へ減った。

同じ最適化後SQLをSQLite adapterで逐次await、Promise.all、transaction batchとして比較したSummary中央値はそれぞれ3.078、2.937、3.871ms。ローカルにはD1とのネットワークがないため、batchが最速という結果ではない。単純な並列化を改善効果の根拠にはしていない。

採用理由は、実測でSQL本数を減らせたことに加え、一覧と集計4本のデータベース呼び出しを1回にまとめて一貫したtransactionで読むため。D1 batchの順次実行・transaction・一括呼び出しの仕様は[公式D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)を参照。本番ネットワークでのbatch単体の効果は未測定。

再実行例（すべてローカルfixture）:

```powershell
node billing-worker/test/performance-benchmark.mjs --baseline=b71a02d
node billing-worker/test/performance-benchmark.mjs --initial-data
node billing-worker/test/performance-benchmark.mjs --batch-mode=sequential
node billing-worker/test/performance-benchmark.mjs --batch-mode=parallel
node billing-worker/test/performance.browser.mjs --baseline=b71a02d
node billing-worker/test/performance.browser.mjs
```

## 失効検知の境界と回帰

データはメモリー内でJSON responseにした後、最終touchとBilling account再照合が成功するまでfetchから返さない。touch中にcredential無効化、Identity停止、link解除、epoch変更、ledger終了/期限切れ、Security障害が判明した場合は401のみ返し、財務bodyとCookieを返さない。Billing account無効化/role変更/version変更、global version変更も最終Cookie生成で拒否する。初回read前の同条件も拒否する。

既存の「複数DBを順番に検証する」境界は維持する。Securityのlive check後に別DBで起きる変更まで原子的に阻止する保証は従来もない。最後の検証後に起きる失効は次のリクエストで拒否する。変更操作は最後のreadを維持するが、処理中の失効によってすでに完了したwriteをロールバックする設計ではない。

追加テストは、同期auditを解放するまでhandoff/session応答が返らないこと、検証回数、read前/応答前の失効、legacy再検証、変更操作のread/read/touch、12時間rolling、古い期限切れCookieの拒否、logout再送拒否、全5対象、一般利用者の本人scope、過去月・年月境界・income・offset・正負のother・削除済み行・書類/入出金CRUD再計算を含む。独立したJavaScript台帳との突合で金融計算を確認する。

ブラウザはPC/タッチの初期表示、全対象切替、応答逆転、旧月/新月の競合、読み込み中の書類種別変更、通信失敗、401、横スクロールを確認する。transportがabortを無視するfixtureでも古い結果を排除する。既存dialog回帰も実行対象に含む。実端末WebAuthn、実スマートフォン/PWA/TWA、本番の全利用者ログインは未検証。

## Security Worker調査と次回PR

### 現在の流れ・D1アクセス

BillingのreadSessionはCookie署名/期限/global versionを検証し、Billing accountのactive/role/versionを1 SELECTで照合する。その後共通validator→serviceRollingSession(read)→Security.passkeyRollingSession→trackedPasskeySession→validatePasskeySessionへ進む。

通常の有効なBilling向けrolling RPCでは次の処理が実行される（fixtureで実メソッドのSQL本数を確認）:

| SQL/操作 | read | touch | register |
| --- | ---: | ---: | ---: |
| runtime singletonのINSERT ON CONFLICT DO NOTHING | 1 | 1 | 1 |
| runtime epoch/switchのSELECT | 1 | 1 | 1 |
| credential＋Identity＋service linkのJOIN SELECT | 1 | 1 | 1 |
| security_active_sessionsのPK SELECT | 1 | 1 | 1 |
| active_sessionsのINSERT | 0 | 0 | 1 |
| active_sessionsの条件付きUPDATE | 0 | 1 | 0 |
| 合計 | 4 | 5 | 5 |

Identity/credential/linkは個別3往復ではなくJOINで各1行を照会する。`validatePasskeySession`単独は3本。endはvalidationを通らずledgerのSELECTと終了UPDATEの2本。Securityローカルのidentity/admin read/touchには既にruntime・Identity・credential・ledgerをJOINしてledgerを再利用する経路があり、正常時read=1本、touch=2本。これはBilling等から呼ばれるサービス用経路とは異なる。無効入力・欠損・失効・停止・初期化fallbackでは本数が変わる。

`observePasskeyRuntime()` のINSERTは「初回だけ」の処理ではなく、Billing向けの通常read/touchごとに実行される。修正前の前面GETでは3回、修正後も2回実行される。singletonがある場合の実変更行数・課金write行数・ロック待ちは未測定で、SQL実行回数と混同しない。global switchがfalseの経路では追加の条件付きUPDATEがepochを増やし、既存sessionを失効させる。

runtimeはid=1のPK、credential/Identity/linkは各PK、active_sessionsはsession_id_hashのPKを使う。lookupは狭いキー照合なので新しい索引を最初の対策にはしない。サービス用RPC全体が共通D1へ集中し、touchはledger更新も伴う。本番の待ち行列・並行数・P95・D1課金・容量・リージョン配置は未測定で、集中が実際に何msの遅延を生むかは断定できない。

### 優先順位と具体的方針

1. **P1: サービス用rolling read/touchのlive照会を統合する独立PR。** Securityローカルの既存方式を参考に、対象をBilling等の単一link経路に限定して、runtime・Identity・credential・link・ledgerを1つのSELECTで読む。取得ledgerをtrackedPasskeySessionの既存loadSession引数へ渡し、二重SELECTを避ける。通常read 4→1、touch 5→2が構造上の削減候補だが、時間の効果は別PRで実測する。readとtouchそれぞれで新しく取得し、リクエスト間cacheや先行readの認証省略を導入しない。Cloudのfolder snapshot/PRF/鍵委譲経路は別扱いにし、単純にサービス横断コピーしない。
2. **P1: runtime初期化を通常経路から外す案を上記と一体で評価。** 通常の有効rowはJOINで読み、missing時だけ既存observe→再読込のfallbackを行う方式が現行互換に近い。requestedEnabled=falseでは必ず既存observe(false)を通してepoch増分を維持する。observed=falseをtrueに自動復帰させない。並行初期化は既存INSERTの競合耐性を残す。DBエラー、再読込後の欠損、状態の不整合は拒否する。
3. **P2: migrationだけでsingletonを保証する案は別途判断。** migrationで初期rowを作るだけでは、既存DBへの未適用、初期row欠落、削除後の復旧、緊急停止とepoch履歴を保証できない。単純にINSERTを削除する提案は確定しない。欠損時にepoch=1へ戻して古いsessionを再有効化しないことが必須。fallback維持案と、欠損時fail-closed＋管理者復旧案を比較し、復旧手順・既存session移行・承認を整えてから採否を決める。
4. **P2: 同期監査の内訳を別計測する。** ログイン成功/session_resumeのイベント生成、監査重複抑止、保存、last_seen反映、必要なsession追跡を分離して計測する。今回これらの本番所要時間は不明。単に非同期化・省略せず、同期完了の意味とQueue補完のevent IDを維持する。認証情報の外部送信や詳細本番loggingの独断有効化は行わない。

次回の必須テスト: 初期singletonなし/あり、同時初期化、false観測の一回限りのepoch加算、再有効化、明示的epoch変更、DB障害、Identity/credential/linkの停止と解除、role/version/scope取り違え、ledger終了・期限、touch前後の失効競合、ログアウト対touch、MAX期限の単調性、旧legacy Cookie、監査遅延での復活拒否。変更するサービスごとに実handlerの失効回帰を通し、Cloudのfolder scopeは専用回帰を別途要求する。生token/IDを出力しないSQL/RPCカウンタで旧新を比較し、fixture後に承認済みの最小本番readでP50/P95を確認する。

### 今回の修正後も残る遅延

Billingの前面GETは依然readとtouchの2 RPCを待ち、Security D1は計9本（うちruntime INSERT2本、ledger UPDATE1本）を実行する。Billingは最終account再確認とCookie署名も待つ。初期のsession復帰とパスキー新規ログインは同期監査を待つ。WebAuthn、Securityのoptions/verify/handoff通信、監査保存、実D1の往復時間は今回最適化していない。

## 検証・GitHub

実行結果:

- `npm run verify:changed`: site/billing成功。既存差分判定が共通テストfixtureをsiteへ分類するため、公開サイトの標準回帰・visual・Web更新契約・dry-runも実行した。
- 最後の書類種別ラベル修正後の `npm run verify:billing`: 成功。構文、Billing 56テスト（追加29、skip 0）、性能/競合/失効のPC・タッチブラウザ、既存dialogの戻る/進む/背景/未保存保護、共通パスキー選択dialog、Worker dry-runを含む。
- `node --test tools/test-password-auth.mjs`: 20成功、skip 0。旧ID/PWと旧Cookieの拒否、本人scope、既存データ維持を含む。
- 前後benchmark、SQL実行計画、逐次/parallel/batch比較: 成功。baseline/currentのブラウザfixtureも成功。
- 初回GitHub CIはBilling単独jobで未使用のWebAuthn依存がなくfixture importに失敗した。runtimeとCI設定は変えず、上記の呼出禁止stubで依存を分離して修正した。
- `node tools/check-web-app-builds.mjs --target t-room-billing`、`git diff --check`: 成功。Billingのみbuildを同期し、最終markerは `billing-c2fa58fb86f2`。

PR URL、commit IDとCI結果はPRと完了報告を参照する。変更ファイル:

| パス | 内容 |
| --- | --- |
| `billing-worker/src/index.js` | 同一GETの再利用、最終検証、初期データ同梱、集計SQL |
| `billing-worker/public/billing.js` | 初期取得と切替競合・失敗・読み込み表示 |
| `billing-worker/public/index.html` | 既存report内の状態表示、Billing build marker |
| `billing-worker/test/performance-fixture.mjs` | 合成SQLite/実Securityと安全なローカルprofiler |
| `billing-worker/test/performance-benchmark.mjs` | 前後・SQL実行計画・batch方式比較 |
| `billing-worker/test/performance.test.js` | 認証・失効・同期監査・金融回帰 |
| `billing-worker/test/performance.browser.mjs` | PC/タッチ表示・競合・前後計測 |
| `billing-worker/test/dialog-navigation.browser.mjs` | 既存Billing verifyへ新ブラウザ回帰を接続 |
| `billing-worker/test/session-policy.test.js` | 検証helperの引数更新へ追従 |
| `tools/test-password-auth.mjs` | D1 mockがSELECT batchのresultsを返す修正 |
| この報告書 | 原因、結果、次回Security改善案 |

Securityと他サービスのruntimeは変更していない。作業中にmainへ入ったT-Cloudの変更は、このPRの変更範囲に含めない。

将来の公開対象は `t-room-billing`、URLは `https://tanaka-note.com/billing/`。今回はPR作成まで。本番公開の承認後に対象CI成功、最新mainとの差分、Billing build一致、既存のPassword専用化に関する全利用者の本番パスキー準備条件を確認する。migration/Secret変更/Security同時deployは不要。旧新UI/Worker混在はaccounts-only fallbackで対応する。
