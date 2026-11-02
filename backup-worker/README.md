# D1バックアップと監査履歴の保管

通常の利用画面に案内・進捗・通知を追加せず、サーバー側で定期保存する。管理はT-Cloudの既存`Backup-data`（folder ID 2850、名称変更可）に限定した管理者と正当なフォルダ閲覧権限を持つ一般ユーザーに共通の読み取り専用表示で行う。公開HTTP API、共有、移動、削除、復元操作は提供しない。

## 対象と保持

- 専用Worker `t-room-backup` の `D1BackupWorkflow` が本番12 D1を扱う。Portfolio / Cloud / Security / Billing / Payments / Health / Inventory / AI / Calendar / HouseholdとDownloader利用集計は03:40 JSTのCron、日記D1は既存の03:25 JSTから、DBごとに独立したWorkflowを起動する。開始は30秒ずつずらす。Calendarのローカル利用は対象外。
- Portfolio（資産運用報告）は他サービスD1と同じ `40 18 * * *`（毎日03:40 JST）のscheduled呼び出しで起動する。独立したCronは追加しない。`portfolio-db` のアカウント状態、報告設定とrevision、日付別評価額・更新時刻・銘柄内訳、訂正前後の履歴・保存IDを全て対象にする。保存先は既存の非公開R2の `d1/portfolio/v3/daily/` と `monthly/`、保持は日次30・月次12世代。手動JSON出力・旧静的ページとは独立し、動的ページの更新が対象になる。Backup-dataには「資産運用報告」として保存世代・成否を表示する。新規のSecretやパスキーは収集せず、新旧両形式の隔離復元では両アカウントを無効化しsession versionを進める。
- Householdは専用D1のアカウント状態・現行世代/revision・家計record（保持中の旧世代を含む）・再送履歴を保存し、Backup-dataへ「家計簿」として表示する。手動JSON出力とは別の定期保存。Secret・Cookie・パスキーは収集せず、隔離復元ではアカウントを無効化してsession versionを進める。通常保存は公式exportをストリーム処理するため、旧方式の合計10,000行・行JSON 8MiB制約には依存しない。
- 日次30世代・月次12世代。月次はその月の最初の成功分。同日・同月の正常世代は再実行で上書きしない。世代数で整理するため、障害が続けば暦上の30日・12か月より古い世代が残る。
- 対象のテーブル・列・既知schemaは`src/registry.js`を正本とする。未知のテーブル、対象テーブルの列変更、取得失敗は保存を停止して要確認にする。schema変更と同じPRで許可リスト・復元fixture・src/schema-guard.jsのmigration由来fingerprintを更新する。列だけでなくindex・trigger・制約を含むDDL差分も停止対象とし、D1内部table/migration管理tableは除外する。本番の既存DDLがmigrationと異なる場合も停止するので、初回公開前に読取専用で差分を確認し、内容を精査してから基準を更新する。
- JSON gzipに実際のschema SQL、想定migration、サービス・DB名、取得時刻、列・行・件数を含める。各DBの全対象行は一回の公式D1 exportの固定snapshotから取得する。export前後のschemaを検査し、途中のschema変更では公開しない。取得開始・完了・予定時刻を記録する。DB間、D1とR2写真の同時点の保証はない。
- T-CloudはD1の管理情報・暗号化済み鍵情報が対象。R2のファイル本体、動画、サムネイルを複製しない。共有リンクと一時解除状態も自動復元対象にしない。
- Healthの記録は暗号文のまま保存し、Security側の暗号化済み鍵情報と対応させて復旧する。PRF、平文秘密鍵、復号鍵、Worker Secretsを収集しない。パスキーの秘密鍵は端末側にあり、このバックアップから作成できない。
- Password hashやサービスの一時セッション、challenge、handoff、Downloaderの処理中ジョブ・一時ファイルは対象外。AIの利用実績と料金予約・再送状態は照合に必要なため保持するが、復旧時に処理を再実行しない。
- 日記D1は専用R2・03:25 JSTを維持し、写真処理と完全に独立する。写真の未処理・破損・R2障害はD1保存・検証・保持の成否に参加しない。写真は独立した差分保存を継続し、世代削除対象外とする。D1の成功だけで日記全体を復元可能と表示しない。

