# PR #81 復号・並列数の追加調査（2026-10-22）

PR #81 の `bf27b5cf6c7a8b27394042216b2f7b4bd6640282` と、取得時の最新main `bca2924a` を確認。共通祖先からmain側26、PR側4コミットで、競合なく統合した。追加変更は計測スクリプト、実行コマンド、本記録に限定する。

## 調査結果と判断

既存 `hydrateFileRecords()` はキャッシュ一致時にもファイル鍵のenvelopeを認証してから表示メタデータを再利用する。鍵解除を省略する変更は今回行わない。セッションをまたぐ鍵の再利用、API応答前の表示、認証・認可・暗号方式の変更もない。

既存計測には次の問題があった。

- 1つの `createFilePackage()` のpayloadを全IDに複製し、独立したファイル鍵・暗号化メタデータを持つ実際の一覧と異なっていた。
- 初回表示とBackの両方で `searchMetadataCache.clear()` を行い、再訪のメタデータキャッシュを測定できなかった。
- 既定の `cacheDelay=0` では `TCloudDisplayCache.supported()` をfalseにしていた。`displayCacheScope()` が空になり、メモリ側のメタデータキャッシュも無効になっていた。

修正後はファイルごとに実WebCryptoで異なる鍵・IV・ファイル名を生成し、候補の並列数間で同じレコードを使用する。全件のキャッシュなし／ありのhydrationと、32件の初回表示／保存済み全件のBack復元を別々に測る。Backの前には既存fixtureと同じく、全件取得済みの表示状態を計測区間外で準備する。バックグラウンド追加取得とメタデータキャッシュの準備を待機してから次の区間を開始する。

各計測では、全件の鍵解除、cold時の全件メタデータ復号、warm時の復号0回、並列上限、復号後のID・順序・名前、BackでのAPI再取得・復元件数・スクロール誤差2px以内、pageerrorなしを検査する。表示と位置の一括確定、`canFallbackToDisplayListing()`、`restoreNavigationPosition()`、`ensureNavigationOriginRendered()` はPR #81から変更していない。

## 計測方法

Linuxの同一環境、Playwright 1.56.1、Chromium 141.0.7390.37 / WebKit 26.0。desktopは1280×800、touchは390×800で `hasTouch` を有効にする。これは実機iOS/Safariの測定ではない。不足OSライブラリは作業用領域へ展開し、GLESの実ロードを確認した。system ldconfigに登録されないためPlaywrightのhost requirement事前検査のみ無効化したが、Chromium／WebKit本体とブラウザassertは実行している。ファイル内容とAPI応答は合成データで、本番DB/R2は使用しない。

4・8・12・16並列を比較。候補ごとにwarm-upを1回除外し7回測定し、実行順は巡回・反転する。2回目は候補リスト自体を逆順にし、別のAPI遅延条件でも確認する。各sampleにiterationと候補順を保存する。WebKitのHistory頻度制限に達しないよう、計測区間外で直近の履歴操作回数を確認して待機する（実際のpushState／replaceState／Backは維持）。n=7のp95は最大観測値で、長期的なtailの保証ではない。計測コード自身のオーバーヘッドも含むため、数msの差だけで製品の設定変更を決めない。

`folderKey` はフォルダ鍵取得の経過時間、`mapperQueue` はそのhydration開始から各mapperが実行されるまでの待ち時間、`unlockFileKey` / `decryptFileMetadata` はそれぞれのPromiseの経過時間を記録する。`steps` のmedian/p95は各sample内の**累積時間**の分布で、並列処理や関数の包含関係により重複する。合計して壁時計時間やCPU時間と解釈しない。`cryptoBusyMs` は重なったcrypto Promise区間の和集合で、ネイティブ暗号処理の実行時間とブラウザ内部の待機を分離したものではない。このfixtureではフォルダ鍵は解除済みで、RSAによるフォルダ鍵復元や鍵のcold startは測定しない。

ナビゲーションの `ms` は処理完了後2回のrequestAnimationFrameを含み、`commitMs` はその前まで。実pixel paint完了を保証する値ではない。warmは同一ページ／有効なfixtureセッションのメモリキャッシュであり、ブラウザ再起動後や別セッションの再利用を意味しない。

## 採用方針

製品の8並列を維持する。16並列は80ms条件のWebKit Backで有利だったが、15ms条件ではdesktopのBackのp95が8並列712msに対して16並列752ms、touchのcold hydration中央値が53msに対して60msとなった。4並列にも一貫した優位はなく、Chromiumのtouchでは15ms条件のBack中央値が8並列413.3msに対して4並列440.9msとなった。全条件で優位かつ安定した置換候補は確認できない。

