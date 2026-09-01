# T-lain Downloader

権利を持つメディアをURLから解析し、明示的な確認後に隔離Containerで取得・検査して、非公開R2へ最大30分だけ保存する非公開ツールです。公開導線、サイト内検索、sitemap、OGPは持ちません。

## 構成

- Worker: Security Centerの一回限りhandoff、セッション、所有者分離、rate limit、Queue、D1台帳、R2配信・期限削除
- Queue: 1件ずつ冪等に処理し、processing tokenとleaseで重複実行を遮断
- Container: site固有adapter → Direct → yt-dlp → Generic HTML → Chromium fallbackの順で解析・取得
- Media pipeline: 実体をlibmagic、ffprobe、ClamAVで検査し、動画をMP4/H.264/AAC/yuv420pへ必要最小限で正規化
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