## D1 exportによる保存

通常のD1保存はREST export API (`output_format: polling`, `dump_options.no_schema: true`, 対象table許可リスト) を使う。export用Secretは専用Workerだけに設定する。API token・一時署名URL・SQL本文をログやWorkflowのstep結果へ返さない。元のSQLをR2や作業diskへ保存せず、SQLも実行しない。データ用INSERT・既知のprologueだけを厳格に解析し、`registry.js`の対象列へ射影する。日記は既存`BACKUP_TABLES`を利用する。Password hash、login ID、session、challenge等の既存除外は維持し、Worker Secrets・PRF・復号鍵を追加取得しない。

SQLはUTF-8のstreamとして読み、概ね1 MiBまたは1,000行でJSON gzip partへ分ける。全DB分の巨大JSONは作らず、ライブDBのページ分割SELECTも使わない。単一SQL文16 Mi文字、token 10,000個、単一行JSON 8 MiB、圧縮前後object16 MiB、最大20,000 partを安全停止条件とする。これは無制限の処理ではなく、巨大DBではWorkflowのCPU/subrequest/15分step制限も評価が必要。上限の単純緩和をしない。50,000監査行・旧8 MiB超の合成データと全12 DBの実workerd export構文で保存・隔離復元を検証する。本番の実行時間・CPU・最大メモリの測定は別に行う。

API・署名URL取得にはWorkers対応の`redirect: manual`を使い、3xxを含む非2xxは拒否する。API credentialを取得先へ転送しない。Nodeのfetch mockだけではWorkers非対応のredirect指定を見逃すため、実workerdのfetch・D1・R2による保存/リース/読戻し/保持と、API・取得先それぞれのリダイレクト拒否を合成データで回帰検証する。

新形式は共通D1が`d1/{service}/v3/daily/`・`monthly/`、日記D1が`v9/daily/`・`monthly/`。各JSON gzipはschema・DB名・migration・export bookmark・取得時刻・列・行数・part key/byte数/SHA-256を含むmanifest。本文partは同namespaceの`data/{一意ID}/`へcreate-only保存する。日次と月次は同じ検証済みpartを参照し、月次のために本文を再コピーしない。manifestだけの成功ではなく、本文partの読み戻し・SHA確認後に世代を公開する。中断後は既存の正常日次を検証し、未完の月次から再開する。同日・同月の正常世代は上書きしない。

保持は日次30・月次12。残すmanifestの内容と全partのHEADによるSHA metadata/サイズを確認してから、古いmanifestを削除する。partは残す全日次・月次からの参照を照合し、参照のない旧世代分だけを削除する。毎晩30世代の本文全量を読み直さない。実際の復元では各part本文を再hash検証する。旧v1/v2および日記v2〜v8と旧写真はこの整理対象に含めない。

DB単位のR2 CASリースを20分保持し、15分Workflow stepより長くする。公開・整理の各更新前に所有者と期限を確認する。期限切れの所有者は新所有者のリースを解除せず、期限切れ後は更新しない。Workflowは最大3試行（5分から指数待機）。保存・検証・成功監査の後だけ整理する。保存前に失敗した自身のpartは後処理するが、publish結果不明のpartは復旧点から参照されている可能性があるため消さず、孤立候補として運用確認する。

以前の方式は合計10,000行/8 MiB上限で、2026-10-26時点のT-Cloudを既に保存できなかった。互換用の旧capture/JSON readerは残すが、Workflow bindingを設定した通常Cronは新方式を使う。新方式でも未知schema・不正SQL・整数精度喪失・破損・保存失敗を成功扱いしない。schemaの変更と同じPRでregistry/schema guard/復元fixtureを更新する。

