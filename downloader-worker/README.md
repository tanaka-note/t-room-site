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

「Downloader推定追加料金」は2026-09-04に確認したCloudflare公式料金を使い、Downloader単独で月間付帯枠を消費した場合の超過分を概算します。成功処理から観測できるContainer CPU・wall time・作業領域、Worker／Queue／R2操作、R2保持時間を対象にし、R2は公式の請求単位への切り上げも反映します。Workers CPU、D1 rows、失敗Containerの実使用量、実際のContainer起動待機はWorker内で正確に帰属できないため「取得不能」とし、基本料金5 USDも含めません。アカウント全体で共有される枠と正式請求額の正本はCloudflare Billingです。料金表は変更され得るため、公開前に公式の[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Containers](https://developers.cloudflare.com/containers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)を再確認してください。

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

## ClamAV・YARAとContainer更新

ClamAV 1.4.6 LTSをchecksum固定した公式packageから導入します。定義はContainer起動時に外部更新せず、image build時の同版`freshclam`を必須にしてimageへ固定します。週次または緊急更新時は`wrangler.jsonc`の`containers[0].image_vars.CLAMAV_DEFINITION_REFRESH`を現在のJST ISO週（例: `2026-W36`）へ進めてください。この値が定義更新layerだけを確実にcache bustします。同じ値での再buildは意図的にcacheを再利用します。

`main`、`daily`、`bytecode`を個別に存在・署名検証し、鮮度は`daily.cvd/.cld`内部のbuild timestampだけで判定します。いずれかの欠落・署名異常、dailyの7日超、scanner timeout・異常終了は`/health`と実スキャンの両方でfail closedです。`clamd`は2 GiBの`MaxFileSize`・`MaxScanSize`・`PCREMaxFileSize`、再帰・展開・PCRE・bytecode上限と`AlertExceedsMax`を明示します。さらに64 MiB単位（1 MiB overlap）の全域stream scanを重ね、部分検査や上限超過をclean扱いしません。

独立した第二検査は公式YARA CLI 4.5.8です。公式source archiveのSHA-256を固定し、ルールはContainer build時にcompile・checksum化します。外部ルールは`Neo23x0/signature-base@278165d7845decece517f756cf92ff4a41938d1e`から誤検知範囲を限定できる2ファイルだけを選び、全feed、generic、experimental、hunting、Office、web-shell系は取り込みません。YARAの欠落・checksum不一致・timeout・error・matchはいずれもR2保存前にfail closedします。PASS_THROUGH、REMUX、変換のいずれも、R2へ保存する最終成果物に対してClamAV＋YARA＋SHA-256を1回だけ実行します。検査前後で同一file identityを照合し、途中で実体が変化した場合もfail closedにします。変更後はContainerをstagingでbuildし、`/health`、EICAR、YARA安全fixture、既定PCRE上限より後方のmarker、正常media fixtureを通過してからrolloutしてください。

Containerは非root UID `10001`で実行し、`/app`とClamAV定義は読み取り専用、作業データは`/work`だけへ置きます。`enableInternet=false`を既定にし、HTTP/HTTPSはWorker側の検証済みoutbound handler、R2 uploadは`outboundByHost`だけを経由します。各Container instanceには解析元hostとそのsubdomain、解析済みrouteから検証した配信host、内部R2だけを動的allowlistとして設定します。別hostへのredirectや埋め込みは明示adapter等で許可hostを確定できない限りfail closedです。外向きrequestはGET/HEADと、公開YouTube extractorが必要とする限定POSTだけを許可し、許可した`Accept`・`Range`系header以外は再構築します。Cookie、Authorization、Referer、Origin、Forwarded、利用者User-Agentは転送しません。80/443以外の任意TCPは許可しません。Python側でもscheme・credential・port・禁止host・IP literalを拒否し、Cloudflareの透過interception DNS利用時は公開hostnameの最終送信をWorker側で再検証します。HTTPS outbound interception用CAは起動時だけ注入されるため、非root entrypointが公開CA束と結合し、Python・yt-dlp（必要なextractorのみcurl-cffi impersonation）・ffmpeg・Chromiumへ同じ信頼束を渡します。CAや外部credentialをimageへ焼き込みません。

Cloudflare Workersから外部originへ送る通信では、プラットフォーム仕様上`CF-Worker: tanaka-note.com`が付与されます。利用者IPは固定のCloudflare Workers addressへ置き換えますが、運営zoneまで秘匿するにはCloudflare外の固定Privacy Relayが別途必要です。Relayはアクセス制限・地域制限回避やIP rotationには使用せず、運用先・固定費・abuse対応を決めてから導入してください。

最大12分の処理に対し、download、軽量検証、ffmpeg、最終成果物のClamAV＋YARA検査、R2 uploadは単一の絶対deadlineを共有します。clamd再起動も残時間を超えて待機しません。Container health cold startは最大90秒、Workerからの本処理は最大750秒で中断し、Queueの15分wall-clock内にD1更新・retry用の余裕を残します。Containerは署名済みjob grantで実処理段階を通知し、D1にはContainer起動、取得、検証、変換、最終検査、R2保存の実測時間だけを記録します。Container rolloutはactive instanceを15分保護する`rollout_active_grace_period`を設定しています。さらにSIGTERM後は新規HTTP処理を503で拒否し、実行中のffmpeg・ClamAV・YARA・R2 uploadが終了するまでdrainします。失敗したQueue deliveryはprocessing leaseの失効後に再取得されます。

## Secretsと初回公開

Gitへ保存しない次のSecretが必要です。

- `SESSION_SECRET`
- `URL_ENCRYPTION_KEY`（32 byte相当の高entropy値）
- `INTERNAL_SIGNING_SECRET`

さらにDownloader D1、private R2、Queue、DLQを作成し、`wrangler.jsonc`のD1 IDを実値へ置換します。Security D1 migration `0011_downloader_service.sql` とDownloader migration `0001`〜`0003` を順に適用後、Security/Downloader Workerを揃えて公開します。Lifecycleは `pnpm run r2:lifecycle` で適用します。

## 検証

```text
pnpm run check
pnpm run test
pnpm run test:browser
pnpm run deploy:dry
```

Dockerが使える環境ではContainer imageをbuildし、実ffmpeg/ffprobe/ClamAVを含むformat fixture試験も行います。依存物のライセンスは `THIRD_PARTY_NOTICES.md` に記録しています。
