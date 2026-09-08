# T-lain Downloader

権利を持つメディアをURLから解析し、明示的な確認後に隔離Containerで取得・検査して、非公開R2へ最大12時間だけ保存する非公開ツールです。公開導線、サイト内検索、sitemap、OGPは持ちません。保存期限内は、認証済みの同一利用者が履歴から何度でも再ダウンロードできます。

## 構成

- Worker: Security Centerの一回限りhandoff、セッション、所有者分離、rate limit、Queue、D1台帳、R2配信・期限削除
- Queue: URL解析と取得をHTTP requestから分離し、URLを暗号化して配送。取得は1件ずつ冪等に処理し、processing tokenとleaseで重複実行を遮断
- Container: site固有adapter → Direct → yt-dlp → Generic HTML → Chromium fallbackの順で解析し、解析時に確定した取得routeだけを実行
- Media pipeline: 隔離Container内でlibmagic・magic number・ffprobeによる軽量検証後、動画をMP4/H.264/AAC/yuv420pへ必要最小限で正規化し、R2へ保存する最終成果物だけをClamAVと独立YARAで1回検査
- R2: `t-room-downloader-temp`の`downloads/`だけを使用。Worker経由の所有者認証なしでは取得不可

## 親アカウント向け利用状況

第一管理者の`owner` service linkから発行された有効なPasskey sessionだけが、`/downloader/api/admin/usage`と画面内の「利用状況」を使用できます。一般IdentityはUIが非表示になるだけでなく、Worker側で403になります。今日・今月・累計について、解析／取得要求、処理成功、実ファイル取得開始、削除／期限切れ、取得元・R2保存・配信容量、正規化方式、固定分類したsecurity結果を確認できます。

長期保存する統計はJST日次の件数・bytes・resource値だけです。URL、query、filename、Cookie、Authorization、ファイル内容は保存しません。解析と取得要求はjob状態遷移で一度だけ数え、Queue retryや同一job再実行では増やしません。実ファイル取得はUIがクリックごとに発行する非秘密のattempt IDをHMAC fingerprint化して48時間だけ保持し、同じクリックから生じるRange／ブラウザ再試行を1回へまとめます。別のクリックは別の取得として数えます。

