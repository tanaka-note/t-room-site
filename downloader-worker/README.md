# T-lain Downloader

権利を持つメディアをURLから解析し、明示的な確認後に隔離Containerで取得・検査して、非公開R2へ最大30分だけ保存する非公開ツールです。公開導線、サイト内検索、sitemap、OGPは持ちません。

## 構成

- Worker: Security Centerの一回限りhandoff、セッション、所有者分離、rate limit、Queue、D1台帳、R2配信・期限削除
- Queue: 1件ずつ冪等に処理し、processing tokenとleaseで重複実行を遮断
- Container: site固有adapter → Direct → yt-dlp → Generic HTML → Chromium fallbackの順で解析・取得
- Media pipeline: 実体をlibmagicで基本判定し、ClamAV検査後にffprobeへ渡して、動画をMP4/H.264/AAC/yuv420pへ必要最小限で正規化
- R2: `t-room-downloader-temp`の`downloads/`だけを使用。Worker経由の所有者認証なしでは取得不可

動画変換は `PASS_THROUGH`、`REMUX`、`PARTIAL_TRANSCODE`、`FULL_TRANSCODE`、`REJECT` の計画を実体検査後に選びます。互換H.264/AACはcopyを優先し、非互換streamだけを変換します。ffmpegはshellを使わず固定argv・ローカル入力・`file,pipe` protocolだけで実行します。

HLS/DASHはmanifest・redirect・参照URLごとに公開HTTP(S)宛てか再検証し、暗号化、DRM、終了点のないライブ配信、過大manifestを拒否します。Containerの外向き通信もprivate/link-local/metadata CIDRを拒否します。

YouTubeは公式ポリシーに合わせ解析表示までとし、本体取得はHTTP 451で拒否します。Generic/Chromium fallbackへ迂回させません。

## 制限

- 通常最大2 GiB、長時間音声になり得るTwitter/X Spaces相当は512 MiB
- 処理時間最大12分、同一Identityの同時処理1件、Container最大2 instance
- 動画最大3時間、8K以下、stream 16本以下、動画stream 1本
- ログイン必須、DRM・暗号化stream・ライブ配信・認証必須コンテンツは非対応
- 一時ファイルは処理終了時に削除。R2は30分のQueue削除と10分Cronを正本とし、1日R2 lifecycleを最終防衛線にする

Cloudflare ContainersはWorkers Paid契約とDockerが必要です。Containerが利用できない環境ではWorkerだけで危険な代替取得をせず、公開を停止したままにします。

## ClamAVとContainer更新

ClamAV定義はContainer起動時に外部更新せず、image build時の`freshclam`を必須にしてimageへ固定します。週次または緊急更新時は`wrangler.jsonc`の`containers[0].image_vars.CLAMAV_DEFINITION_REFRESH`を現在のJST ISO週（例: `2026-W36`）へ進めてください。この値が定義更新layerだけを確実にcache bustします。同じ値での再buildは意図的にcacheを再利用します。鮮度は`.cvd/.cld`内部の署名DB build timestampを正本とし、7日超・欠落・解析不能・scanner異常は`/health`と実スキャンの両方でfail closedです。変更後はContainerをstagingでbuildし、`/health`、EICAR、実メディアfixtureを通過してから本番rolloutしてください。

Containerは非root UID `10001`で実行し、`/app`とClamAV定義は読み取り専用、作業データは`/work`だけへ置きます。`enableInternet=false`を既定にし、HTTP/HTTPSはWorker側の検証済みoutbound handler、R2 uploadは`outboundByHost`だけを経由します。80/443以外の任意TCPは許可しません。Python側でもscheme・credential・port・禁止host・IP literalを拒否し、Cloudflareの透過interception DNS利用時は公開hostnameの最終送信をWorker側で再検証します。HTTPS outbound interception用CAは起動時だけ注入されるため、非root entrypointが公開CA束と結合し、Python・yt-dlp（必要なextractorのみcurl-cffi impersonation）・ffmpeg・Chromiumへ同じ信頼束を渡します。CAや外部credentialをimageへ焼き込みません。

最大12分の処理に対し、Container rolloutはactive instanceを15分保護する`rollout_active_grace_period`を設定しています。さらにSIGTERM後は新規HTTP処理を503で拒否し、実行中のffmpeg・ClamAV・R2 uploadが終了するまでdrainします。失敗したQueue deliveryはprocessing leaseの失効後に再取得されます。

## Secretsと初回公開

Gitへ保存しない次のSecretが必要です。

- `SESSION_SECRET`
- `URL_ENCRYPTION_KEY`（32 byte相当の高entropy値）
- `INTERNAL_SIGNING_SECRET`

さらにDownloader D1、private R2、Queue、DLQを作成し、`wrangler.jsonc`のD1 IDを実値へ置換します。Security D1 migration `0011_downloader_service.sql` とDownloader migration `0001_downloader_foundation.sql` を適用後、Security/Downloader Workerを揃えて公開します。Lifecycleは `pnpm run r2:lifecycle` で適用します。

## 検証

```text
pnpm run check
pnpm run test
pnpm run test:browser
pnpm run deploy:dry
```

Dockerが使える環境ではContainer imageをbuildし、実ffmpeg/ffprobe/ClamAVを含むformat fixture試験も行います。依存物のライセンスは `THIRD_PARTY_NOTICES.md` に記録しています。
