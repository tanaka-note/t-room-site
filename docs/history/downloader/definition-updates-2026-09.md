# ClamAV定義更新の導入・障害履歴（2026-09）

この文書は初回導入、当時の本番状態、rollout障害、検証結果を保存する履歴であり、現在の運用手順ではありません。現行runbookは[`downloader-worker/DEFINITION-UPDATES.md`](../../../downloader-worker/DEFINITION-UPDATES.md)を参照してください。

## Rollout障害時の照合と復旧（2026-09-13）

Cloudflareが500を返しても、サーバー側の更新作成が失敗したとは限らない。response loss・network timeout・connection reset・JSON読込失敗も同じambiguous outcomeとして扱う。2026-09-13の障害は、API 500に続きApplicationのactive IDとrollout実体が不整合となったもの。Cloudflare内部の500の根本原因は未確定。旧処理にはdurable intentとreconciliationがなく、存在しないIDで毎回停止し続けていた。

追加migration **0018_definition_rollout_intent.sql**は既存tableへ列を追加するだけで、成功image・previous/source・日時・監視履歴・認証データを保持する。API要求の前に、検証済みtarget/旧/source digest、署名検証・定義生成日時、開始日時、Application version、設定のSHA-256、既存rollout ID一覧、pending状態、送信数、照合数を永続化する。取得できたrollout IDも保存する。設定本文・token・registry password・生のレスポンスは保存しない。
### 公開と検証

本番へは0018 additive migration、Security Worker、main上のworkflow/scriptを整合する順序で公開する。既存Worker/旧workflowも追加列と共存可能。切り戻しでも0018の列やpendingを削除しない。未確定intentがある間はreconciliation非対応の旧updaterへ切り戻して実行しない。

fault-injectionテストはSQLiteで本物のSQL/CASを実行し、5xx/timeout/response loss、POST前intent、反映済み/進行中/未確認、繰り返し404と一時404、外部変更、grace、署名/鮮度/fixture gates、lease更新中の競合、直前job、terminal/未知status、送信予算、Retry-After、秘密情報保護、次回run再開を確認する。本番で故意の500/不整合は発生させない。controlledなpending/要確認状態は更新jobを正常終了して通知jobへ渡すため、Actionsの緑色だけを定義正常と判断しない。`definition_update_result`とD1/Issueの状態を確認する。

### 当時の費用前提と切り戻し候補

2026-09-06時点の対象repositoryはpublicで、使用する標準GitHub-hosted runnerは無料枠の対象。追加契約・有料runner・Cloudflare資源増量は行わない。Cloudflareは既存の付帯枠内での運用を原則とし、超過が予想される変更は事前承認を得る。付帯枠はaccount全体で共有するため、今回の更新単独では将来の請求額を保証できない。利用確認には`containersUsageAdaptiveGroups`のsandbox込みの値を使い、コンテナ内CPU値だけで請求を判断しない。請求期間・集計遅延・D1/Workers/DO/保存容量等も別に考慮する。

毎時heartbeat分離のSecurity Worker切り戻し候補は`20a798ae-d542-4810-a641-0fd0f9064dcd`。0015の追加列と履歴は保持する。旧Workerは専用heartbeatを更新しないため、GitHub側の新判定では監視停止警告が続く。これを正常扱いせず、自然発火で専用値を記録できる版へ復旧する。Container更新・定義更新workflowの再実行はこのWorker修正の公開/切り戻しには不要。
## 2026-09-06 初回導入記録