「Downloader対象分の追加料金試算」は2026-09-05に確認したCloudflare公式料金を使い、Downloader単独で月間付帯枠を消費した場合の超過分を概算します。成功処理から観測できるContainer CPU・wall time・作業領域、Worker／Queue／R2操作、R2保持時間を対象にし、R2は公式の請求単位への切り上げも反映します。Workers CPU、D1 rows、失敗Containerの実使用量、実際のContainer起動待機はWorker内で正確に帰属できないため「取得不能」とし、基本料金5 USDも含めません。アカウント全体で共有される枠と正式請求額の正本はCloudflare Billingです。料金表は変更され得るため、公開前に公式の[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Containers](https://developers.cloudflare.com/containers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)を再確認してください。

動画変換は `PASS_THROUGH`、`REMUX`、`PARTIAL_TRANSCODE`、`FULL_TRANSCODE`、`REJECT` の計画を実体検査後に選びます。互換H.264/AACはcopyを優先し、非互換streamだけを変換します。実ffprobeから確定したplanで映像再エンコードが必要な場合だけ1080p/30fps換算240秒の事前予算を適用し、音声だけの変換は拒否しません。ffmpeg/ffprobeはshellを使わず固定argv・ローカル入力・`file,pipe` protocolだけで実行します。

HLS/DASHはmanifest・redirect・参照URLごとに公開HTTP(S)宛てか再検証し、暗号化、DRM、終了点のないライブ配信、過大manifestを拒否します。Containerの外向き通信もprivate/link-local/metadata CIDRを拒否します。

YouTubeは公式ポリシーに合わせ、公開動画のメタデータ解析表示までとし、本体取得は権利確認後もHTTP 451で拒否します。ログインCookie、private/member/Premium、DRM、ライブ、地域制限・bot対策回避は利用せず、失敗をGeneric/Chromium fallbackへ迂回させません。

解析で確定したDirect/HLS/DASH/yt-dlp routeは、元URLのHMACと結び付けてAES-GCM暗号化capabilityとして短期保持します。取得時の再探索は行わず、URL・route・queryを公開APIやログへ返しません。D1の解析タイトル等とcapabilityは解析終了後1時間でscrubし、履歴には送信先hostnameだけを残します。

## 制限

- 通常最大2 GiB、長時間音声になり得るTwitter/X Spaces相当は512 MiB
- 処理時間最大12分、同一Identityの同時処理1件、Container最大2 instance
- 動画最大3時間、8K以下、stream 16本以下、動画stream 1本
- ログイン必須、DRM・暗号化stream・ライブ配信・認証必須コンテンツは非対応
- 一時ファイルは処理終了時に削除。R2は12時間のQueue削除と10分Cronを正本とし、1日R2 lifecycleを最終防衛線にする

Cloudflare ContainersはWorkers Paid契約とDockerが必要です。Containerが利用できない環境ではWorkerだけで危険な代替取得をせず、公開を停止したままにします。

## 起動と再試行

解析は軽量な`/ready`でHTTP受付とdrain状態だけを確認し、ClamAVを起動しません。取得前の`/health`で定義署名・鮮度を確認し、必要時にclamdを起動してYARAの正常性まで確認します。実スキャンでも定義・エンジンを再確認します。`/ready`は配信許可ではありません。Containerは処理後に明示停止し、常駐時間は延長しません。

検出、偽装形式、破損、サイズ・メディア制限など既知の確定拒否は、有効なprocessing tokenでD1をfailedへ確定した後に終了します。同じjobの再配送で再取得・再検査しません。未知の失敗、通信・エンジン・定義異常、timeoutは既存の最大4回／DLQ処理を維持します。

工程別計測と今回の判断・実測・制約は[性能調査](PERFORMANCE-2026-09-05.md)を参照してください。

## ClamAV・YARAとContainer更新

ClamAV 1.4.6 LTSをchecksum固定した公式packageから導入します。定義はContainer起動時に外部更新せず、image build時の同版`freshclam`を必須にしてimageへ固定します。日次自動更新・期限前通知は[定義更新手順](DEFINITION-UPDATES.md)に従います。通常のコード公開・緊急手動build時は`wrangler.jsonc`の`containers[0].image_vars.CLAMAV_DEFINITION_REFRESH`を当日の固有値（例: `2026-09-06-manual-1`）へ進めてください。この値が定義更新layerだけを確実にcache bustします。同じ値での再buildは意図的にcacheを再利用します。

`main`、`daily`、`bytecode`を個別に存在・署名検証し、鮮度は`daily.cvd/.cld`内部のbuild timestampだけで判定します。いずれかの欠落・署名異常、dailyの7日超、scanner timeout・異常終了は`/health`と実スキャンの両方でfail closedです。`clamd`は2 GiBの`MaxFileSize`・`MaxScanSize`・`PCREMaxFileSize`、再帰・展開・PCRE・bytecode上限と`AlertExceedsMax`を明示します。さらに64 MiB単位（1 MiB overlap）の全域stream scanを重ね、部分検査や上限超過をclean扱いしません。通常検査はexit code 0だけでなく対象ファイルの明示的な`OK`応答を必須にします。分割検査は元ファイルと同じ構造・offset解釈ではないため、同等性を確認できるまで維持します。

独立した第二検査は公式YARA CLI 4.5.8です。公式source archiveのSHA-256を固定し、ルールはContainer build時にcompile・checksum化します。外部ルールは`Neo23x0/signature-base@278165d7845decece517f756cf92ff4a41938d1e`から誤検知範囲を限定できる2ファイルだけを選び、全feed、generic、experimental、hunting、Office、web-shell系は取り込みません。YARAの欠落・checksum不一致・timeout・error・matchはいずれもR2保存前にfail closedします。PASS_THROUGH、REMUX、変換のいずれも、R2へ保存する最終成果物に対してClamAV＋YARA＋SHA-256を1回だけ実行します。検査前後で同一file identityを照合し、途中で実体が変化した場合もfail closedにします。変更後はContainerをstagingでbuildし、`/health`、EICAR、YARA安全fixture、既定PCRE上限より後方のmarker、正常media fixtureを通過してからrolloutしてください。

Containerは非root UID `10001`で実行し、`/app`とClamAV定義は読み取り専用、作業データは`/work`だけへ置きます。`enableInternet=false`を既定にし、HTTP/HTTPSはWorker側の検証済みoutbound handler、R2 uploadは`outboundByHost`だけを経由します。各Container instanceには解析元hostとそのsubdomain、解析済みrouteから検証した配信host、内部R2だけを動的allowlistとして設定します。別hostへのredirectや埋め込みは明示adapter等で許可hostを確定できない限りfail closedです。外向きrequestはGET/HEADと、公開YouTube extractorが必要とする限定POSTだけを許可し、許可した`Accept`・`Range`系header以外は再構築します。Cookie、Authorization、Referer、Origin、Forwarded、利用者User-Agentは転送しません。80/443以外の任意TCPは許可しません。Python側でもscheme・credential・port・禁止host・IP literalを拒否し、Cloudflareの透過interception DNS利用時は公開hostnameの最終送信をWorker側で再検証します。HTTPS outbound interception用CAは起動時だけ注入されるため、非root entrypointが公開CA束と結合し、Python・yt-dlp（必要なextractorのみcurl-cffi impersonation）・ffmpeg・Chromiumへ同じ信頼束を渡します。CAや外部credentialをimageへ焼き込みません。

Cloudflare Workersから外部originへ送る通信では、プラットフォーム仕様上`CF-Worker: tanaka-note.com`が付与されます。利用者IPは固定のCloudflare Workers addressへ置き換えますが、運営zoneまで秘匿するにはCloudflare外の固定Privacy Relayが別途必要です。Relayはアクセス制限・地域制限回避やIP rotationには使用せず、運用先・固定費・abuse対応を決めてから導入してください。

最大12分の処理に対し、download、軽量検証、ffmpeg、最終成果物のClamAV＋YARA検査、R2 uploadは単一の絶対deadlineを共有します。clamd再起動も残時間を超えて待機しません。取得用Container health cold startは最大90秒、Workerからの本処理は最大750秒で中断し、Queueの15分wall-clock内にD1更新・retry用の余裕を残します。Containerは署名済みjob grantで実処理段階を通知し、D1には取得時のContainer起動、取得、検証、変換、最終検査、R2保存の実測時間だけを記録します。追加の構造化ログはClamAV通常／分割、YARA、SHA-256、解析と停止RPCの経過時間を分離します。cgroup v2が利用できる場合は稼働中clamdを含むCPU時間を記録し、利用不能時は部分計測であることを`cpuScope`で明示します。工程内訳と合計は重複するので足し合わせません。起動前・停止後やCloudflare側のCPUは含みません。過去のCPU値は再集計せず、旧値に常駐clamdが含まれない点に注意してください。RSSはプロセス単位の最大値で、Container全体の使用メモリではありません。Container rolloutはactive instanceを15分保護する`rollout_active_grace_period`を設定しています。さらにSIGTERM後は新規HTTP処理を503で拒否し、実行中のffmpeg・ClamAV・YARA・R2 uploadが終了するまでdrainします。失敗したQueue deliveryはprocessing leaseの失効後に再取得されます。

## Secretsと初回公開

Gitへ保存しない次のSecretが必要です。

- `SESSION_SECRET`
- `URL_ENCRYPTION_KEY`（32 byte相当の高entropy値）
- `INTERNAL_SIGNING_SECRET`

さらにDownloader D1、private R2、Queue、DLQを作成し、`wrangler.jsonc`のD1 IDを実値へ置換します。Security D1 migration `0011_downloader_service.sql` とDownloader migration `0001`〜`0004` を順に適用後、Security/Downloader Workerを揃えて公開します。Lifecycleは `pnpm run r2:lifecycle` で適用します。

## 検証

```text
pnpm run check
pnpm run test
pnpm run test:browser
pnpm run deploy:dry
```

Dockerが使える環境ではContainer imageをbuildし、実ffmpeg/ffprobe/ClamAVを含むformat fixture試験も行います。依存物のライセンスは `THIRD_PARTY_NOTICES.md` に記録しています。

## 2026-09-05 最終計測・料金表示の補正

`scan_ffprobe_failed`はsignal終了・メモリ不足・未知の異常終了も同じcodeになるため、`scan_ffprobe_invalid`（JSON応答不正）とともに上限付き再試行へ戻す。stderrの文言だけで内容不正と断定しない。正常に解析された結果への`scan_invalid_media_stream`等の確定拒否は再試行しない。配信禁止、token CAS、4 delivery／DLQ、deadlineは維持する。

追加migration `0004_downloader_final_metrics.sql`はready時の利用日（JST）・利用者を固定し、uploadを勝ち取った元processing tokenを最終計測用に保持する。最終応答はこのtokenと未確定条件のCASで一度だけ反映し、同一SQL transaction内のtriggerでCPU・wall・peakとmemory/disk参考値を差分補正する。日付またぎ・ready後の削除でも元の日へ反映する。古いattempt／二重応答は更新せず、累積CPU・wallが下がる応答でも既存値を減らさない。最終応答紛失やDB更新失敗時は暫定値のまま残り、計測のために再取得はしない。成功件数と最終応答受信件数を混同しない。

旧memory/disk集計の固定120秒はidle fallbackを基にした仮定であり実測ではなかった。新規集計は実測wall（成功処理区間）の秒数×割当6 GiB／12 GBとし、起動／解析／health／停止／失敗／再試行を補完しない。release RPCの完了は課金終了ではない。旧120秒込みの日次行は保持して新料金試算から除外し、旧CPU（常駐clamdを含まない部分計測）も推測で書き換えない。表示は対象分の小計で、付帯枠をDownloader単独で利用できる仮定を明記する。他サービスとの共有枠、未計測のWorkers CPU・D1・DO・Logs、基本料金があるため、0 USDでも無料や請求上限を意味しない。欠測のContainer CPU/memory/diskは取得不能とする。[公式Container料金](https://developers.cloudflare.com/containers/platform/pricing/)を2026-09-05に再確認した。

開始時の本番はWorker `ecc44ac9-ea15-42e0-9751-1744f88b5a95`、Container version 7。読み取りでは過去成功8件のジョブCPU合計56,605 ms・wall合計387,150 msが日次値と一致しており、本番で差が生じていたとは断定しない。旧実装の未補正はSQLite再現テストで確認する。過去値の確実な加算元が残っていないため、migrationは既存行を再集計・推測補完しない。

公開は処理中・待機中ジョブを確認し、`pnpm exec wrangler d1 migrations apply downloader-db --remote`で0004を先に適用後、Container変更がないため`pnpm exec wrangler deploy --containers-rollout=none`でWorkerだけを更新する。切り戻しは旧Worker `ecc44ac9-ea15-42e0-9751-1744f88b5a95`へ戻せる（追加列は後方互換、Containerは変更なし）。0004は削除せず履歴を保持する。旧Workerへ戻すと最終補正・新表示は停止し、新規の最終値は暫定扱いになるため、復旧後に推測で加算しない。

検証: Node 52件PASS、Windows Python 112件中87件PASS・外部ツール依存25件skip。ffprobe異常終了はmockで再現し実エンジン試験とは区別する。SQLite実行で旧未補正、最終補正、日付またぎ、異なる利用者、CAS競合、R2 upload再送、transaction rollback、履歴保持を確認した。Containerコードは変更せず、通常動画や大容量の本番取得試験は追加しない。全サイト契約テストのcalculator既存build不一致は今回の回帰と分離する。

## URL解析の中止

解析画面と最近の処理の「中止する」は、認証済み・同一OriginのJSON POST `/downloader/api/jobs/:jobId/cancel` を使用する。所有者の `analyzing` 行をCASで `cancelled` に確定してtoken・lease・progressを消去した後、`analysis-{jobId}` の専用RPCで実行中Containerを強制停止する。`cancelled_at` は中止確定、`cancel_stop_completed_at` は停止RPC完了の記録であり、Cloudflareの課金終了時刻ではない。

DOにも永続的な中止記録を残し、起動待ちのfetchをabortしてdestroyする。停止前から進行中だった起動が遅れて終了する場合に備え、待機中fetchの終了後にもdestroyする。通常の完了時は従来どおりrelease/stopを使用する。ジョブIDは再利用しない。中止済みQueue配送は再解析せずackし、遅い解析結果は既存のstatus/token CASにより破棄する。停止確認に失敗してもD1の中止は取り消さず、履歴の中止ボタンで停止だけを再試行できる。監査イベントは `downloader_analyze_cancelled`、集計は `lifecycle/cancelled` とし、失敗には加算しない。

解析leaseはready 90秒 + adapter 60秒 + analyze 120秒 + 終了処理余裕60秒から330秒を算出する。各処理のtimeoutとQueue再試行回数は延長しない。

追加migration `0005_downloader_analysis_cancel.sql` は状態CHECKを更新するためテーブルを再作成する。既存ジョブ全列・配信履歴・利用集計・既存triggerを維持し、配信履歴を復元してからtriggerを戻すため再集計しない。公開前に稼働ジョブと適用済みmigrationを確認し、D1 Time Travel bookmarkを控え、Wrangler migrationで0005を先に適用する。Workerのみ `wrangler deploy --containers-rollout=none` で公開し、現行Container imageを維持する。

切り戻しは公開前に控えたWorker versionへ戻す。0005の追加状態・列と既存履歴は残す。旧Workerでもcancelledは解析再開対象にならないが、中止UIと停止再試行APIがなくなるため、停止未確認ジョブがある場合は旧版へ戻す前に今回のRPCで停止を完了させる。Container imageの切り戻しは不要。Time TravelによるDB全体の巻き戻しは新しい履歴を失うため通常の切り戻しには使用しない。

対象検証: `node --test test/downloader-cancellation.test.js`（SQLite・Container mock）、`node test/downloader-cancellation.browser.mjs`（Chromium・mock API）。実Containerを起動するテストではない。

## 一時ファイルの手動削除と1時間の期限

`DOWNLOAD_TTL_SECONDS=3600`、期限時刻までのQueue遅延配送、10分Cron、`downloads/`限定のR2 Lifecycle（object削除・未完了multipartの破棄とも3600秒）を併用する。R2.put成功後、READY更新SQLのCURRENT_TIMESTAMPをdownloaded_atとし、同じSQLでexpires_atをその時刻+3600秒に確定する。UPDATE RETURNINGで正本の期限を受け取るため、期限取得の追加DB往復はない。取得・変換・検査時間を保管時間から差し引かず、既存のREADY履歴の期限は変更しない。期限を過ぎた新しい配信要求はR2削除を待たず410で拒否する。Queue/CronやLifecycleの実行は非同期であり、物理削除完了の厳密な時刻保証ではない。R2 Lifecycleには通常期限後24時間以内の処理遅延があり得るため、これは補完策として扱う（https://developers.cloudflare.com/r2/buckets/object-lifecycles/）。

手動削除はR2削除成功後にD1をdeletedにし、UIもdeletedを再取得して確認する。R2失敗時は参照を保持して再試行可能にする。遅れて終了した期限回収はdeleted/cancelledを上書きしない。READY画面は次のジョブで操作ボタンを復元し、前のジョブの削除応答で別ジョブのリンクを隠さない。取得・Container起動・変換・ClamAV/YARA・保存の通常処理には待機や削除リトライを追加しない。

対象テスト: `node --test test/downloader-deletion.test.js test/downloader-domain.test.js test/worker-contract.test.js test/downloader-cancellation.test.js`、`node test/downloader-deletion.browser.mjs`。DBはローカルSQLite、R2とブラウザAPIはmockであり、本番オブジェクトの削除テストは行わない。公開はWorkerを`--containers-rollout=none`で更新し、`wrangler r2 bucket lifecycle set t-room-downloader-temp --file r2-lifecycle.json`を実行後、APIで3600秒の設定を再取得する。Container imageの更新は不要。

内部upload grantの署名済みexpiresAtは認証用だけに使用し、processing leaseの期限を使う（既存wire形式は維持）。成果物のexpires_atには流用しない。READY確定後の正本expires_atを基準に削除Queueを予約し、waitUntilで保存応答から分離する。予約失敗はdownloader_expiry_queue_failedとして記録し、Cron/Lifecycleが回収する。同じuploadの再送でも保存期限を延長しない。早着・古い期限Queueは新しい期限前に削除せず、期限超過行はCronが回収する。

期限を過ぎてもR2削除が未確認ならobject_keyを残す。削除失敗はdownloader_object_delete_failedとして記録し、Queueの既存再試行または次回Cronで再試行する。R2削除成功またはR2 object欠落の確認後にだけobject_keyを消し、deleted_atを記録する。公開jobのdeletionConfirmedと履歴では期限終了・削除未確認／削除確認済みを区別する。READY表示は「一時保管期限」と実日時を直接表示し、12時間表記のDOM置換は使用しない。Queue/Cronが主系、Lifecycleは最終保険であり、物理削除時刻の保証とは区別する。

期限の対象テスト: `node --test test/downloader-retention.test.js test/downloader-final-metrics.test.js test/downloader-processing.test.js`。0秒・600秒処理fixture、署名grant期限、READY時刻との3600秒差、削除予約失敗・非同期応答、期限後配信拒否、古い削除イベント、upload CAS再送をローカルで確認する。


## 視聴ページの本編補助探索

`MAIN_VIDEO_FALLBACK=true`で補助探索を有効、`false`で単独停止する。Direct / adapterの成功結果と、yt-dlp専用extractor（YouTube等）の90秒上限を維持する。未知サイトは軽量HTML → 最大8秒のyt-dlp → Chromium / 本編補助探索。HTMLで一意のmain/player iframeを確認できた場合、frameを読めないdump-domを省く。metadata_timeout / unsupported / generic extractor失敗など未確定の解析障害は残り時間内で次の方式へ進む。DRM・login・geo・policy・明確なaccess拒否 / bot challenge・SSRFでは進めない。

Workerの120秒期限をadapter・通常解析・補助探索で共有する。従来Chromiumを待つ段階では残り12秒を補助探索と終了処理に残す。専用yt-dlpの既存予算を削らず、子プロセス側にも絶対期限を渡して全体を監督する。補助探索は準備・ブラウザ・候補検証を合わせて最大10秒、残り1秒未満では開始しない。解析完了後の未発見/拒否はtoken CASでfailedに確定してQueueをackし、同じ長い探索を再配送で繰り返さない。Container起動失敗等の基盤障害には既存の上限付きretryを維持。中止はD1 cancelled確定後のContainer destroy、通常終了はrelease/stopを維持する。

JSON-LD VideoObjectに加え、main/player領域の一意のiframeと、そのframe内でJS生成されたvideoにも対応する。プレイヤーのcurrentSrcと実通信、または同じframeの一意のメディア候補を照合する。複数候補・広告/関連動画・ログイン/購読/DRMは採用しない。識別済みvideoのnative playを1回だけ試し、任意リンクや広告をクリックしない。メディア通信は観測後abortし、検出候補を既存のDirect/manifest/DRM/サイズ検証へ通して取得経路を固定する。最終ClamAV/YARAは維持。

ページHTMLで確認した1段のmain iframe、ページとiframeが明示参照するscript（各最大8）だけを依存候補にする。Workerがpublic DNSを検証後、job専用allowlistへ最大12のexact hostを期限付きで追加する。`MAIN_VIDEO_PAGE_HOSTS`は任意の補助設定で必須ではない。Cookie / Authorization / POST / WebSocket / Service Workerは使わない。補助ブラウザは32要求・個別1MB・合計2MB、iframeの軽量事前読込は1MBまで。redirectは追跡しない。実行時に外部iframe自体を生成する任意JS、多段iframe、任意APIやCookieが必要なプレイヤー、未許可hostの子playlist、複数候補からの推測には対応しない。

Cloudflare透過DNSのPython例外は既存経路のため維持。補助経路ではContainerProxyの専用handlerを使い、exact host制限と要求ごとのpublic A/AAAA確認・private/special-use拒否をWorker側でも行う。リダイレクトを自動追跡せず、Cookie等を落としたCloudflare public fetchで接続する。VPC/内部service bindingは使わない。PythonのDNS例外だけを根拠に送信を許可しない。最終取得にも専用handlerをroute属性で引き継ぐ。通常経路の送信handlerは変更せず、再配送時に古い補助handlerを既存setAllowedHosts RPC内で解除する。生URL/query・本文・HARはログに出さない。

費用: 既存成功時に補助ブラウザは起動しない。通常解析の子プロセス監督と未知サイトのHTML先行による小さなオーバーヘッドはある。該当未発見ジョブのみ最大10秒のContainer実行と軽量D1/DO・Proxy/DNS要求が増える（claimはDO、追加D1更新なし）。これはCPU実測・請求額ではなく上限設定であり、起動/停止課金を含む料金上限ではない。新しい常時稼働枠やBrowser Rendering契約は作らない。Playwrightを既存Chromiumで使う分、image容量は増える。

対象検証: `node --test test/main-video.test.js test/downloader-cancellation.test.js test/worker-contract.test.js test/downloader-processing.test.js`、Python `tests/test_main_video.py` / `test_resolver.py` / `test_ssrf.py`。実ブラウザは`MAIN_VIDEO_TEST_BROWSER=/usr/bin/chromium`を指定して小容量loopback fixtureだけを使う。fixtureテストだけでprivate-IP拒否を緩和し、本番設定には持ち込まない。指定されたimage-share代表URLは既存adapter 468ms・Direct確認969ms（Windowsローカル1回の観測、2026-09-07）。旧mainと同じ成功処理を使い、追加探索なし。変更前後の本番時間や全サイト成功率を保証する値ではない。

Containerコード公開は`ClamAV daily definitions`の手動入力`release_code=true`を使える。通常の日次実行は既存の定義だけを更新する。明示コード公開ではcheckoutしたDockerfileをbuildし、network noneの小容量browser/process fixture、署名・生成日時・正常fixture/EICARを確認してからregistry push・既存lease/job/grace保護でrolloutする。失敗した候補は本番へ反映しない。成功時のsource_imageを新コードのdigestへ更新し、翌日の日次更新が旧コードへ戻ることを防ぐ。Container完了後にWorkerを`wrangler deploy --containers-rollout=none`で公開し、build/JS一致を読み戻す。DB migration不要。切り戻しは先に`MAIN_VIDEO_FALLBACK=false`でWorkerを更新（Container更新不要）。image自体を戻す場合は定義更新手順に従い、期限内の検証済みprevious_imageだけを利用する。

公開記録（2026-09-08 JST）: 実装`89765b7`、公開コード`1ea791b`。対象Node 65件（変更箇所ごとの実行の合算）、Python unit 40件PASS。Windows ChromiumでJS/blob・iframe・広告除外・曖昧候補・login拒否の5ケースを確認。初回Linux fixture実行は失敗し、本番ラッパーと同様の書き込み可能HOMEをCIにも設定後、[公開workflow 34136475258](https://github.com/tanaka-note/t-room-site/actions/runs/34136475258)でLinuxの7テスト（上記5ブラウザケースを含む）・実ClamAV正常/EICAR・署名/鮮度・YARA正常性を通過。初回失敗時は未公開。初回の詳細stderrは取得できず、HOME修正後の成功と区別して記録する。全E2E・大容量取得・Cloudflare上の補助探索end-to-end/敵対的DNS切替試験は実施していない。

本番Worker `3fda4375-5ea2-4944-b287-a69efa8984ac`、deployment `a51190ec-da71-4565-bcaf-216e3b300fc7`、build `downloader-fcf2a3846067`。本番HTML build、downloader.js/delete-controls.jsのmain一致、未認証jobs API 401、既存D1/R2/QueueとTTL3600・Cron10分・新機能flag=trueを確認。Container version 11、digest `sha256:bd6edcda383bdc7c12f08b9b7942c555f81e63a4541b2a7b5e9fd2a538abab39`、rollout `5b911d08-4673-4d8d-a2fb-60e817e3fc13` completed・activeなし。定義生成`2026-09-07T06:24:32Z`・7日期限`2026-09-14T06:24:32Z`、D1 image/source_image一致。Workerを前版へ戻す場合のversionは`ab093ef1-6823-4f0b-bdb4-d4c0a2729f59`（Containerを戻す操作ではない）。通常は新機能flagだけfalseにして既存成功経路を維持する。


### 2026-09-08 埋め込み解析の待ち時間修正

本番旧ジョブは4分3秒後にextractor_failed。待機中もanalyzingを表示し、Queueの30/60/120秒再試行待ちが含まれていた。改修後の対象URL解析はWindowsローカル1回で0.734秒、bot_challengeで拒否（ページ側Cloudflare確認）。動画取得成功ではなく、拒否を長時間再試行しないことの確認。旧本番とローカルの数値は環境が異なり性能倍率に換算しない。Cloudflare上の同URL再実行や動画本体取得は行わない。


公開確認: 実装 `ac05efefbfc3c432ad7bef82a0af36a68b9902d3`、[workflow 34183905397](https://github.com/tanaka-note/t-room-site/actions/runs/34183905397) success。対象Node70件、Python unit44件（resolver29・main-video9・SSRF6）、Windows実ブラウザ6ケースPASS。Windows初回の拒否fixtureはPlaywright起動timeoutで失敗し、当該ケースの再確認でPASS。Linux候補では実yt-dlpのオフライン専用extractor判定を含む12テストが成功。ClamAV実スキャンは再実施せず、本番の定義/エンジンを継承して署名・鮮度・ルール整合を再確認。全E2E・大容量転送・Cloudflare上での対象URL再投入は未実施。

本番build `downloader-bc6772b65629`、Worker `11ce3f56-8db9-484e-ac2e-0be8cd0d376b`（100%）、deployment `51ea6ac2-d7f8-45b7-9d05-431067fc9087`。Container13 / digest `sha256:b9e49c44884574d0a266ae286bd667246761d20a2cfa1e1c72fd80a9087f8208`、rollout `e39fe4f9-2fb1-4a7d-ae90-da907b44eb63` completed・activeなし。mainとHTML build/配信JS一致、未認証jobs 401、TTL3600・10分Cron・D1/R2/Queue・flag=trueを確認。定義生成2026-09-07 06:24:32 UTC、期限09-14同時刻、D1 image/source_image一致。

切り戻し: 補助探索だけならMAIN_VIDEO_FALLBACK=false。解析順序も戻す場合はWorker前版 `3fda4375-5ea2-4944-b287-a69efa8984ac` と、定義更新手順で鮮度を再検証したprevious image `sha256:0ddbf30cfc90877d567310eb06f6c34474188ab01c71c60ff9fe58b05ba15d38` を組み合わせる。進行中job/drain・active rollout・D1 image/source_image整合を省略しない。

### 解析拒否の診断（2026-09-08）

Resolver→子プロセス→Container HTTP→Worker→監査で、固定の工程名・発生元・HTTP statusを引き継ぐ。補助探索のHTTP/redirect/通信拒否を一律`unavailable`にしない。Worker送信handlerは相手由来の診断markerを上書きし、上流応答と自前のpolicy拒否を識別する。SDKがhandler到達前に返す応答など、発生元を確認できないものは`unknown`のままにする。URL/query、Cookie、Authorization、本文は診断へ渡さない。失敗ログにはjob ID、起動待ちと解析の経過時間を含める（CPU時間ではない）。監査は既存のtoken付きCAS成功後だけ記録する。

対象ページの通常Chromeでは、main playerに同一ホストHLSの参照があり、明確なPlay buttonを1回押すとblob再生へ移った。関連previewとは区別して確認し、直後にページを閉じて転送を止めた。このDOMでは本編iframe必須とは確認できなかった。一方、Cookieを持たないWindows HTTPは既存/ブラウザ相当UAとも403＋`cf-mitigated: challenge`、新規Chromium contextは307→403 challengeでvideo要素へ到達しなかった。通常Chromeとの環境差の具体的原因（profile状態等）は未確定。UA/Acceptの置換だけで解決したとは扱わない。[Cloudflareのchallenge応答仕様](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)に従い、確定拒否をfallbackで回避しない。

この修正は観測した診断欠落の是正であり、対象動画の取得成功やサーバーからのchallenge通過を実現したものではない。Cookie/POST/認証・通信先制限は維持し、追加待機・リクエスト・ブラウザ起動を増やさない。正常経路の変更は診断headerの付与のみで、速度差や請求増分は未計測。エンジン・定義・Container枠は変更しない。