各run内では同じデータ・遅延条件で候補を比較している。2回目は実行順とAPI遅延の両方を変えているため、run間の差を順序だけの効果とは解釈しない。候補の順序による偏りは各run内の巡回・反転で抑える。

15ms条件・8並列・WebKit desktopのBack中央値665msに対し、ページごとの `hydrateFileRecords` の累積中央値は33ms、`renderItems` は169ms、`applyNavigationPosition` は179msだった（各指標の中央値で、区間の包含・重複もあるため単純合計しない）。このfixtureではファイル鍵解除だけが復帰全体の主要因とは確認できず、鍵の再利用を追加する根拠は不足している。

メタデータのメモリキャッシュは機能しており、warm時の復号は0回だった。新たなファイル鍵キャッシュは追加しない。WebKitの実機CPU・Safari、実APIやネットワーク、フォルダ鍵のcold startは未測定で、今回の結果から8並列をあらゆる環境の最適値と断定もしない。今後その条件でボトルネックが再現した場合に、この計測を基に追加検討する。

## 1,056件の結果

単位ms、各セルは **median / p95**。Cold first pageは32件、他は1,056件なので、列どうしを同一処理のbefore/afterとして比較しない。

### 通常順・API遅延15ms

| Engine / device | Concurrency | Cold hydration | Warm hydration | Cold first page | Warm Back |
|---|---:|---:|---:|---:|---:|
| chromium / desktop | 4 | 48.1 / 61.8 | 22.5 / 26.7 | 39.2 / 48.5 | 431.5 / 503.7 |
| chromium / desktop | 8 | 47.0 / 52.0 | 23.2 / 26.3 | 37.6 / 48.4 | 458.6 / 496.0 |
| chromium / desktop | 12 | 49.7 / 54.7 | 25.8 / 27.3 | 39.2 / 42.7 | 450.7 / 509.1 |
| chromium / desktop | 16 | 48.0 / 50.7 | 24.1 / 26.4 | 38.9 / 45.7 | 451.7 / 479.2 |
| chromium / touch | 4 | 43.5 / 48.1 | 29.5 / 31.9 | 72.6 / 82.2 | 440.9 / 471.2 |
| chromium / touch | 8 | 46.7 / 52.7 | 23.0 / 27.6 | 42.5 / 55.2 | 413.3 / 440.6 |
| chromium / touch | 12 | 51.1 / 128.7 | 22.7 / 24.7 | 45.4 / 68.2 | 434.3 / 462.9 |
| chromium / touch | 16 | 47.0 / 101.7 | 23.3 / 30.6 | 46.2 / 48.9 | 415.6 / 488.0 |
| webkit / desktop | 4 | 53.0 / 168.0 | 26.0 / 29.0 | 72.0 / 92.0 | 666.0 / 692.0 |
| webkit / desktop | 8 | 54.0 / 58.0 | 23.0 / 40.0 | 72.0 / 83.0 | 665.0 / 712.0 |
| webkit / desktop | 12 | 50.0 / 59.0 | 22.0 / 32.0 | 67.0 / 78.0 | 697.0 / 702.0 |
| webkit / desktop | 16 | 48.0 / 57.0 | 25.0 / 29.0 | 62.0 / 96.0 | 673.0 / 752.0 |
| webkit / touch | 4 | 57.0 / 76.0 | 27.0 / 39.0 | 48.0 / 64.0 | 612.0 / 661.0 |
| webkit / touch | 8 | 53.0 / 68.0 | 23.0 / 32.0 | 50.0 / 54.0 | 614.0 / 678.0 |
| webkit / touch | 12 | 54.0 / 71.0 | 27.0 / 31.0 | 53.0 / 56.0 | 618.0 / 679.0 |
| webkit / touch | 16 | 60.0 / 70.0 | 29.0 / 29.0 | 52.0 / 65.0 | 615.0 / 672.0 |

### 逆順・API遅延80ms

