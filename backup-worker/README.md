# D1バックアップと監査履歴の保管

通常の利用画面に案内・進捗・通知を追加せず、サーバー側で定期保存する。管理はT-Cloudの既存`Backup-data`（folder ID 2850、名称変更可）に限定した管理者と正当なフォルダ閲覧権限を持つ一般ユーザーに共通の読み取り専用表示で行う。公開HTTP API、共有、移動、削除、復元操作は提供しない。

## 対象と保持

- 専用Worker `t-room-backup` が毎日03:40 JSTにCloud / Security / Billing / Payments / Health / Inventory / AI / Calendar / Householdの許可された永続テーブルとDownloaderの利用集計を順番に保存する。Calendarのローカル利用はサーバーへ送らないため対象外。
- Householdは専用D1のアカウント状態・現行世代/revision・家計record（保持中の旧世代を含む）・再送履歴を既存の同一DBスナップショット方式で保存し、Backup-dataへ「家計簿」として表示する。手動JSON出力とは別の定期保存。Secret・Cookie・パスキーは収集せず、隔離復元ではアカウントを無効化してsession versionを進める。既存の合計10,000行・行JSON 8MiB等の停止条件は変更しないため、明細や旧世代の増加で超過した場合は失敗として通知する。
- 日次30世代・月次12世代。月次はその月の最初の成功分。同日・同月の正常世代は再実行で上書きしない。世代数で整理するため、障害が続けば暦上の30日・12か月より古い世代が残る。
- 対象のテーブル・列・既知schemaは`src/registry.js`を正本とする。未知のテーブル、対象テーブルの列変更、取得失敗は保存を停止して要確認にする。schema変更と同じPRで許可リスト・復元fixture・src/schema-guard.jsのmigration由来fingerprintを更新する。列だけでなくindex・trigger・制約を含むDDL差分も停止対象とし、D1内部table/migration管理tableは除外する。本番の既存DDLがmigrationと異なる場合も停止するので、初回公開前に読取専用で差分を確認し、内容を精査してから基準を更新する。
- JSON gzipに実際のschema SQL、想定migration、サービス・DB名、取得時刻、列・行・件数を含める。各DBの全対象行は単一SQLのSQLiteスナップショットで取得し、schema確認は同じD1 batch transactionへ含める。取得開始・完了・予定時刻を記録する。DB間、D1とR2写真の同時点の保証はない。
- T-CloudはD1の管理情報・暗号化済み鍵情報が対象。R2のファイル本体、動画、サムネイルを複製しない。共有リンクと一時解除状態も自動復元対象にしない。
- Healthの記録は暗号文のまま保存し、Security側の暗号化済み鍵情報と対応させて復旧する。PRF、平文秘密鍵、復号鍵、Worker Secretsを収集しない。パスキーの秘密鍵は端末側にあり、このバックアップから作成できない。
- Password hashやサービスの一時セッション、challenge、handoff、Downloaderの処理中ジョブ・一時ファイルは対象外。AIの利用実績と料金予約・再送状態は照合に必要なため保持するが、復旧時に処理を再実行しない。
- 日記D1は専用R2・03:25 JSTを維持し、写真処理と完全に独立する。写真の未処理・破損・R2障害はD1保存・検証・保持の成否に参加しない。写真は独立した差分保存を継続し、世代削除対象外とする。D1の成功だけで日記全体を復元可能と表示しない。

## 保存の安全性と上限

2026-10-26の本番DDLの読取専用照合で、日記・在庫のSQL表記差と請求書の既存`password_iterations DEFAULT 210000`（migrationは100000）を確認した。認証設定やDBは変更せず、精査した完全なDDL fingerprintだけを対応するmigration fingerprintに結び付けて許可する。未知の差分は引き続き停止し、migrationが変わると旧本番例外は無効になる。DDLだけのfixtureで表記差・既存の既定値差・未知の変更拒否を検証する。

新規D1形式はv2（`d1/{service}/v2/daily/`と`monthly/`）、日記はD1単独v8（`v8/daily/`と`v8/monthly/`、`backupScope: d1-only`）。日記の旧`daily/`・`monthly/`・v7は上書き・自動昇格・自動整理せず保持する。新形式の保持数は日次30・月次12のまま。移行直後は旧形式分が追加容量になる。破損・形式不一致の既存世代を上書きせず失敗として残す。

