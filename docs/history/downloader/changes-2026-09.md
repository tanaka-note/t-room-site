# Downloader変更・公開記録（2026-09）

この文書は当時のmigration、検証、公開version、workflow、個別調査を保存する履歴であり、現在の仕様や公開手順ではありません。現行仕様は[`downloader-worker/README.md`](../../../downloader-worker/README.md)、定義更新runbookは[`downloader-worker/DEFINITION-UPDATES.md`](../../../downloader-worker/DEFINITION-UPDATES.md)を参照してください。

## 2026-09-05 最終計測・料金表示の補正

`scan_ffprobe_failed`はsignal終了・メモリ不足・未知の異常終了も同じcodeになるため、`scan_ffprobe_invalid`（JSON応答不正）とともに上限付き再試行へ戻す。stderrの文言だけで内容不正と断定しない。正常に解析された結果への`scan_invalid_media_stream`等の確定拒否は再試行しない。配信禁止、token CAS、4 delivery／DLQ、deadlineは維持する。

追加migration `0004_downloader_final_metrics.sql`はready時の利用日（JST）・利用者を固定し、uploadを勝ち取った元processing tokenを最終計測用に保持する。最終応答はこのtokenと未確定条件のCASで一度だけ反映し、同一SQL transaction内のtriggerでCPU・wall・peakとmemory/disk参考値を差分補正する。日付またぎ・ready後の削除でも元の日へ反映する。古いattempt／二重応答は更新せず、累積CPU・wallが下がる応答でも既存値を減らさない。最終応答紛失やDB更新失敗時は暫定値のまま残り、計測のために再取得はしない。成功件数と最終応答受信件数を混同しない。