取得SQLはD1のcompound SELECT分岐数制限に合わせて5分岐以下の入れ子へ分け、単一SQL・全体上限の判定を維持する。全11サービスと日記について、実際のローカルworkerd/D1でもSQLの実行・schema照合・上限による本文抑止を検証する。本番bindingは使わない。

公式export中は対象DBの他のリクエストがブロックされるため夜間に実行する。公式の[export制約](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations)と[WorkflowsのD1→R2例](https://developers.cloudflare.com/workflows/examples/backup-d1/)を参照。FTS等のvirtual tableはexport非対応なので、追加時に設計を再確認し、本番tableを削除して回避しない。Time Travelは並行した短期復旧手段として維持する。

### 初回切り替え（このPRのmerge・自動Diary公開より前）

1. 別途承認されたインフラ手順で、専用Workerに12 D1と`DIARY_BACKUP`、`D1_EXPORT_ACCOUNT_ID`、専用Secret `D1_EXPORT_API_TOKEN`、Workflow `t-room-d1-backup`を準備する。tokenは対象D1のexportに必要な最小権限だけを持たせ、Git・ログへ保存しない。通常のコード公開tokenや読み取り専用MCPの権限を広げない。
2. `backup-worker`を専用手順で先に公開し、Workflowの実在・active version・binding・Secret名を読み戻す。新しいpublic route、workers.dev、写真R2本体へのbindingは追加しない。日記の既存バックアップR2とD1だけを追加する。
3. Diaryの`D1_BACKUPS`はこのWorkflowを参照する。Diary Actions公開は専用WorkerのWorkflow/Secret/日記bindingが未準備ならpreflightで停止する。写真のCronとコピー・再検証・追いつき頻度は変更しない。DB migrationは不要。
4. 初回定期実行後、12 DBそれぞれのWorkflow完了・成功監査・manifest/part読戻し・既存世代維持を確認する。Cronのdispatch成功だけで完了としない。schema/内容hash/整合性は隔離復元で確認し、本番DBを巻き戻さない。日記写真は独立した従来の残件・検証状態を確認する。
5. 問題時はDiaryを先に旧versionへ戻して旧D1 Cronへ戻し、その後専用Workerを戻す。新旧世代・part・写真・証明は削除しない。初回の実環境時間・利用量が想定を超える場合は増枠で押し切らず処理分割を見直す。

バックアップR2は既存の非公開構成・保存時暗号化を維持する。Securityの監査長期保管・Downloader一時R2の扱いは変更せず、バックアップ保管先を毎日再複製する機能は追加しない。

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

v1 receiptもSHA・source/copy版・サイズが一致すれば再利用する。初回のD1証明情報付与時はreceiptの新旧によらずsource/copyを深く検証する。写真参照（ID・作成日時・原本サイズ・3種のsource key）と内容SHAを結ぶimmutable検証情報を`media/photo-versions/{photoId}/{variant}/{referenceSha256}/{contentSha256}.json.gz`へ追加し、旧版を残す。検証後だけ`diary_photos.backup_identity`へvariant別source key・SHA-256・byte数を条件付き保存する。同じkeyの既存SHAと異なる内容は破損扱いで、付け替えない。v8 D1は同一transaction、v9 D1は同一exportで参照・証明情報を取得し、D1保存時に写真R2へ問い合わせない。

隔離復元ではv8/v9 D1を空のmigration済みDBへ戻し、account無効化を維持する。v9は`restoreIsolated`が検証済み写真参照をv8互換の`photoPayload`として返す。写真は別途`resolvePhotoManifest(bucket, payload)`で全参照を照合してから`restorePhotos`を隔離R2へ実行し、本体SHAを再照合する。snapshot内の証明SHA・サイズが一致するimmutable版だけを選び、候補数や日時で推測しない。証明がない旧snapshotは候補が1つでも`MediaIdentityUnproven`、証明に一致する版がなければ`MediaManifestIncomplete`で停止する。後日live D1に付与した証明を過去snapshotへ遡及しない。旧v2〜v8のD1は新列をNULLとして復元可能で、v7の明示マニフェストによる写真復元も維持する。

公開時はDiaryのmigration `0022_photo_backup_identity.sql`だけを事前適用し、コード公開後にDiaryのCronを専用手順で適用する。nullable列の追加なので旧コードの通常操作と互換性があり、rollback時も列・証明・写真を削除しない。schema fingerprintの既存本番表記差は、読取精査済みDDLへこの加算migrationを適用した期待値へ更新する。初回検証が済むまで写真の証明はNULLのままで、その間のD1世代は写真の自動対応付けを保証しない。検証後の次のD1世代から証明を含む。

40 object・256 MiB・90秒はアプリの安全枠で、公式上限ではない。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)はメモリ128 MB、同時接続6、有料プランsubrequest 10,000、1時間未満間隔のCron CPU 30秒、wall time 15分。DigestStreamと逐次実行を使い、全体をbufferしない。[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)の同一key書込は秒1回なので、制御objectはバッチ単位、写真と実行券は異なるkeyに書く。契約枠・実環境CPU/最大メモリ・料金は合成fixtureでは測定していない。

