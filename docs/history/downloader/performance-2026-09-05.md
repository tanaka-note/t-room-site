# Downloader処理時間・費用の再調査（2026-09-05）

## 基準と結論

開始時origin/mainは`c23f18ef829147aaa215af64b35bfb2e1a572cdb`。Downloaderは`52fde2d`時点から変更なし。本番Workerは`86e4bb68-1d06-43b0-9490-b3024e5d4424`、公開buildは`downloader-a8f498141097`。調査時D1のprocessing/queued/analyzingは0件。読み取りだけで確認し、本番ジョブを投入・削除していない。

改善は、解析専用Containerでの不要なエンジン起動を省くこと、確定した内容拒否を再処理しないこと、CPU計測から稼働中clamdが漏れる問題の是正。通常の最終検査自体を高速化できたとは結論しない。

## 呼び出し経路と分類

| 工程 | 実装・判断 |
| --- | --- |
| 解析 | `handleQueueBatch → processAnalyzeMessage → resolveAnalysisSource → /resolve-adapter → /analyze → resolver.analyze`。確定routeを暗号化capabilityへ保存。取得時に再探索しない。**維持**。解析専用の起動判定は`/ready`へ分離。 |
| 起動 | 旧`server.__main__`がclamd読込完了後にHTTP受付、その後`/health`で署名検証とYARA確認。解析でも必須だった。**削減**：HTTP受付を先に開始。取得前の`/health`で定義確認・clamd起動・YARA確認を実施。実スキャンでも再検証する。 |
| 取得 | `processDownloadMessage → /download → resolver.download`。Direct/HLS/DASH/yt-dlp、外向き制限、deadlineを**維持**。adaptiveのmanifest再確認は参照先が変わるため必要。 |
| 軽量検証 | magic、libmagic、size、extension、local-only ffprobe。**維持**。入力probeをnormalize_videoへ渡し、変換後probeも再利用済み。 |
| 動画処理 | 互換H.264/AAC+faststartはPASS_THROUGH。faststart不足はREMUX、非互換streamのみ変換。**維持**。faststartの短いbox header再読は0〜1msで変更不要。 |
| 通常ClamAV | fdpassでファイル構造を含め検査。**維持**。終了0に加え対象ファイルの明示的`OK`、stderrなしを要求。 |
| 分割ClamAV | 64MiB超を64MiB/1MiB overlapで全域INSTREAM。大きなCPU負荷。**削減候補だが未採用**：通常検査との完全な代替関係は確認できていない。 |
| YARA | 4.5.8、独自の埋込PE／scriptパターン、XORされたPE、exe2hex、安全fixture。**維持**：315MB動画で約0.47秒、初回検査全体の約0.8%。削除効果より独立検出層を失う影響を重く判断。 |
| SHA-256 | 最終成果物を1回全読、約0.17秒。**維持**。検査前後のfile identity照合も維持。 |
| 保存・配信 | `_upload_to_r2 → handleContainerUpload`のD1 CAS、署名key、ready化、同一再送の冪等性、敗者による削除禁止。**維持**。再ダウンロードはR2から配信し、Containerを起動しない。 |
| 終了 | TemporaryDirectoryの削除、Workerのfinallyでrelease→stop、SIGTERM drain、2分idle fallback。**維持**。release RPC経過時間を追加記録。実課金終了までのCloudflare内部時間は未計測。 |
| 再試行 | 検出・既知の形式不正・サイズ制限はtoken付きCASでfailed確定後に終了。**削減**。エンジン、定義、ネットワーク、timeout、未知エラーは既存の最大4回とDLQ。 |

最終フル検査の呼び出しは1リクエストにつき1回。ただし、その中で通常ClamAVと分割ClamAVが実行される。Queueの有効leaseとready済み判定は重複処理を防ぐ。Container transportがリクエスト自体を透過再送する可能性の完全排除までは実証していない。以前のR2競合対策は変更していない。

## ClamAV方式を維持した根拠と限界