- Security migration 0014適用、Worker `20a798ae-d542-4810-a641-0fd0f9064dcd`、build `security-ec7f431cfd8e`。本番HTML/JS一致と未認証dashboard 401を確認。
- Container version 8、digest `sha256:21b2fb59ef49b9d0befa36e5e03646374ff99ba758ed9ceade01128b57569e73`。rollout `863a2dbe-ced2-4cc2-abae-ebdabbc94c5a` completed・active rolloutなし。CPU 1、memory 6144 MiB、disk 12000 MB、private network、grace 900秒の維持を読み取り確認。
- 定義の内部生成日時は2026-09-06 15:26:06 JST、有効期限は2026-09-13 15:26:06 JST。Downloader Worker `bd836330-5b09-4333-b055-0628ffcc2e2e`は今回更新していない。
- 切り戻し候補はD1 previous_image（`sha256:6c3d248dae07b77ed20ed1ea3d68e5273f9ee48aacd56e539a31d5f4825707a9`）。必ず切り戻し時点の署名・鮮度を再検証する。Security旧Workerは `78f17926-81de-4971-ab2b-00358f7ea4b5`。追加tableは保持する。
- Downloader Node 63件、Security Node 99件、両サービスのChromium/Firefox表示・回帰試験がPASS。Windows Python 112件中87件PASS、外部ツール依存25件skip。定義更新・障害・監視・通知の11件はSQLite/API/Docker mock試験を含む。
- サービス横断のパスキー失効・HTTP連携E2EもPASS。初回はローカルのWrangler依存不足で開始できず、依存を補って再実行した。認証方式・鍵の運用は変更していない。
- 候補imageで実sigtool署名・内部時刻、実ClamAV正常/EICAR拒否、YARA正常性を確認。実定義を用いた時刻注入で7日超過拒否、空の定義directoryと無害な破損定義fixtureで欠落/署名不正拒否も確認。本番の大容量取得は実施していない。
- 初回候補検証のsubprocessが一度失敗した（詳細を保存していないため原因は未確定）。同じ候補の再検証は通過。rollout要求の段階指定不足も本番APIで判明し、明示的なsteps指定と回帰テストを追加後に反映完了した。候補buildは1回だけで、途中の失敗時には本番の旧imageを維持した。
- 全サイトcontractは既存calculator build不一致で失敗。Downloaderにも着手前からbuild marker不一致があり、今回はWorker/UIを変更していない。今回変更したSecurityのbuild/HTML契約とdry-runは個別にPASS。
- GitHub標準通知Issue [#1](https://github.com/tanaka-note/t-room-site/issues/1)を管理者へ割り当て、同じ未設定状態の再送でIssue/commentが増えないことを確認。通知メールの受信、実障害からの外部復旧通知は未確認（復旧・重複抑制はmockで確認）。
- 自動更新用 `CLAMAV_CLOUDFLARE_API_TOKEN` は未登録。手元の既存ログインによる初回更新だけ完了しており、自動運転完了とは扱わない。登録後daily workflowを実行する。Securityの毎時cronは登録済みだが、初回導入確認時点では本番heartbeatは未観測。未設定/未観測を正常扱いしていない。

## 2026-09-06 自動運転の有効化

- 上記「初回導入記録」の未設定項目を解消する作業。main `a622bf5`を起点とし、対象accountのみ・Containers Edit / D1 Editの専用Tokenを発行、GitHub Secret `CLAMAV_CLOUDFLARE_API_TOKEN`へ登録した。既存Token、認証、課金契約は変更していない。
- [初回daily実行 34032282734](https://github.com/tanaka-note/t-room-site/actions/runs/34032282734)が成功。GitHub runnerで候補を1回buildし、実sigtool署名・内部日時、ClamAV正常fixture / EICAR拒否、YARA正常性を確認してから反映した。
- Container version 9、digest `sha256:795f752a9010a936670ee443090f3c73a921097095850c43066573d7460e4488`。rollout `ca4fc666-ee93-4ded-9182-3d25015a4b1c` completed・active rolloutなし・D1 image一致。既存のCPU/memory/disk/private network/graceを維持。Downloader/Security Workerは上記versionのままで、再deployは不要。
- 定義の内部生成日時は2026-09-06 15:26:06 JST、有効期限は2026-09-13 15:26:06 JST。最終検証は同日21:12:03 JST、本番反映確認は21:14:39 JST。同日の再取得なので生成日時自体は初回導入時と同じ。D1は`automation_enabled=1`、`last_result=success`、連続失敗0、lease解放を確認。
- 切り戻し候補`previous_image`はversion 8の`sha256:21b2fb59ef49b9d0befa36e5e03646374ff99ba758ed9ceade01128b57569e73`へ進んだ。上記の署名・鮮度再検証とジョブ/drain確認を省略しない。
- 対象試験24件PASS（定義更新/監視11、処理/再試行5、Worker契約6、保存期限2）。定義更新3モジュールの構文確認・`git diff --check`もPASS。今回のコード差分は文書だけのため、既存のbuild/dry-run結果を再利用。全Node/Python・全ブラウザーE2E・大容量本番検査は再実行していない。
- 更新前のCloudflare GraphQL読み取りでは2026-08-07〜09-06のaccount全体のContainers利用量はCPU 5483.88秒、memory 64134181189462.7 byte-seconds、disk 119459221492452 byte-seconds、送信2148166807 bytes。CPU約91.4分、memory約16.6 GiB時間、disk約33.2 GB時間で公表付帯枠より少なかった。これは過去の集計値で、今回の増分や請求確定額ではない。今後の利用増加・他サービスとの共有枠・集計遅延を含め、追加課金ゼロは保証しない。
- [独立monitor実行 34032800007](https://github.com/tanaka-note/t-room-site/actions/runs/34032800007)成功。daily後の通知と同じ`monitor_stopped`状態でIssue #1のコメント数が1のまま増えないことを確認。これは通知処理の成功であり、全監視の正常確認ではない。
- 21:22 JST時点では毎時17分の本番heartbeatは未観測。cron登録・稼働Worker内のscheduled handler/定義監視コード・正しいD1 bindingは読み取り確認済み。GraphQLのCron実行履歴には前日の既存日次cron成功があり、当日の毎時cronはまだない。実行遅延か停止かは判別できず、`monitor_stopped`を維持する。D1 heartbeatの手動補完や復旧Issueの手動closeはしていない。次の実行を観測し、独立monitorが`healthy`となりIssueが自動closeするまで監視の本番確認は未完了。
- Security Centerの本番ログイン画面・公開asset、未認証dashboard拒否を確認。管理者ログイン後の定義パネル表示とGitHub通知メールの受信は本人確認待ち。設定上は次回daily（09-07 04:37 JST）と6時間ごとの独立monitorが有効だが、GitHub/Cloudflare schedulerの遅延・停止まで保証するものではない。

## 2026-09-07 毎時監視の調査とheartbeat分離

- main `a274aa4`と本番を直接照合。productionは単一環境、Worker version `20a798ae-d542-4810-a641-0fd0f9064dcd`を100%配信。毎時/日次Trigger、scheduledの毎時分岐、D1 `security-db` bindingは一致。bundleのPURE注釈等の変換をコード相違とは扱わない。
- 19:22 JSTの本番GraphQLには日次`41 18 * * *`の03:41:47成功だけがあり、毎時`17 * * * *`は未観測。D1の共有heartbeatも03:41:47。過去のWorkers Logs保存は無効で、毎時起動・分岐到達・D1失敗の例外記録は得られなかった。毎時未発火の根本原因は未確定であり、時刻変更や再公開だけで解決したとは扱わない。
- 旧mainの関数をSQLite fixtureで実行し、日次だけで`healthy`になる誤判定を再現。専用heartbeatを分離し、日次では毎時停止が復旧しないよう修正。毎時開始/完了と失敗段階を追跡可能にした。
- 対象16件（SQLite/API mock、毎時/日次分岐、無関係cron拒否、追加migrationの履歴保持、開始/読込/完了batch失敗、停止/復旧/通知判定）と認証回帰2件PASS。構文確認とSecurity build/dry-runもPASS。Container・実検査・大容量取得・定義更新workflow・全テストは実行していない。
- 公開と自動運転の確認を区別する。次の自然発火で専用heartbeat更新を確認し、その後の独立monitorでIssue #1の自動復旧を確認する。未到来なら確認待ちとして報告し、長時間待機や頻繁なポーリングはしない。

## 2026-09-13 再発防止実装のローカル検証

- `npm run check`（Downloader/Security）PASS。
- Downloader `npm test`: Node 155件PASS。Python 136件中104件PASS・32件は環境条件によるskip（実行済みとは扱わない）。
- `node --test downloader-worker/test/definition-updates.test.js`: 51件PASS。0018の全既存列・履歴・無関係データ保持を含む。
- Security `node --test test/*.test.js`: 150件PASS。全migrationのSQLite/ローカルD1適用、認証/セッション/監視関連の回帰を含む。Security `wrangler deploy --dry-run` PASS。
- Securityに絞った既存Web contractのdeploy target/build marker/auto-update検証PASS。リポジトリ全体のWeb contract/app-shell testは対象外asset-reportの既存build marker不一致で失敗。このサービスのファイルは今回変更していない。
- 大容量の本番取得、意図的なCloudflare障害、ブラウザの全サービスE2Eは実施していない。
