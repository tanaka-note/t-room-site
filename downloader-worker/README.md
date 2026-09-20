# T-lain Downloader

権利を持つメディアをURLから解析し、明示的な確認後に隔離Containerで取得・検査して、非公開R2へ一時保存する非公開ツールです。再ダウンロード可能期間はREADYになってから1時間です。公開導線、サイト内検索、sitemap、OGPは持ちません。期限内は、認証済みの同一利用者が履歴から何度でも再ダウンロードできます。一般Identityの利用許可は、オーナーがSecurity Centerで再認証して明示追加したservice linkだけを使用します。

## 構成

- Worker: Security Centerの一回限りhandoff、セッション、所有者分離、rate limit、Queue、D1台帳、R2配信・期限削除
- Queue: URL解析と取得をHTTP requestから分離し、URLを暗号化して配送。取得は1件ずつ冪等に処理し、processing tokenとleaseで重複実行を遮断
- Container: site固有adapter → Direct → yt-dlp → Generic HTML → Chromium fallbackの順で解析し、解析時に確定した取得routeだけを実行
- Media pipeline: 隔離Container内でlibmagic・magic number・ffprobeによる軽量検証後、動画をMP4/H.264/AAC/yuv420pへ必要最小限で正規化し、R2へ保存する最終成果物だけをClamAVと独立YARAで1回検査
- R2: `t-room-downloader-temp`の`downloads/`だけを使用。Worker経由の所有者認証なしでは取得不可

## 親アカウント向け利用状況

第一管理者の`owner` service linkから発行された有効なPasskey sessionだけが、`/downloader/api/admin/usage`と画面内の「利用状況」を使用できます。一般IdentityはUIが非表示になるだけでなく、Worker側で403になります。今日・今月・累計について、解析／取得要求、処理成功、実ファイル取得開始、削除／期限切れ、取得元・R2保存・配信容量、正規化方式、固定分類したsecurity結果を確認できます。

長期保存する統計はJST日次の件数・bytes・resource値だけです。URL、query、filename、Cookie、Authorization、ファイル内容は保存しません。解析と取得要求はjob状態遷移で一度だけ数え、Queue retryや同一job再実行では増やしません。実ファイル取得はUIがクリックごとに発行する非秘密のattempt IDをHMAC fingerprint化して48時間だけ保持し、同じクリックから生じるRange／ブラウザ再試行を1回へまとめます。別のクリックは別の取得として数えます。