[1.4.6公式設定](https://raw.githubusercontent.com/Cisco-Talos/clamav/clamav-1.4.6/etc/clamd.conf.sample)と[実装](https://raw.githubusercontent.com/Cisco-Talos/clamav/clamav-1.4.6/libclamav/scanners.c)を確認。

- MaxFileSizeは入力／内包ファイル、MaxScanSizeは再帰展開を含む総検査量を制限。いずれも2GiBのまま。AlertExceedsMaxにより主要上限超過を検出扱いで拒否する。
- PCREMaxFileSizeはPCRE部分署名の実行対象サイズを制限。既に2GiBのため、**既定100MiBの回避だけを理由に分割を残す必要はない**。
- StreamMaxLength=68MiBはINSTREAMの転送上限。fdpassによる通常検査のファイル上限ではない。今回変更なし。
- MaxEmbeddedPE=64MiBなど別の解析上限があり、分割するとファイル種別・相対offset・内包構造の解釈も変わる。通常検査も必要で、分割だけへ置換できない。逆方向も、数件のraw marker検出だけでは同等性を保証できない。
- 2GiB超の実エンジン拒否、64MiB境界と128MiB後方の安全な独自署名検出を確認。ただしNDBのraw署名試験であり、PCRE署名や全ての埋込形式を網羅した試験ではない。テキスト対象署名を使った探索fixtureでは両方式とも検出せず、同等性の根拠に採用していない。
- ClamAVには形式ごとの解析上限・非対応がある。外部から観測できる失敗・スキップ・未完了をOKにしない対策は実施したが、全内部parserの完全検査を保証するものではない。制限解除・timeout延長で回避しない。

YARA単独層の削除は今回は不採用。検出機能は削除しておらず、既存YARA統計・過去履歴も維持する。

## 実測

本番D1の既存成功jobを再確認：取得13,466ms、軽量検証121ms、処理1ms、検査合計36,576ms、wall50,669ms、旧CPU7,510ms。health／upload値はNULL。詳細本番ログは今回未取得。旧CPUは稼働中clamdを含まず、合計検査時間をYARA時間とはみなせない。計測修正後のCPU・推定料金が過去より大きく表示されても、計測範囲の差が含まれるため実負荷増とは直ちに判断できない。

ローカルはDocker/Linux、ClamAV1.4.6、同じ定義・本番clamd.conf、2vCPU制限/4GiBメモリ、ネットワーク無効。Cloudflare standard-2（1vCPU/6GiB）とはハードウェア条件が異なる。

同一のffmpeg生成MP4：315,058,872 bytes、SHA-256 `8e48a606f4befdef93b92b55a8c0f500c552eb2c3cdbeefb5bda5ceb8a35c749`。2回目は同じdaemonのclean-cacheが効く条件であり、新規jobの速度予測には使わない。

| 工程 | 変更前 初回 wall/CPU ms | 変更後 初回 wall/CPU ms | 変更前 warm wall/CPU ms | 変更後 warm wall/CPU ms |
| --- | ---: | ---: | ---: | ---: |
| 定義検証 | 1158 / 1135 | 1113 / 1114 | — | — |
| clamd起動 | 7221 / 7132 | 7020 / 6979 | — | — |
| 軽量検証 | 96 / 87 | 94 / 93 | 79 / 79 | 78 / 79 |
| PASS_THROUGH判断 | 0 / 0 | 0 / 0 | 0 / 1 | 1 / 1 |
| ClamAV通常 | 27416 / 27399 | 30494 / 30473 | 665 / 658 | 661 / 661 |
| ClamAV分割 | 27766 / 27922 | 32600 / 32742 | 1200 / 1336 | 1206 / 1347 |
| YARA（ルール確認込） | 467 / 479 | 468 / 481 | 460 / 471 | 459 / 472 |
| SHA-256 | 171 / 171 | 173 / 173 | 171 / 170 | 174 / 174 |

各1組の観測で、ホストの競合やOSキャッシュ状態を完全には統制していない。検査方式は維持しており、この表からスキャンの改善・悪化を実装の効果として主張しない。

別途、新規Pythonプロセスから解析用HTTP受付までを比較：**8,889→329ms（CPU8,956→321ms）**。解析だけで約8.56秒のwall／8.635 CPU秒を省けた。変更後の取得用healthは8,331ms（CPU8,251ms）で、必要なエンジン確認は残る。停止は旧716ms／新766ms。これはローカルのprocess停止でありCloudflare停止時間ではない。

実ネットワークのURL解析・取得・R2保存時間の前後比較は未実施。大容量本番E2Eは再投入していない。

## 費用の推定

[Cloudflare公式料金](https://developers.cloudflare.com/containers/platform/pricing/)：CPUは実使用、memory/diskは割当量×稼働時間。付帯枠超過時、CPU $0.000020/vCPU秒、memory $0.0000025/GiB秒、disk $0.00000007/GB秒。

standard-2の6GiB/12GBにローカルの削減量を仮に適用すると、解析1回あたり `8.635×0.000020 + 8.56×6×0.0000025 + 8.56×12×0.00000007 ≈ $0.000308` の従量使用分。1000解析で約$0.308。**本番で同じ時間を省ける前提の推定**であり、付帯枠内なら請求差は0の場合がある。Workers/DO/D1/Queue、ネットワーク、固定費は含まない。

確定拒否は従来の最大3回分の追加取得・検査を回避できる。発生件数が不明なので月額削減量は算出しない。正常動画の最終検査費用は削減を実証していない。

## 検証・公開

構文確認PASS。Nodeは43件成功（全体42件＋追加CAS試験1件）。Windows Pythonは112件中87成功・外部ツール依存25skip。Docker内の全Python111件成功後、追加の最終成果物統合試験1件も成功。Chromium/Firefox、Docker build、Wrangler dry-run、Downloader個別build/target/自動更新契約はPASS。全体Web契約は対象外calculatorの既存build不一致でFAILし、無関係なファイルは変更していない。候補buildは`downloader-283d6cf15608`。最終commit・公開状態は作業完了報告に記載する。

実エンジン確認：動画・音声・画像、PASS_THROUGH／REMUX／変換の既存format fixtures、EICAR、YARA安全marker、偽装・破損・サイズ拒否、後方・境界・2GiB超。エンジン停止／定義異常／timeout・不完全応答時の配信禁止、再配送、R2配信側は一部mock試験。最終成果物統合試験は取得元とR2送信先のみmockで、形式判定・ffmpeg・ClamAV・YARA・SHAは実行する。実Cloudflare egress・Queue・R2配信の新規E2Eは未実施。

公開時はprocessing/queued/analyzing件数を読み取りで再確認し、既存の15分rollout graceを維持してWorkerとContainerを通常手順で更新する。旧Workerが必要とする`/health`も残してある。Worker版だけのrollbackでContainerまで戻ったとは扱わない。切り戻しは旧正常版`52fde2d`のDownloaderコードを復元した専用commitから、鮮度を満たす定義でimageを再buildし、Worker/Containerの両方をdeployする。認証・鍵・DB schema・保存期限・本番データの移行はない。古いimageの定義が7日を超えていたらそのまま再利用しない。