[Bucket Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)のprefix限定lockはimmutable写真・検証履歴・事故記録の保護候補。mutable receipt/リース/カーソルへのlockは処理を停止し、日次/月次への無期限lockは保持整理、バケット全体lockは候補の後処理と衝突する。本番lockが空であることを読取確認しただけで今回は変更しない。

## 成否と管理画面

開始・成功・失敗・一部未完了・世代整理失敗を、内容を含まない実行ID・時刻・工程・固定理由コード・試行回数として既存Security監査へ記録する。日記を含むD1 Workflowは監査への同期記録と既存Queueへの配送が両方失敗した場合、保存を開始しない。写真ジョブの監査配送と安全なWorkerログは従来どおり維持する。

通常のCronはDBごとにWorkflowを作成し、1 DBのdispatch失敗でも後続DBを試す。`backup_dispatched`は起動依頼の完了だけを表し、保存成功を意味しない。起動に失敗したDBは固定項目の`backup_dispatch_failed`ログに残し、Cronも失敗する。日記D1のCronもdispatchだけを担当し、写真ジョブとは独立する。

各Workflowは開始記録、公式export・列選別・分割保存・読戻し、成功監査、世代整理を行う。保存失敗・監査不能・整理失敗はWorkflowの失敗終了とし、既存監査へ`backup_failed`または`backup_prune_failed`を残す。安全な固定理由コード以外の例外本文はWorkflowの永続step状態にも渡さない。成功監査を残せない場合は世代整理しない。全体の完了は12 DBそれぞれのWorkflow終端・成功監査・保存世代で確認する。

Cronのdispatch結果とBackup-dataの監査表示は別の確認元。監査RPCとQueueが両方使えない場合、画面に前回の正常状態や実行中が残り得るため、Workflowの状態とCronの失敗も監視する。stepは最大3試行で、同日の正常日次があれば再取得せず検証・月次から再開する。旧bindingなしの互換Cronは従来の同期処理を維持するが、新構成の完了判定には使用しない。

`Backup-data`は最終成功・最新実行・履歴・世代・容量・長期保管月を表示する。正常、実行中、失敗、一部未完了、未実行/遅延、世代整理失敗、状態取得不可を区別する。予定時刻から2時間の猶予後、開始記録自体がない場合も遅延とする。失敗後の成功で過去の失敗履歴を消さない。R2容量・世代一覧は通常6時間cache、手動更新は最短1分。実行状態はそのcacheと分け、アクセス時に監査DBから取得する。取得不能は正常扱いしない。