旧memory/disk集計の固定120秒はidle fallbackを基にした仮定であり実測ではなかった。新規集計は実測wall（成功処理区間）の秒数×割当6 GiB／12 GBとし、起動／解析／health／停止／失敗／再試行を補完しない。release RPCの完了は課金終了ではない。旧120秒込みの日次行は保持して新料金試算から除外し、旧CPU（常駐clamdを含まない部分計測）も推測で書き換えない。表示は対象分の小計で、付帯枠をDownloader単独で利用できる仮定を明記する。他サービスとの共有枠、未計測のWorkers CPU・D1・DO・Logs、基本料金があるため、0 USDでも無料や請求上限を意味しない。欠測のContainer CPU/memory/diskは取得不能とする。[公式Container料金](https://developers.cloudflare.com/containers/platform/pricing/)を2026-09-05に再確認した。

開始時の本番はWorker `ecc44ac9-ea15-42e0-9751-1744f88b5a95`、Container version 7。読み取りでは過去成功8件のジョブCPU合計56,605 ms・wall合計387,150 msが日次値と一致しており、本番で差が生じていたとは断定しない。旧実装の未補正はSQLite再現テストで確認する。過去値の確実な加算元が残っていないため、migrationは既存行を再集計・推測補完しない。

公開は処理中・待機中ジョブを確認し、`pnpm exec wrangler d1 migrations apply downloader-db --remote`で0004を先に適用後、Container変更がないため`pnpm exec wrangler deploy --containers-rollout=none`でWorkerだけを更新する。切り戻しは旧Worker `ecc44ac9-ea15-42e0-9751-1744f88b5a95`へ戻せる（追加列は後方互換、Containerは変更なし）。0004は削除せず履歴を保持する。旧Workerへ戻すと最終補正・新表示は停止し、新規の最終値は暫定扱いになるため、復旧後に推測で加算しない。

検証: Node 52件PASS、Windows Python 112件中87件PASS・外部ツール依存25件skip。ffprobe異常終了はmockで再現し実エンジン試験とは区別する。SQLite実行で旧未補正、最終補正、日付またぎ、異なる利用者、CAS競合、R2 upload再送、transaction rollback、履歴保持を確認した。Containerコードは変更せず、通常動画や大容量の本番取得試験は追加しない。全サイト契約テストのcalculator既存build不一致は今回の回帰と分離する。

## URL解析中止のmigration・公開記録

追加migration `0005_downloader_analysis_cancel.sql` は状態CHECKを更新するためテーブルを再作成する。既存ジョブ全列・配信履歴・利用集計・既存triggerを維持し、配信履歴を復元してからtriggerを戻すため再集計しない。公開前に稼働ジョブと適用済みmigrationを確認し、D1 Time Travel bookmarkを控え、Wrangler migrationで0005を先に適用する。Workerのみ `wrangler deploy --containers-rollout=none` で公開し、現行Container imageを維持する。

切り戻しは公開前に控えたWorker versionへ戻す。0005の追加状態・列と既存履歴は残す。旧Workerでもcancelledは解析再開対象にならないが、中止UIと停止再試行APIがなくなるため、停止未確認ジョブがある場合は旧版へ戻す前に今回のRPCで停止を完了させる。Container imageの切り戻しは不要。Time TravelによるDB全体の巻き戻しは新しい履歴を失うため通常の切り戻しには使用しない。

対象検証: `node --test test/downloader-cancellation.test.js`（SQLite・Container mock）、`node test/downloader-cancellation.browser.mjs`（Chromium・mock API）。実Containerを起動するテストではない。

## 2026-09-08〜13 本編補助探索・解析修正

公開記録（2026-09-08 JST）: 実装`89765b7`、公開コード`1ea791b`。対象Node 65件（変更箇所ごとの実行の合算）、Python unit 40件PASS。Windows ChromiumでJS/blob・iframe・広告除外・曖昧候補・login拒否の5ケースを確認。初回Linux fixture実行は失敗し、本番ラッパーと同様の書き込み可能HOMEをCIにも設定後、[公開workflow 34136475258](https://github.com/tanaka-note/t-room-site/actions/runs/34136475258)でLinuxの7テスト（上記5ブラウザケースを含む）・実ClamAV正常/EICAR・署名/鮮度・YARA正常性を通過。初回失敗時は未公開。初回の詳細stderrは取得できず、HOME修正後の成功と区別して記録する。全E2E・大容量取得・Cloudflare上の補助探索end-to-end/敵対的DNS切替試験は実施していない。

本番Worker `3fda4375-5ea2-4944-b287-a69efa8984ac`、deployment `a51190ec-da71-4565-bcaf-216e3b300fc7`、build `downloader-fcf2a3846067`。本番HTML build、downloader.js/delete-controls.jsのmain一致、未認証jobs API 401、既存D1/R2/QueueとTTL3600・Cron10分・新機能flag=trueを確認。Container version 11、digest `sha256:bd6edcda383bdc7c12f08b9b7942c555f81e63a4541b2a7b5e9fd2a538abab39`、rollout `5b911d08-4673-4d8d-a2fb-60e817e3fc13` completed・activeなし。定義生成`2026-09-07T06:24:32Z`・7日期限`2026-09-14T06:24:32Z`、D1 image/source_image一致。Workerを前版へ戻す場合のversionは`ab093ef1-6823-4f0b-bdb4-d4c0a2729f59`（Containerを戻す操作ではない）。通常は新機能flagだけfalseにして既存成功経路を維持する。


### 2026-09-08 埋め込み解析の待ち時間修正

本番旧ジョブは4分3秒後にextractor_failed。待機中もanalyzingを表示し、Queueの30/60/120秒再試行待ちが含まれていた。改修後の対象URL解析はWindowsローカル1回で0.734秒、bot_challengeで拒否（ページ側Cloudflare確認）。動画取得成功ではなく、拒否を長時間再試行しないことの確認。旧本番とローカルの数値は環境が異なり性能倍率に換算しない。Cloudflare上の同URL再実行や動画本体取得は行わない。


公開確認: 実装 `ac05efefbfc3c432ad7bef82a0af36a68b9902d3`、[workflow 34183905397](https://github.com/tanaka-note/t-room-site/actions/runs/34183905397) success。対象Node70件、Python unit44件（resolver29・main-video9・SSRF6）、Windows実ブラウザ6ケースPASS。Windows初回の拒否fixtureはPlaywright起動timeoutで失敗し、当該ケースの再確認でPASS。Linux候補では実yt-dlpのオフライン専用extractor判定を含む12テストが成功。ClamAV実スキャンは再実施せず、本番の定義/エンジンを継承して署名・鮮度・ルール整合を再確認。全E2E・大容量転送・Cloudflare上での対象URL再投入は未実施。

本番build `downloader-bc6772b65629`、Worker `11ce3f56-8db9-484e-ac2e-0be8cd0d376b`（100%）、deployment `51ea6ac2-d7f8-45b7-9d05-431067fc9087`。Container13 / digest `sha256:b9e49c44884574d0a266ae286bd667246761d20a2cfa1e1c72fd80a9087f8208`、rollout `e39fe4f9-2fb1-4a7d-ae90-da907b44eb63` completed・activeなし。mainとHTML build/配信JS一致、未認証jobs 401、TTL3600・10分Cron・D1/R2/Queue・flag=trueを確認。定義生成2026-09-07 06:24:32 UTC、期限09-14同時刻、D1 image/source_image一致。

切り戻し: 補助探索だけならMAIN_VIDEO_FALLBACK=false。解析順序も戻す場合はWorker前版 `3fda4375-5ea2-4944-b287-a69efa8984ac` と、定義更新手順で鮮度を再検証したprevious image `sha256:0ddbf30cfc90877d567310eb06f6c34474188ab01c71c60ff9fe58b05ba15d38` を組み合わせる。進行中job/drain・active rollout・D1 image/source_image整合を省略しない。

### 解析拒否の診断（2026-09-08）

Resolver→子プロセス→Container HTTP→Worker→監査で、固定の工程名・発生元・HTTP statusを引き継ぐ。補助探索のHTTP/redirect/通信拒否を一律`unavailable`にしない。Worker送信handlerは相手由来の診断markerを上書きし、上流応答と自前のpolicy拒否を識別する。SDKがhandler到達前に返す応答など、発生元を確認できないものは`unknown`のままにする。URL/query、Cookie、Authorization、本文は診断へ渡さない。失敗ログにはjob ID、起動待ちと解析の経過時間を含める（CPU時間ではない）。監査は既存のtoken付きCAS成功後だけ記録する。

対象ページの通常Chromeでは、main playerに同一ホストHLSの参照があり、明確なPlay buttonを1回押すとblob再生へ移った。関連previewとは区別して確認し、直後にページを閉じて転送を止めた。このDOMでは本編iframe必須とは確認できなかった。一方、Cookieを持たないWindows HTTPは既存/ブラウザ相当UAとも403＋`cf-mitigated: challenge`、新規Chromium contextは307→403 challengeでvideo要素へ到達しなかった。[Cloudflareのchallenge応答仕様](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)に従い、確定拒否をfallbackで回避しない。

追加切り分け（同日）: 利用者は通常Chromeのシークレットでも人間確認なしで再生できると報告した。独立した新規Chrome 153で、最初のHTTP応答をheaders時点で遮断し、本文を空文書へ置換した比較では、stock HeadlessChrome UAは403、UAのHeadlessChrome表記だけをChromeにした条件は200だった。送信headerをUA/Acceptだけに絞った比較でも、Mozilla/5.0は403、通常Chrome形式は200。Cookieの移送・challenge script実行・広告クリック・動画要求は行っていない。200は最初のHTTP応答だけの確認であり、本文の正当性、解析・取得成功を意味しない。HEAD/GET差だけでは解消せず、以前の307は同じURLへの再要求で、最初の実応答にLocationはなくAccept-CH/Critical-CHがあったため、埋め込み先へのHTTP転送の根拠にはしない。

同じ通常Chrome形式UAでも、Windows Python HTTPとCloudflareの隔離edge-previewのfetchは403 challengeだった。previewは既存Worker名の一時実行で、Container/D1/R2 bindingを持たず、応答bodyを読まずcancelし、本番deployment/versionが不変なことを読み戻した。X-Real-IPを外したpreviewも403だった。UAだけ、固定IP headerだけ、Cloudflare送信元だけを単独原因とは断定できない。現在の通常・補助egressはWorker fetchで接続を作り直し、UAをMozilla/5.0へ固定するため、ローカルChromeの200という条件をそのまま再現するものではない。ブラウザとHTTPクライアントの通信特性による差は残るが、TLS/HTTP特性・送信元評価など相手側の具体的判定規則は未確定。UAだけの本番変更で解決したとは扱わず、通信制限の解除・Cookie転送・challenge回避は行わない。追加調査はHTTP metadata比較のみで、コード変更・Container起動・再deploy・実スキャン・動画取得は行っていない。

この修正は観測した診断欠落の是正であり、対象動画の取得成功やサーバーからのchallenge通過を実現したものではない。Cookie/POST/認証・通信先制限は維持し、追加待機・リクエスト・ブラウザ起動を増やさない。正常経路の変更は診断headerの付与のみで、速度差や請求増分は未計測。エンジン・定義・Container枠は変更しない。

公開確認: 実装 `c8ed979880463cba577a3de21ffc09b623fe080d`、[公開workflow 34208619982](https://github.com/tanaka-note/t-room-site/actions/runs/34208619982) success。Node対象54件PASS（解析・送信境界・キャンセル/CAS/再配送・既存処理・契約）。Python unit47件中46件PASS・yt-dlp未導入による1件skip。Windows Chromiumの8ケース（3テスト）PASS。Linux候補でも実yt-dlp判定と小容量ブラウザ・子プロセス終了fixtureのコマンド成功を確認。初回Node実行はVM harnessに新importが未登録で1件失敗し、harnessの依存追加後に該当セット全件PASS。構文・build同期・Wrangler dry-run成功。既存エンジン/定義の署名・内部日時・ルールは再検証し、ClamAV実スキャンや大容量転送は繰り返していない。

本番build `downloader-cac27d5cf650`、Worker `9527bd34-7527-4459-8515-ff87f4a3329d`（100%）、deployment `2e120568-7de4-497b-b609-5960da594a20`。Container14 / `sha256:26ee1cce3e0b01c5f31adcdc3f324921da942d2f0da48f23641187fb93acd80c`、rollout `0aa010a0-f906-494a-8b38-2c47e4dc942f` completed・activeなし・D1 image/source_image一致。HTML buildとdownloader.js/delete-controls.js一致、未認証jobs 401、TTL3600・10分Cron・既存D1/R2/Queue・flag=trueを読み戻し確認した。

2026-09-08 18:21 JST、利用者の再ログイン後にChromeの認証済みURL入力欄を確認し、対象URLを本番で1回解析した。job `686ecfe2-771a-41aa-9ebe-1ba02aa6a724` は受付09:21:02 UTC→失敗確定09:21:10 UTC（約8秒、起動/Queue待ちを含む経過時間でCPU時間ではない）。Security監査の固定診断は `stage=direct, source=upstream, httpStatus=403`、D1 `error_type=bot_challenge`。この版のcodeで実際の上流 `cf-mitigated: challenge` を判定しており、自前のegress/SSRF拒否とは区別できた。この時点では通常Chromeとの差の具体的条件は未確定だった。上記の追加切り分けでも、本番からの解析成功は未達成である。

失敗後の再読込でもstatus=failed、processing token/leaseはNULL、受付/失敗監査は各1件、object参照なし、取得開始/利用者DL/スキャン計測なし。UIは「サイト側のアクセス制限により解析できません。」に戻り、長時間の再解析は観測しなかった。本番Worker `9527bd34-7527-4459-8515-ff87f4a3329d` 100%・Container14/digest一致・active rolloutなしを再確認。アプリの認証障害は解消したが、動画URL検出・取得・検査・保存・利用者ダウンロード成功は未達成。確定challengeを無視するfallbackやCookieの移送は行わず、同条件の本番試験を反復しない。今回の追加変更はこの検証記録だけであり、既存対象テストを再利用して再deploy/Container buildは行わない。

今回の切り戻し: Worker旧版 `11ce3f56-8db9-484e-ac2e-0be8cd0d376b`。Containerまで戻す必要がある場合は、定義更新手順の署名/鮮度・job/drain・rollout確認後にprevious image `sha256:b9e49c44884574d0a266ae286bd667246761d20a2cfa1e1c72fd80a9087f8208`を使う。Workerだけのrollbackはimageを戻さない。補助探索の停止だけなら既存のMAIN_VIDEO_FALLBACK=falseを使用する。

### 2026-09-08 ページ解析の互換性改善

対象サイトは新規Chrome153の最初の応答をCDPで止め、260,405 bytesのHTML（video要素28、player marker、media参照あり）を読み取った。本文を空文書に置換したためサイトscript/広告/動画は実行していない。challenge-platform scriptの参照自体はHTMLにあったが、HTTPは200でcf-mitigated: challengeはなかった。同一UAでPlaywright route.fetch GETは403 challenge。この比較と以前のWorker fetch比較から、UA変更だけではサーバー経路を解決できない。Cloudflare公式の[HTTPS interception](https://developers.cloudflare.com/containers/guides/outbound-traffic/)と現行SDK/送信handlerを照合し、現在のHTTP単位の検証を維持しながらネイティブChromeのTLSをそのまま通す経路は確認できなかった。interceptHttps=false、通信制限の解除、Cookie移送、確認処理の回避は採用しない。対象サイトの動画解析/保存成功は未達成。

ローカル対象Node64件PASS、Python53件中52件PASS・yt-dlp未導入1件skip。小容量Chrome fixtureでJS/blob、iframe、広告/曖昧候補/ログイン/403拒否、明示再生button、拡張子なしHLS、origin Referer、同一origin転送、動的OG metadataを確認。Windowsの広告拒否1件は終了待ちが外側期限に達し、該当拒否セット単独再確認でPASS。ブラウザ終了は既存の親プロセス監督/Container中止で強制停止される。fixture HTTPによるmanifest再検証と32-byte署名fixtureの実ダウンロードも確認したが、この32-byteデータは再生可能動画/実スキャン試験ではない。

追加の境界fixtureで、構造化contentUrlとembedUrlが併記されたページがiframe内のlogin拒否を確認する前に候補を返す不備を再現した。明示iframeがある場合はmetadataだけの静的採用を止め、既存のframe制限確認へ進むよう修正。拒否の再現テスト、静的選別、既存のJS/blob・通常iframeの対象3テストがPASS。正常iframeも確認してから修正版Containerを再検証・公開する。

同じローカルJS/blob fixtureを旧/新コードで各一回、同じChrome153・毎回新規browserで比較: 起動/終了込み1,297ms→1,125ms、origin要求1→1、応答header込み送信593→593bytes。少数のローカル観測で本番性能倍率を保証しない。直URL/専用extractor成功時に追加探索は起動しない。ブラウザ二重起動や静的CDNのブラウザ起動を省ける場合は費用減が見込めるが、DNS/検証回数とサイト次第で差があり、CPU/請求額は未計測。成功ログのbrowserRequests/browserBodyBytesはブラウザ内の要求（abort含む）/読込bodyで、DNS・prepare・validate・取得全体の集計ではない。

公開は既存analysis_only workflowで本番の依存/エンジン/定義を継承し、Linux小容量fixtureと定義の署名/内部日時を再検証してからrollout、続けてWorkerを--containers-rollout=noneで公開する。migration不要。検査エンジンの変更や重い実スキャンは行わない。新機能停止はMAIN_VIDEO_FALLBACK=false。今回の公開前Workerは9527bd34-7527-4459-8515-ff87f4a3329d、Container14/digest 26ee1cce3e0b01c5f31adcdc3f324921da942d2f0da48f23641187fb93acd80c。headerを必要とする今回のrouteが残る間はflag停止を優先する。完全rollbackではその解析結果の再解析が必要であり、旧Workerは新requestContextを保証しない。image rollbackは定義鮮度・進行job/drainとsource_imageの整合確認を省略しない。

### Xの公開投稿APIの送信制御（2026-09-13）

本番ログの `POST api.x.com/1.1/guest/activate.json` はContainerProxy自身が405で拒否していた。通常egressのPOST許可とheader処理がYouTube専用だったことが原因。固定版yt-dlp 2026.08.19の公開投稿経路について、空のguest activation POSTと固定TweetResultByRestId GETだけに公開application bearerを許可する（公開値のSHA-256と完全一致が必要）。数値guest tokenは同GETだけに転送し、利用者Cookie・CSRF token・任意Authorization・Refererは転送しない。redirectは自動追従せず、別送信先に認証情報を引き継がない。

X/Twitterの投稿URLを解析・取得する場合だけ、`x.com`、`api.x.com`、`video.twimg.com`、`cdn.syndication.twimg.com`をexact hostで追加する。これらは送信時にもpublic DNSを確認し、既存Container denylist・120秒解析期限・キャンセル・最終検査を維持する。通常の直URL/YouTubeには追加DNS処理やブラウザ探索を加えない。XのAPIパスや公開application値が変われば再検証が必要で、ログイン必須・非公開・削除済み・外部challengeの投稿まで取得可能にする変更ではない。

対象テストは `node --test test/x-egress.test.js test/main-video.test.js test/downloader-cancellation.test.js test/worker-contract.test.js`。Workerだけを`--containers-rollout=none --keep-vars`で公開し、Container/定義/migrationの変更は不要。切り戻しは公開前Worker `a979c0bb-1f48-45a9-afd8-984245c60b57`。補助探索のflagとは独立した通常egress修正のため、`MAIN_VIDEO_FALLBACK=false`だけではこの変更を戻せない。

補助解析の即時内部エラーは、public DNS問い合わせの`redirect: "error"`がWorkers runtimeで未対応だったことも原因。Node mockでは通る一方、実workerdでは通信前にTypeErrorとなることを再現した。`manual`に変更し、既存の`!response.ok`でDNSの3xxも拒否するため転送先の追従は許可しない。修正前TypeError→修正後同じworkerdでDNS確認成功、Nodeの3xx拒否テストを確認した。Containerなしの隔離edge-previewでもNASA公開投稿のHEAD・guest activation・投稿APIが全て200（合計1,584ms、動画本体転送なし）。これは本番Containerでの取得・保存成功とは区別する。

公開確認: 対象Node59件PASS、構文とWrangler dry-run成功。Worker `16a63ca8-5683-42d9-b0a4-c35f5d51a9f3`（100%）、build `downloader-f88936c80698`、配信JSのmain一致、Container digest `bcbbd4d9b85ee1d2ed26beb0188ad0e761879d356ffb6ff26a617d8d4c269437`維持・active rolloutなしを確認。2026-09-13 00:15 JST、本番で公開の短い公式プロモーション投稿（CaptainAmerica / 719944021058060289）を解析し、1280×720 HLS/MP4の選択肢と取得ボタンを表示。D1は20秒でanalyzed、token/lease解放を確認した。ローカルの同じ固定版yt-dlpは1,218ms、API/X/video.twimg.comの3ホスト、4形式を検出。本番とローカルは起動条件が異なるため速度倍率には換算しない。実動画の取得・スキャン・保存・配信はこの検証では実施していない。

NASAの旧投稿623160978427936768は通常のX内動画とは異なる旧カード経路で、`amp.twimg.com`は本番allowlist対象外。直接接続の固定版yt-dlpでも同ホストがHTTP500を返したため取得成功とは扱わず、許可先追加だけで解決したとはしない。一般の公開投稿での解析成功と、この旧カードの失敗、利用者提示の個別投稿の未再検証を区別する。追加Container build・大容量転送・有料サービス導入は行っていない。DNS検証と小容量実環境確認の利用量は発生し、請求額/CPUは未計測。

### 埋め込みスクリプトとiframe探索の整合（2026-09-13）

通常HTML parserは`script src`の`data:`/`blob:`も探索planへ渡す。Workerがそれを外部DNS検証へ渡すと、正常なiframeがあってもdependencies段階で解析を打ち切っていた。非性的なpage/frame fixtureで修正前の失敗を再現し、これらだけをscript通信先の候補から除外した。blob内のoriginを許可先へ追加せず、frame/media候補のdata/blob拒否とHTTP(S)のpublic DNS・送信境界検証は維持する。8件のscript候補上限・1回/10秒・全体期限は変更しない。

Node対象40件（補助探索・X送信制限・中止/CAS）とPython対象5件（静的候補・iframe・転送・403/challenge・拒否維持）がPASS。ブラウザ探索・候補再検証はNode mockであり、実サイトの取得成功を示すものではない。ブラウザ/Container実起動、実動画取得、実スキャンは行わない。Workerのみ`--containers-rollout=none --keep-vars`で公開し、Container・定義・DB migrationは変更不要。切り戻しは公開前Worker `16a63ca8-5683-42d9-b0a4-c35f5d51a9f3`。