各世代は一意の候補へ保存してSHA-256読み戻し確認後、R2 create-only条件付き書込で公開する。並行実行の敗者も勝者のSHA・gzip・形式・service・table/column/行数を検証する。日次だけ成功して月次が失敗した場合は成功扱いせず、次回は正常な日次を保持して月次から再開する。世代整理は残す全世代の内容検証に成功した後だけ行う。候補は自身の処理終了時に削除するが、強制終了や削除障害による`attempts/`の孤立objectは自動全体削除せず、運用確認対象とする。

D1→Workerの取得は合計10,000行・行JSON合計8 MiB・1行JSON 1 MiBまで。SQLite内で上限とJS safe integerを判定し、超過時は原本行をWorkerへ返さず停止する。単一巨大JSONセルを作らず、D1の2 MB行上限を避けて個別行で返す。圧縮前JSON・解凍後・圧縮objectは16 MiBに制限する。gzipはstream処理し、写真はWorkers DigestStreamで全体をメモリへ貯めず照合する。同一isolateの重いバックアップは重複実行しない。一般D1スキーマを任意にSQLへ変換するのではなく、許可リストのSQLだけを実行する。

これは無制限に増えるAI会話や監査を全量取得し続ける方式ではない。上限超過時はBackup-dataに失敗理由を表示し、既存世代を維持する。分割SELECTでは更新中の一貫性を保証できないため採用しない。将来は書込停止時間を調整したD1 export、または書込世代を固定できる別設計とWorkflows等への分離を推奨する。DB間・鍵情報と本文の世代一致は復旧時に照合し、自動で本番へ戻さない。実際の本番規模でCPU時間・最大メモリを計測したわけではない。

公開前の2026-10-26の読取専用集計では、T-Cloudは少なくとも29,395行・行JSON 9,813,926 byteで、既にこの上限を超えていた（各tableの先頭最大25,001行だけの下限値）。**今回の方式で本番T-Cloudの新規全量バックアップは成功しない**。既存世代を削除せず`SnapshotTooLarge`で停止し、Backup-dataとCron全体で失敗を示す。他サービスは処理を継続する。T-Cloudの継続的な全量保存には上記の別方式が必要で、上限を緩和したり原本を除外して成功扱いにはしない。日記とSecurityについては集計時点で行数・行JSON合計・最大行・整数精度が上限内だった。本番原本の取得や復元実証とは区別する。

取得SQLはD1のcompound SELECT分岐数制限に合わせて5分岐以下の入れ子へ分け、単一SQL・全体上限の判定を維持する。全10サービスと日記について、実際のローカルworkerd/D1でもSQLの実行・schema照合・上限による本文抑止を検証する。本番bindingは使わない。