日記はD1・写真コピー・写真再検証の監査targetを分離する。写真進捗は新規コピー、保存済み、未処理、検証待ち、失敗、破損、保存元なし、未確認を区別する。巡回中は部分集計と開始日時を表示し、未確認を正常扱いしない。D1容量/世代と写真の物理保管容量も別表示する。強制終了は事前の開始記録が残り、終端記録のない実行が猶予後に遅延になる。監査RPC/Queueとも停止した場合は安全なWorkerログとCron失敗も参照する。

写真独立実行の公開順と旧方式の調査事実は[2026-10-31の読取監査](../docs/history/2026-10-31-diary-backup-audit.md)を参照。

## セキュリティ監査の期限なし保管

Security Centerの一覧・詳細・ユーザー詳細は直近180日だけ表示する。180日超の記録は、03:41 JSTの既存Securityメンテナンスで非公開R2の`security-audit/`へJSON gzipで保管する。通常バックアップの世代削除とは分離し、保持期限を設定しない。バックアップ運用の監査イベントは通常のSecurity Center履歴には表示せず、Backup-dataに集約する。

日次は最大1,000件（100件×10回）、既存の毎時17分の実行枠では未処理がある場合だけ最大500件を追加処理する（最大約13,000件/日、実際には負荷・失敗により減る）。従来の500件/日を超える流入では滞留が増え続けるため、この追いつき処理を追加した。残りはD1に保持し「一部未完了」と記録する。occurred_at索引で最古から最大1,001件だけ調べ、件数（1,001件以上は下限値）・最古日時をBackup-dataへ記録する。全件COUNTは行わない。流入が処理能力以上なら運用上の増枠・別ジョブ設計が必要で、追いつきを保証するものではない。元のイベント項目とIdentity表示名を保存し、読み戻しのSHA-256照合と月別メタデータ保存を確認してから、保存時と全列が同一の行だけを削除する。書込・読戻し・メタデータ更新の失敗時は未保管の行を削除しない。同時更新された行も残す。

`_metadata/security-audit/`の月別集計は条件付き書込で更新する。管理画面はこのメタデータだけを読み、履歴本文の全走査をしない。再試行・並行実行で同じevent IDの複数コピーを保管する場合があるため、件数は延べ件数。監査の再構成時はevent IDと各版の内容を照合する。既に削除されて存在しない過去の記録を復元する機能ではない。

古い行の削除は100 bind上限内に分割し、全列の値が一致する行だけを同一batchで削除する。メタデータのCAS競合も失敗として未削除の原本を維持する。

停止済みIdentityの整理は従来の依存関係guardを維持し、保管処理が成功した場合だけ実行する。認証用の一時データと失効方式は変更しない。長期保管の対象はログイン成功・失敗・重要操作などの監査原本であり、有効な認証セッションを半永久化しない。

## 初回公開の前提

新Workerと新バケットは既存mainの自動公開で作成されない。**通常のmain公開より前に、別途承認されたインフラ準備と公開順序の調整が必要**。既存サービスを本番binding付きでPreview公開しない。

1. 非公開R2 `t-room-service-backups` を準備し、r2.dev無効・公開カスタムドメインなしを確認する。`security-audit/`と`_metadata/`へ期限削除を設定しない。バケット全体へのLifecycle削除も設定しない。
2. `backup-worker/wrangler.jsonc`の12個のD1、Security Service Binding、監査Queueを照合する。専用Workerは必要なDBを読取るが、D1 binding自体は読取専用権限ではない点に注意する。T-CloudにはR2 bindingを追加せず、メタデータ用RPCだけを渡す。
3. Security D1へ`0026_backup_status_index.sql`を適用して状態取得の走査を絞る。新Workerを準備・公開し、Security（R2 binding・監査保管・状態RPC）→Diary（状態記録）→Cloud（集約表示）の順で公開する。新Workerに公開route・workers.dev・preview URLを付けない。mainの自動公開を先に走らせない。
4. 安全なテストデータで初回成功・失敗記録・読戻し・未実行検知・権限を持つ一般ユーザーの成功と無権限ユーザーの拒否を確認する。本番の巻戻しや実ファイルの削除試験は行わない。