「Downloader対象分の追加料金試算」はCloudflare公式料金を使い、Downloader単独で月間付帯枠を消費した場合の超過分を概算します。成功処理から観測できるContainer CPU・wall time・作業領域、Worker／Queue／R2操作、R2保持時間を対象にし、R2は公式の請求単位への切り上げも反映します。Workers CPU、D1 rows、失敗Containerの実使用量、実際のContainer起動待機はWorker内で正確に帰属できないため「取得不能」とし、基本料金5 USDも含めません。アカウント全体で共有される枠と正式請求額の正本はCloudflare Billingです。料金表は変更され得るため、公開前に公式の[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Containers](https://developers.cloudflare.com/containers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)を再確認してください。実装時の料金確認日は[性能・費用調査](../docs/history/downloader/performance-2026-09-05.md)に記録しています。

動画変換は `PASS_THROUGH`、`REMUX`、`PARTIAL_TRANSCODE`、`FULL_TRANSCODE`、`REJECT` の計画を実体検査後に選びます。互換H.264/AACはcopyを優先し、非互換streamだけを変換します。実ffprobeから確定したplanで映像再エンコードが必要な場合だけ1080p/30fps換算240秒の事前予算を適用し、音声だけの変換は拒否しません。ffmpeg/ffprobeはshellを使わず固定argv・ローカル入力・`file,pipe` protocolだけで実行します。

HLS/DASHはmanifest・redirect・参照URLごとに公開HTTP(S)宛てか再検証し、暗号化、DRM、終了点のないライブ配信、過大manifestを拒否します。Containerの外向き通信もprivate/link-local/metadata CIDRを拒否します。

YouTubeは公式ポリシーに合わせ、公開動画のメタデータ解析表示までとし、本体取得は権利確認後もHTTP 451で拒否します。ログインCookie、private/member/Premium、DRM、ライブ、地域制限・bot対策回避は利用せず、失敗をGeneric/Chromium fallbackへ迂回させません。

解析で確定したDirect/HLS/DASH/yt-dlp routeは、元URLのHMACと結び付けてAES-GCM暗号化capabilityとして短期保持します。取得時の再探索は行わず、URL・route・queryを公開APIやログへ返しません。D1の解析タイトル等とcapabilityは解析終了後1時間でscrubし、履歴には送信先hostnameだけを残します。

## 制限

- 通常最大2 GiB、長時間音声になり得るTwitter/X Spaces相当は512 MiB
- 処理時間最大12分、同一Identityの同時処理1件、Container最大2 instance
- 動画最大3時間、8K以下、stream 16本以下、動画stream 1本
- ログイン必須、DRM・暗号化stream・ライブ配信・認証必須コンテンツは非対応
- Container内の一時ファイルは処理終了時に削除。R2成果物はREADYになってから1時間後を再ダウンロード期限とし、期限時刻に合わせてQueue削除を予約する。10分Cronで削除漏れを回収し、`downloads/`のR2 Lifecycle（3600秒）を最終防衛線にする。削除は非同期であり、1時間以内の物理削除完了を保証しない

Cloudflare ContainersはWorkers Paid契約とDockerが必要です。Containerが利用できない環境ではWorkerだけで危険な代替取得をせず、公開を停止したままにします。

## 起動と再試行

補助解析の`downloader_main_video`失敗ログは、既存の`errorCode`・`stage`・`source`・`httpStatus`に加え、固定分類の`operation`（開始権取得、設定、依存先検証、送信制御設定、探索、成果物候補検証など）と`errorName`を記録する。例外本文・stack・URL・Cookieは追加記録しない。`analysis_execution_failed`だけではサイト側の拒否とは判断せず、操作分類と既存の送信元診断を照合する。この診断追加は通信許可・解析期限・再試行回数を変更しない。

解析は軽量な`/ready`でHTTP受付とdrain状態だけを確認し、ClamAVを起動しません。取得前の`/health`で定義署名・鮮度を確認し、必要時にclamdを起動してYARAの正常性まで確認します。実スキャンでも定義・エンジンを再確認します。`/ready`は配信許可ではありません。Containerは処理後に明示停止し、常駐時間は延長しません。

検出、偽装形式、破損、サイズ・メディア制限など既知の確定拒否は、有効なprocessing tokenでD1をfailedへ確定した後に終了します。同じjobの再配送で再取得・再検査しません。未知の失敗、通信・エンジン・定義異常、timeoutは既存の最大4回／DLQ処理を維持します。

工程別計測の判断、実測、制約は[2026-09-05の性能調査](../docs/history/downloader/performance-2026-09-05.md)を参照してください。

## ClamAV・YARAとContainer更新

ClamAV 1.4.6 LTSをchecksum固定した公式packageから導入します。定義はContainer起動時に外部更新せず、image build時の同版`freshclam`を必須にしてimageへ固定します。日次自動更新・期限前通知は[定義更新手順](DEFINITION-UPDATES.md)に従います。通常のコード公開・緊急手動build時は`wrangler.jsonc`の`containers[0].image_vars.CLAMAV_DEFINITION_REFRESH`を当日の固有値（例: `<date>-manual-1`）へ進めてください。この値が定義更新layerだけを確実にcache bustします。同じ値での再buildは意図的にcacheを再利用します。

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
## URL解析の中止

解析画面と最近の処理の「中止する」は、認証済み・同一OriginのJSON POST `/downloader/api/jobs/:jobId/cancel` を使用する。所有者の `analyzing` 行をCASで `cancelled` に確定してtoken・lease・progressを消去した後、`analysis-{jobId}` の専用RPCで実行中Containerを強制停止する。`cancelled_at` は中止確定、`cancel_stop_completed_at` は停止RPC完了の記録であり、Cloudflareの課金終了時刻ではない。

DOにも永続的な中止記録を残し、起動待ちのfetchをabortしてdestroyする。停止前から進行中だった起動が遅れて終了する場合に備え、待機中fetchの終了後にもdestroyする。通常の完了時は従来どおりrelease/stopを使用する。ジョブIDは再利用しない。中止済みQueue配送は再解析せずackし、遅い解析結果は既存のstatus/token CASにより破棄する。停止確認に失敗してもD1の中止は取り消さず、履歴の中止ボタンで停止だけを再試行できる。監査イベントは `downloader_analyze_cancelled`、集計は `lifecycle/cancelled` とし、失敗には加算しない。

解析leaseはready 90秒 + adapter 60秒 + analyze 120秒 + 終了処理余裕60秒から330秒を算出する。各処理のtimeoutとQueue再試行回数は延長しない。

## 一時ファイルの手動削除と1時間の期限

`DOWNLOAD_TTL_SECONDS=3600`、期限時刻までのQueue遅延配送、10分Cron、`downloads/`限定のR2 Lifecycle（object削除・未完了multipartの破棄とも3600秒）を併用する。R2.put成功後、READY更新SQLのCURRENT_TIMESTAMPをdownloaded_atとし、同じSQLでexpires_atをその時刻+3600秒に確定する。UPDATE RETURNINGで正本の期限を受け取るため、期限取得の追加DB往復はない。取得・変換・検査時間を保管時間から差し引かず、既存のREADY履歴の期限は変更しない。期限を過ぎた新しい配信要求はR2削除を待たず410で拒否する。Queue/CronやLifecycleの実行は非同期であり、物理削除完了の厳密な時刻保証ではない。R2 Lifecycleには通常期限後24時間以内の処理遅延があり得るため、これは補完策として扱う（https://developers.cloudflare.com/r2/buckets/object-lifecycles/）。

手動削除はR2削除成功後にD1をdeletedにし、UIもdeletedを再取得して確認する。R2失敗時は参照を保持して再試行可能にする。遅れて終了した期限回収はdeleted/cancelledを上書きしない。READY画面は次のジョブで操作ボタンを復元し、前のジョブの削除応答で別ジョブのリンクを隠さない。取得・Container起動・変換・ClamAV/YARA・保存の通常処理には待機や削除リトライを追加しない。

対象テスト: `node --test test/downloader-deletion.test.js test/downloader-domain.test.js test/worker-contract.test.js test/downloader-cancellation.test.js`、`node test/downloader-deletion.browser.mjs`。DBはローカルSQLite、R2とブラウザAPIはmockであり、本番オブジェクトの削除テストは行わない。公開はWorkerを`--containers-rollout=none`で更新し、`wrangler r2 bucket lifecycle set t-room-downloader-temp --file r2-lifecycle.json`を実行後、APIで3600秒の設定を再取得する。Container imageの更新は不要。

内部upload grantの署名済みexpiresAtは認証用だけに使用し、processing leaseの期限を使う（既存wire形式は維持）。成果物のexpires_atには流用しない。READY確定後の正本expires_atを基準に削除Queueを予約し、waitUntilで保存応答から分離する。予約失敗はdownloader_expiry_queue_failedとして記録し、Cron/Lifecycleが回収する。同じuploadの再送でも保存期限を延長しない。早着・古い期限Queueは新しい期限前に削除せず、期限超過行はCronが回収する。

期限を過ぎてもR2削除が未確認ならobject_keyを残す。削除失敗はdownloader_object_delete_failedとして記録し、Queueの既存再試行または次回Cronで再試行する。R2削除成功またはR2 object欠落の確認後にだけobject_keyを消し、deleted_atを記録する。公開jobのdeletionConfirmedと履歴では期限終了・削除未確認／削除確認済みを区別する。READY表示は「一時保管期限」と実日時を直接表示し、旧表記のDOM置換は使用しない。Queue/Cronが主系、Lifecycleは最終保険であり、物理削除時刻の保証とは区別する。

期限の対象テスト: `node --test test/downloader-retention.test.js test/downloader-final-metrics.test.js test/downloader-processing.test.js`。0秒・600秒処理fixture、署名grant期限、READY時刻との3600秒差、削除予約失敗・非同期応答、期限後配信拒否、古い削除イベント、upload CAS再送をローカルで確認する。


## 視聴ページの本編補助探索

`MAIN_VIDEO_FALLBACK=true`で補助探索を有効、`false`で単独停止する。Direct / adapterの成功結果と、yt-dlp専用extractor（YouTube等）の90秒上限を維持する。未知サイトは軽量HTML → 最大8秒のyt-dlp → 本編補助探索。HTMLでプレイヤーを確認済みなら、広告等を先に選び得るgeneric extractorも省く。補助探索有効時はdump-domを起動せずPlaywright一回へまとめ、無効時は従来のChromium経路を維持する。metadata_timeout / unsupported / generic extractor失敗など未確定の解析障害は残り時間内で次の方式へ進む。DRM・login・geo・policy・明確なaccess拒否 / bot challenge・SSRFでは進めない。

Workerの120秒期限をadapter・通常解析・補助探索で共有する。従来Chromiumを待つ段階では残り12秒を補助探索と終了処理に残す。専用yt-dlpの既存予算を削らず、子プロセス側にも絶対期限を渡して全体を監督する。補助探索は準備・ブラウザ・候補検証を合わせて最大10秒、残り1秒未満では開始しない。解析完了後の未発見/拒否はtoken CASでfailedに確定してQueueをackし、同じ長い探索を再配送で繰り返さない。Container起動失敗等の基盤障害には既存の上限付きretryを維持。中止はD1 cancelled確定後のContainer destroy、通常終了はrelease/stopを維持する。

通常HTMLと描画後の解析はmain/player、広告/関連/preview除外、data-src、ページに紐付くJSON-LDを使い、先頭URLだけで本編を選ばない。同じ一つのプレイヤー内の複数sourceは代替形式として扱うが、複数プレイヤーを推測で選ばない。HTMLで一意の本編CDNが判明した場合はWorkerのDNS承認後に直接検証し、ブラウザも不要なscript事前読込も起動しない。描画が必要ならcurrentSrcと同frameの通信を照合し、拡張子なしのfetch/XHRはContent-Typeも使う。識別済みvideoのnative play、または同じ単一プレイヤー内の可視・一意・明示的な再生buttonを一回だけ操作し、任意リンク/広告/フォームは操作しない。blobを配信URLにしない。候補はDirect/manifest/DRM/サイズ検証を通してrouteへ固定し、最終ClamAV/YARAは維持する。

ページHTMLで確認した1段のmain iframe、ページとiframeが明示参照するscript（各最大8）だけを依存候補にする。Workerがpublic DNSを検証後、job専用allowlistへ最大12のexact hostを期限付きで追加する。`MAIN_VIDEO_PAGE_HOSTS`は任意の補助設定で必須ではない。Cookie / Authorization / POST / WebSocket / Service Workerは使わない。補助ブラウザは32要求・個別1MB・合計2MB、iframeの軽量事前読込は1MBまで。同一originの転送だけ最大3回、各hopでURL/DNS/要求数/期限を確認して手動追跡し、ブラウザの自動redirectへ任せない。最終HTMLの相対参照には検証済み転送先をbaseとして使う。cross-origin redirect、実行時に外部iframe自体を生成する任意JS、多段iframe、任意APIやCookieが必要なプレイヤー、未許可hostの子playlist、複数候補からの推測には対応しない。

補助経路は固定の通常Chrome形式UAをPython/browser/Workerで共有する。Refererは確認済みページ/iframeのoriginまでに縮め、Originはブラウザ要求で観測した場合だけ使用する。静的本編CDNの検証はページoriginのRefererのみを使用する。両者は送信先origin別にWorkerで正規化し、暗号化routeへ保存、manifest検証と実取得の送信境界で再適用する。ユーザーから任意headerは受け付けず、未登録originやHTTPS→HTTPには送らない。query/path/Cookie/Authorizationは引き継がない。別originのmanifest参照はDNS/allowlist対象だが、headerを無条件に継承しないので取得できない配信もある。既存の通常経路のUA/headerは維持する。

Cloudflare透過DNSのPython例外は既存経路のため維持。補助経路ではContainerProxyの専用handlerを使い、exact host制限と要求ごとのpublic A/AAAA確認・private/special-use拒否をWorker側でも行う。リダイレクトを自動追跡せず、Cookie等を落としたCloudflare public fetchで接続する。VPC/内部service bindingは使わない。PythonのDNS例外だけを根拠に送信を許可しない。最終取得にも専用handlerをroute属性で引き継ぐ。通常経路の送信handlerは変更せず、再配送時に古い補助handlerを既存setAllowedHosts RPC内で解除する。生URL/query・本文・HARはログに出さない。

費用: 既存成功時に補助ブラウザは起動しない。通常解析の子プロセス監督と未知サイトのHTML先行による小さなオーバーヘッドはある。該当未発見ジョブのみ最大10秒のContainer実行と軽量D1/DO・Proxy/DNS要求が増える（claimはDO、追加D1更新なし）。これはCPU実測・請求額ではなく上限設定であり、起動/停止課金を含む料金上限ではない。新しい常時稼働枠やBrowser Rendering契約は作らない。Playwrightを既存Chromiumで使う分、image容量は増える。

対象検証: `node --test test/main-video.test.js test/downloader-cancellation.test.js test/worker-contract.test.js test/downloader-processing.test.js`、Python `tests/test_main_video.py` / `test_resolver.py` / `test_ssrf.py`。実ブラウザは`MAIN_VIDEO_TEST_BROWSER=/usr/bin/chromium`を指定して小容量loopback fixtureだけを使う。fixtureテストだけでprivate-IP拒否を緩和し、本番設定には持ち込まない。

Containerコード公開は`ClamAV daily definitions`の手動入力`release_code=true`を使える。通常の日次実行は既存の定義だけを更新する。明示コード公開ではcheckoutしたDockerfileをbuildし、network noneの小容量browser/process fixture、署名・生成日時・正常fixture/EICARを確認してからregistry push・既存lease/job/grace保護でrolloutする。失敗した候補は本番へ反映しない。成功時のsource_imageを新コードのdigestへ更新し、翌日の日次更新が旧コードへ戻ることを防ぐ。Container完了後にWorkerを`wrangler deploy --containers-rollout=none`で公開し、build/JS一致を読み戻す。DB migration不要。切り戻しは先に`MAIN_VIDEO_FALLBACK=false`でWorkerを更新（Container更新不要）。image自体を戻す場合は定義更新手順に従い、期限内の検証済みprevious_imageだけを利用する。

## 解析診断とX送信制御

Resolver→子プロセス→Container HTTP→Worker→監査で、固定の工程名・発生元・HTTP statusを引き継ぐ。補助探索のHTTP/redirect/通信拒否を一律`unavailable`にしない。Worker送信handlerは相手由来の診断markerを上書きし、上流応答と自前のpolicy拒否を識別する。SDKがhandler到達前に返す応答など、発生元を確認できないものは`unknown`のままにする。URL/query、Cookie、Authorization、本文は診断へ渡さない。失敗ログにはjob ID、起動待ちと解析の経過時間を含める（CPU時間ではない）。監査は既存のtoken付きCAS成功後だけ記録する。

診断は対象動画の取得成功やサーバーからのchallenge通過を保証しない。Cookie、認証、通信先制限を維持し、診断のためだけに追加待機、request、browser起動を増やさない。engine、定義、Container枠も変更しない。

固定版yt-dlp 2026.08.19のX公開投稿経路は、空のguest activation POSTと固定TweetResultByRestId GETだけに公開application bearerを許可する（公開値のSHA-256と完全一致が必要）。数値guest tokenは同GETだけに転送し、利用者Cookie、CSRF token、任意Authorization、Refererは転送しない。redirectは自動追従せず、別送信先に認証情報を引き継がない。

X/Twitterの投稿URLを解析・取得する場合だけ、`x.com`、`api.x.com`、`video.twimg.com`、`cdn.syndication.twimg.com`をexact hostで追加する。これらは送信時にもpublic DNSを確認し、既存Container denylist・120秒解析期限・キャンセル・最終検査を維持する。通常の直URL/YouTubeには追加DNS処理やブラウザ探索を加えない。XのAPIパスや公開application値が変われば再検証が必要で、ログイン必須・非公開・削除済み・外部challengeの投稿まで取得可能にする変更ではない。

`script src`の`data:`／`blob:`は外部DNS検証やscript通信先の候補にしない。blob内のoriginを許可先へ追加せず、frame／media候補のdata／blob拒否とHTTP(S)のpublic DNS・送信境界検証を維持する。script候補8件、browser探索1回／10秒、全体期限の上限も維持する。

## 履歴

- [2026-09-05 性能・費用調査](../docs/history/downloader/performance-2026-09-05.md)
- [2026-09の変更・公開・個別調査](../docs/history/downloader/changes-2026-09.md)
- [ClamAV定義更新の導入・障害履歴](../docs/history/downloader/definition-updates-2026-09.md)