公式制約: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 export中の書込制限](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。上限は安全停止のための保守的な実装値で、プロバイダの契約上限を増やすものではない。

日記写真は既存の非公開R2 `t-room-diary-media` → `t-room-diary-backups` の差分保存を維持する。新しいWorker・Queue・D1 table・権限・復元APIは追加しない。通常の写真操作経路は変更せず、写真削除とバックアップ削除は連動しない。詳細は次節を参照。

## 日記写真の独立実行と復元

時刻はJST。DiaryのCronを文字列で明示的に振り分け、D1と既存cleanupは03:25だけで実行する。写真はD1バックアップ関数・schema guard・snapshot上限に依存せず、写真参照を最大41行ずつ取得する。参照元DB自体の停止は写真処理にも影響する。

| 用途 | 時刻 | 上限 |
| --- | --- | --- |
| D1単独 | 毎日03:25 | 3試行、日次30・月次12世代 |
| 写真コピー | 毎日03:55 | 40 object、推定I/O 256 MiB、90秒 |
| 写真再検証 | 毎日04:45〜11:45の毎時45分 | 各40 object、256 MiB、90秒、8枠/日 |
| 初回追いつき | 04・05時台の05/15/25/35/55分 | 各40 object、256 MiB、90秒、10枠/日、14日間限定 |

既存Cloud 03:17、Backup 03:40、Security 03:41/毎時17分、Calendar 04:10、Downloaderの10分刻みと開始時刻をずらす。長引いた別サービスの実行との重複までは保証しない。Cronは非version設定なのでコード公開と別に適用・読み戻しが必要。

R2 `_metadata/diary-photos/` にコピー/再検証別のカーソル・集計・新着高水位を保存する。新着は過去分より先、初回も前日以降を優先する。過去分はIDのキーセットで最大120 variant/回を巡回する。コピー枠では古い検証レシートを再利用し、深い再検証は別枠だけで行う。新規/変更コピーが検証待ちのため停止しない。

写真全体の同時実行数は1。条件付き書込で5分のリースを取得し、期限切れ後はreceipt/カーソルを更新しない。リースは削除せず期限で回収する。初回実行から14日、または最初の全件コピー確認まで追いつきを許可する。同じcatchup時刻の実行券はcreate-onlyで、1日10枠以上に増えない。理論上限は400 object・2.5 GiB推定I/O・15分の作業枠/日。サイズ・障害で実処理量は小さくなり、完了期限を保証しない。期間は自動延長しない。

カーソルはバッチ終端、receiptは各写真の検証直後にSHA確認付きで保存する。中断時は直前バッチを再走査するが確認済み写真は再コピーしない。通信失敗・欠落は各laneの永続再試行journal（最大256項目）へ保存し、次回以降の実行で期限到来分を最大8項目、新着・過去分より先に再試行する。待機は1分から指数増加、最大6時間。journal満杯時は未登録の失敗位置からカーソルを進めない。90秒は次の処理を開始しないための期限で、進行中I/Oの強制中断保証ではない。単体の推定I/Oは写真サイズの6倍なので、通常枠で44,739,242 byte（約42.7 MiB）を超える写真は`oversized`として区別し、優先再試行へ入れず後続を継続する。Backup-dataに単体上限超過・優先再試行待ち件数を表示する。大きな写真の自動コピーには別の処理量設計が必要。

写真は`media/verified-photos/{photoId}/{variant}/{sha256}`へcreate-only保存する。sourceをstreamでSHA-256計算し、コピー時にR2 SHA条件を指定し、保存先を読み戻してSHA・サイズを照合する。source ETagも前後で確認する。破損物は上書きせず`media/photo-issues/`にcreate-onlyの事故記録を保存する。事故はsourceが変更されても自動解除せず、receiptと破損物を手動調査対象として残す。

従来の7日再検証は5,445 objectで平均778 object/日が必要で、従来の最大120 object/日（40×3試行）より大きい。独立枠では30日経過で再検証対象とし、ID順に分散する。8枠で最大320 object/日だが、バイト・時間制約もあるため30日は目安であり上限保証ではない。検証待ちが増え続ければ別の処理量設計が必要。全件毎回のSHA照合はしない。

v1 receiptもSHA・source/copy版・サイズが一致すれば再利用する。初回のD1証明情報付与時はreceiptの新旧によらずsource/copyを深く検証する。写真参照（ID・作成日時・原本サイズ・3種のsource key）と内容SHAを結ぶimmutable検証情報を`media/photo-versions/{photoId}/{variant}/{referenceSha256}/{contentSha256}.json.gz`へ追加し、旧版を残す。検証後だけ`diary_photos.backup_identity`へvariant別source key・SHA-256・byte数を条件付き保存する。同じkeyの既存SHAと異なる内容は破損扱いで、付け替えない。v8 D1の参照・証明情報は同一transactionで取得し、D1保存時にR2へ問い合わせない。

隔離復元ではv8 D1を空のmigration済みDBへ戻し、account無効化を維持する。写真は別途`resolvePhotoManifest(bucket, payload)`で全参照を照合してから`restorePhotos`を隔離R2へ実行し、本体SHAを再照合する。snapshot内の証明SHA・サイズが一致するimmutable版だけを選び、候補数や日時で推測しない。証明がない旧snapshotは候補が1つでも`MediaIdentityUnproven`、証明に一致する版がなければ`MediaManifestIncomplete`で停止する。後日live D1に付与した証明を過去snapshotへ遡及しない。旧v2〜v8のD1は新列をNULLとして復元可能で、v7の明示マニフェストによる写真復元も維持する。

公開時はDiaryのmigration `0022_photo_backup_identity.sql`だけを事前適用し、コード公開後にDiaryのCronを専用手順で適用する。nullable列の追加なので旧コードの通常操作と互換性があり、rollback時も列・証明・写真を削除しない。schema fingerprintの既存本番表記差は、読取精査済みDDLへこの加算migrationを適用した期待値へ更新する。初回検証が済むまで写真の証明はNULLのままで、その間のD1世代は写真の自動対応付けを保証しない。検証後の次のD1世代から証明を含む。

40 object・256 MiB・90秒はアプリの安全枠で、公式上限ではない。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)はメモリ128 MB、同時接続6、有料プランsubrequest 10,000、1時間未満間隔のCron CPU 30秒、wall time 15分。DigestStreamと逐次実行を使い、全体をbufferしない。[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)の同一key書込は秒1回なので、制御objectはバッチ単位、写真と実行券は異なるkeyに書く。契約枠・実環境CPU/最大メモリ・料金は合成fixtureでは測定していない。