R2は標準の保存時暗号化と認証付きアクセスを使用し、既存の端末側暗号化は維持する。Cloudflareアカウント全体の喪失に対する独立コピーではない。容量・リクエストは既存契約と合算される。

### Portfolio追加の反映

2026-11-02の読取専用調査で、既存の `t-room-backup` は毎日03:40 JSTのままで、`portfolio-db` のD1 bindingが欠けていることを確認した。対象レジストリ、WorkflowのDB ID許可リスト、schema fingerprint、`PORTFOLIO_DB` bindingを同じ変更で追加する。元のD1・利用者・認証・財務データを変更するmigrationは不要。

PR作成・テストだけでは本番の自動保存は始まらない。公開時は検証済みmainからBackup Workerのコードと `PORTFOLIO_DB` bindingを反映し、既存のCronが `40 18 * * *` の1件のまま、接続先がPortfolio Workerの専用D1と一致することを読み戻す。レジストリとschema guardをbundleするSecurity・Diaryも対応版を公開する。既存の限定production tokenへ新しい権限を自動追加せず、Backup Workerは既存の専用インフラ公開手順を使う。

反映後の次の共通03:40 JST枠で、`portfolio` の成功監査と日次・月次世代が揃っていることを確認する。既存世代を保持する規則は変えず、初回の保存前に過去の世代を作成済みとは扱わない。切り戻し時も保存済みのPortfolio世代・原本D1・訂正履歴を削除しない。

## 復元と検証

本番への自動復元APIはない。R2から対象世代を認証付きで取得し、メタデータのSHA-256・形式・サービス・schemaを照合する。対応版のmigrationを適用した空の隔離DBへ、依存順序・外部キーを維持して必要な行を戻し、件数・内容・整合性とサービス固有の残高/在庫/配分を検証する。seed行と衝突させず、派生集計も再構成する。原本・一時署名URL・機密データをGitやログへ出さない。

Security/Cloud/Healthは組み合わせる世代を照合し、最新の失効状態を優先する。復元した古いcredential・link・招待・Password policyをそのまま有効化しない。第一管理者の既存復旧手段を維持し、epoch・有効session・処理中ジョブ・AIの料金予約を巻き戻して再実行しない。本番切替は別途承認した災害復旧手順で行う。

`tools/restore-isolated.mjs`は新manifest/partと旧形式に対応し、Node専用で必ず自ら作る`:memory:`へ復元する。新形式はpartごとにSHA・列・件数を検証し、INSERT RETURNINGで各cellの保存値を照合する。payload内のschema SQLは実行せず、信頼済みmigrationだけを適用する。復元時の在庫trigger二重加算等を避けるため隔離DB内だけでmigration由来triggerを一時停止し再作成する。全列・行数照合後、Identity/credential/link/招待/各accountは隔離無効化し、処理中AI requestは再実行不可とする。鍵暗号文と料金予約は保存して手動照合に使う。本番切替用の復元器ではない。

`pnpm test`は実migrationを用いた全11サービスの取得・隔離SQLite復元・内容照合・integrity/foreign_key_check、読戻し不一致、保存失敗、schema drift、保持、監査配送失敗、cacheと状態の分離を検証する。`security-worker/test/audit-archive.test.js`は長期保管の保存・検証・更新競合を検証する。非空の合成データをR2 fixtureに保存した世代から各サービスを復元し、在庫数量・支払配分・請求/精算金額・AI利用額を照合する。Portfolio専用fixtureはWorkflowあり/なしの両形式を使い、実際の保存APIで銘柄変更・過去日追加・同日訂正を行い、共通scheduledから保存した世代の全列・全履歴・revisionの隔離復元とアカウント無効化、revision triggerの復旧を確認する。メモリ内で生成した合成RSA/AES鍵のwrap/unwrap・暗号文復号も確認する。日記は別の復元/写真fixtureで検証する。いずれも合成データで、実R2/本番D1の復元実証・実端末PRF・本番鍵の復号を行ったものではない。