| Engine / device | Concurrency | Cold hydration | Warm hydration | Cold first page | Warm Back |
|---|---:|---:|---:|---:|---:|
| chromium / desktop | 4 | 52.8 / 85.0 | 24.6 / 26.1 | 102.3 / 107.1 | 855.0 / 919.7 |
| chromium / desktop | 8 | 48.9 / 54.3 | 23.7 / 26.5 | 100.2 / 106.3 | 838.1 / 859.6 |
| chromium / desktop | 12 | 48.9 / 69.4 | 24.1 / 29.7 | 103.4 / 106.7 | 840.5 / 872.1 |
| chromium / desktop | 16 | 50.6 / 117.3 | 25.3 / 48.2 | 102.6 / 105.0 | 836.5 / 874.2 |
| chromium / touch | 4 | 60.3 / 82.7 | 25.2 / 33.5 | 100.2 / 103.0 | 813.5 / 858.8 |
| chromium / touch | 8 | 52.4 / 59.4 | 24.1 / 34.4 | 99.3 / 106.7 | 824.9 / 890.4 |
| chromium / touch | 12 | 56.1 / 58.6 | 23.1 / 26.7 | 104.0 / 114.1 | 830.0 / 893.9 |
| chromium / touch | 16 | 50.5 / 60.6 | 24.4 / 31.0 | 104.6 / 111.2 | 800.4 / 880.8 |
| webkit / desktop | 4 | 57.0 / 62.0 | 27.0 / 35.0 | 131.0 / 149.0 | 1044.0 / 1127.0 |
| webkit / desktop | 8 | 50.0 / 64.0 | 23.0 / 33.0 | 129.0 / 133.0 | 1055.0 / 1124.0 |
| webkit / desktop | 12 | 47.0 / 55.0 | 25.0 / 31.0 | 130.0 / 136.0 | 1043.0 / 1115.0 |
| webkit / desktop | 16 | 41.0 / 75.0 | 24.0 / 31.0 | 135.0 / 139.0 | 1032.0 / 1073.0 |
| webkit / touch | 4 | 58.0 / 75.0 | 27.0 / 39.0 | 116.0 / 124.0 | 1026.0 / 1047.0 |
| webkit / touch | 8 | 50.0 / 76.0 | 25.0 / 34.0 | 118.0 / 125.0 | 1018.0 / 1037.0 |
| webkit / touch | 12 | 46.0 / 78.0 | 23.0 / 37.0 | 116.0 / 119.0 | 1009.0 / 1028.0 |
| webkit / touch | 16 | 53.0 / 60.0 | 22.0 / 30.0 | 115.0 / 121.0 | 974.0 / 1027.0 |

## 再実行

```sh
# リポジトリrootで実行。依存関係とブラウザの導入はdocs/development-flow.mdを参照。
TCLOUD_PERF_REPEATS=7 TCLOUD_PERF_COUNTS=160,500,1056 \
TCLOUD_PERF_LATENCIES=15 TCLOUD_PERF_OUTPUT=../work/performance-forward.json \
node cloud-worker/tests/folder-navigation-performance.browser.mjs

TCLOUD_PERF_REPEATS=7 TCLOUD_PERF_COUNTS=1056 \
TCLOUD_PERF_LATENCIES=80 TCLOUD_PERF_CONCURRENCIES=16,12,8,4 \
TCLOUD_PERF_OUTPUT=../work/performance-reverse.json \
node cloud-worker/tests/folder-navigation-performance.browser.mjs
```

`npm --prefix cloud-worker run test:folder-navigation-performance` でも実行可能。対象限定には `TROOM_BROWSER=webkit` / `chromium`、`TCLOUD_PERF_DEVICE=desktop` / `touch` を指定する。既定は両engine・両device、160/500/1,056件、15/80ms、7回、4/8/12/16並列。concurrency overrideと計測コードはテストが配信するコピーだけへ注入し、製品コードには追加しない。countはメタデータキャッシュ上限4,096件まで。`TCLOUD_PERF_SOURCE` は同じ計測境界を持つ互換ソースのみ対応し、境界不一致では検査を停止する。

## ローカル検証結果

- 修正後の性能測定は通常順192・逆順64の集計グループ（それぞれ7回＋warm-up1回）で成功。全件の鍵解除、cold/warmの復号回数、並列上限、復元件数と位置のassertを通過した。
- `node tools/verify.mjs --target cloud --build`：Cloud標準Node回帰・構文検査・Worker dry-run成功。本番へpublishしていない。
- Chromium／WebKitで `folder-scroll-position.browser.mjs`（内部のnavigation review／startup securityを含む）、`persistent-display-cache.browser.mjs`、`listing-boundary.browser.mjs`、`local-search.browser.mjs` が成功。startup securityは各engine×desktop/touchで125 cache/transport＋22復元＋1 root fallback条件が成功した。
- `node --check cloud-worker/tests/folder-navigation-performance.browser.mjs`、`node tools/check-web-app-builds.mjs --target t-room-cloud`、`git diff --check`：成功。Cloud buildはPR #81の `cloud-531654d4b16f` のままfreshで、追加修正に製品コードの変更はない。

実機Safari／iOS、本番DB／R2／ネットワークを使う性能検証、mainへのマージ、本番公開は実施していない。