[Bucket Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)のprefix限定lockはimmutable写真・検証履歴・事故記録の保護候補。mutable receipt/リース/カーソルへのlockは処理を停止し、日次/月次への無期限lockは保持整理、バケット全体lockは候補の後処理と衝突する。本番lockが空であることを読取確認しただけで今回は変更しない。

## 成否と管理画面

開始・成功・失敗・一部未完了・世代整理失敗を、内容を含まない実行ID・時刻・工程・固定理由コード・試行回数として既存Security監査へ記録する。専用Workerは監査への同期記録と既存Queueへの配送の両方が失敗した場合、保存を開始しない。日記は既存バックアップを継続し、監査配送失敗も安全なWorkerログに残す。

専用WorkerのCronは全サービスを順に処理し、途中の失敗でも後続を継続する。全件が`ok`の場合だけ正常終了する。保存失敗、監査不能、世代整理失敗、想定外例外、不正な戻り値が1件でもあれば、全件処理後に`BackupRunError`で失敗終了する。保存済みの世代整理失敗は`prune_failed`として保存失敗と区別するが、Cron全体は失敗扱いとする。実行単位の`runId`、予定時刻、固定の状態名、件数、サービス別結果を`backup_run_finished`ログへ残す。例外本文・バックアップ本文・任意の戻り値は記録しない。

Cronの結果とBackup-dataの監査ベースの表示は確認元が異なる。監査RPCとQueueの両方が使えない場合、画面に前回の正常状態や実行中が残り得るが、今回のCronは監査不能を含む失敗として通知する。Cron全体のログも併せて監視し、画面だけを今回の成功判定に使わない。

D1保存は最大3試行。SHA-256を付けてR2へ保存し、読み戻して一致を確認する。新しい保存と成功記録が完了するまで、専用Workerは古い世代を整理しない。日記D1も候補の読み戻し確認後に公開し、写真集合の状態によって保存を中断しない。

`Backup-data`は最終成功・最新実行・履歴・世代・容量・長期保管月を表示する。正常、実行中、失敗、一部未完了、未実行/遅延、世代整理失敗、状態取得不可を区別する。予定時刻から2時間の猶予後、開始記録自体がない場合も遅延とする。失敗後の成功で過去の失敗履歴を消さない。R2容量・世代一覧は通常6時間cache、手動更新は最短1分。実行状態はそのcacheと分け、アクセス時に監査DBから取得する。取得不能は正常扱いしない。

日記はD1・写真コピー・写真再検証の監査targetを分離する。写真進捗は新規コピー、保存済み、未処理、検証待ち、失敗、破損、保存元なし、未確認を区別する。巡回中は部分集計と開始日時を表示し、未確認を正常扱いしない。D1容量/世代と写真の物理保管容量も別表示する。強制終了は事前の開始記録が残り、終端記録のない実行が猶予後に遅延になる。監査RPC/Queueとも停止した場合は安全なWorkerログとCron失敗も参照する。

将来の公開はSecurityの状態RPC→Diaryのコードと明示したCron→Cloudの表示の順に行い、03:25のv8 D1の読戻し、写真の残件減少、再検証枠、監査の分離、非公開R2、旧世代維持を確認する。通常のActionsコード公開だけでは新Cronは反映されない。今回の調査事実は[2026-10-31の読取監査](../docs/history/2026-10-31-diary-backup-audit.md)を参照。

## セキュリティ監査の期限なし保管

Security Centerの一覧・詳細・ユーザー詳細は直近180日だけ表示する。180日超の記録は、03:41 JSTの既存Securityメンテナンスで非公開R2の`security-audit/`へJSON gzipで保管する。通常バックアップの世代削除とは分離し、保持期限を設定しない。バックアップ運用の監査イベントは通常のSecurity Center履歴には表示せず、Backup-dataに集約する。

日次は最大1,000件（100件×10回）、既存の毎時17分の実行枠では未処理がある場合だけ最大500件を追加処理する（最大約13,000件/日、実際には負荷・失敗により減る）。従来の500件/日を超える流入では滞留が増え続けるため、この追いつき処理を追加した。残りはD1に保持し「一部未完了」と記録する。occurred_at索引で最古から最大1,001件だけ調べ、件数（1,001件以上は下限値）・最古日時をBackup-dataへ記録する。全件COUNTは行わない。流入が処理能力以上なら運用上の増枠・別ジョブ設計が必要で、追いつきを保証するものではない。元のイベント項目とIdentity表示名を保存し、読み戻しのSHA-256照合と月別メタデータ保存を確認してから、保存時と全列が同一の行だけを削除する。書込・読戻し・メタデータ更新の失敗時は未保管の行を削除しない。同時更新された行も残す。

`_metadata/security-audit/`の月別集計は条件付き書込で更新する。管理画面はこのメタデータだけを読み、履歴本文の全走査をしない。再試行・並行実行で同じevent IDの複数コピーを保管する場合があるため、件数は延べ件数。監査の再構成時はevent IDと各版の内容を照合する。既に削除されて存在しない過去の記録を復元する機能ではない。

古い行の削除は100 bind上限内に分割し、全列の値が一致する行だけを同一batchで削除する。メタデータのCAS競合も失敗として未削除の原本を維持する。

停止済みIdentityの整理は従来の依存関係guardを維持し、保管処理が成功した場合だけ実行する。認証用の一時データと失効方式は変更しない。長期保管の対象はログイン成功・失敗・重要操作などの監査原本であり、有効な認証セッションを半永久化しない。

## 初回公開の前提

新Workerと新バケットは既存mainの自動公開で作成されない。**通常のmain公開より前に、別途承認されたインフラ準備と公開順序の調整が必要**。既存サービスを本番binding付きでPreview公開しない。

1. 非公開R2 `t-room-service-backups` を準備し、r2.dev無効・公開カスタムドメインなしを確認する。`security-audit/`と`_metadata/`へ期限削除を設定しない。バケット全体へのLifecycle削除も設定しない。
2. `backup-worker/wrangler.jsonc`の10個のD1、Security Service Binding、監査Queueを照合する。専用Workerは必要なDBを読取るが、D1 binding自体は読取専用権限ではない点に注意する。T-CloudにはR2 bindingを追加せず、メタデータ用RPCだけを渡す。
3. Security D1へ`0026_backup_status_index.sql`を適用して状態取得の走査を絞る。新Workerを準備・公開し、Security（R2 binding・監査保管・状態RPC）→Diary（状態記録）→Cloud（集約表示）の順で公開する。新Workerに公開route・workers.dev・preview URLを付けない。mainの自動公開を先に走らせない。
4. 安全なテストデータで初回成功・失敗記録・読戻し・未実行検知・権限を持つ一般ユーザーの成功と無権限ユーザーの拒否を確認する。本番の巻戻しや実ファイルの削除試験は行わない。

R2は標準の保存時暗号化と認証付きアクセスを使用し、既存の端末側暗号化は維持する。Cloudflareアカウント全体の喪失に対する独立コピーではない。容量・リクエストは既存契約と合算される。

## 復元と検証

本番への自動復元APIはない。R2から対象世代を認証付きで取得し、メタデータのSHA-256・形式・サービス・schemaを照合する。対応版のmigrationを適用した空の隔離DBへ、依存順序・外部キーを維持して必要な行を戻し、件数・内容・整合性とサービス固有の残高/在庫/配分を検証する。seed行と衝突させず、派生集計も再構成する。原本・一時署名URL・機密データをGitやログへ出さない。

Security/Cloud/Healthは組み合わせる世代を照合し、最新の失効状態を優先する。復元した古いcredential・link・招待・Password policyをそのまま有効化しない。第一管理者の既存復旧手段を維持し、epoch・有効session・処理中ジョブ・AIの料金予約を巻き戻して再実行しない。本番切替は別途承認した災害復旧手順で行う。

`tools/restore-isolated.mjs`はNode専用で必ず自ら作る`:memory:`へ復元する。payload内のschema SQLは実行せず、信頼済みmigrationだけを適用する。復元時の在庫trigger二重加算等を避けるため隔離DB内だけでmigration由来triggerを一時停止し再作成する。全列・行数照合後、Identity/credential/link/招待/各accountは隔離無効化し、処理中AI requestは再実行不可とする。鍵暗号文と料金予約は保存して手動照合に使う。本番切替用の復元器ではない。

`pnpm test`は実migrationを用いた全10サービスの取得・隔離SQLite復元・内容照合・integrity/foreign_key_check、読戻し不一致、保存失敗、schema drift、保持、監査配送失敗、cacheと状態の分離を検証する。`security-worker/test/audit-archive.test.js`は長期保管の保存・検証・更新競合を検証する。非空の合成データをR2 fixtureに保存した世代から全10サービスを復元し、在庫数量・支払配分・請求/精算金額・AI利用額を照合する。メモリ内で生成した合成RSA/AES鍵のwrap/unwrap・暗号文復号も確認する。日記は別の復元/写真fixtureで検証する。いずれも合成データで、実R2/本番D1の復元実証・実端末PRF・本番鍵の復号を行ったものではない。
