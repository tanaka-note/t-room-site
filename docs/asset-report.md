# 資産運用報告のデータ更新

対象は `asset-report-k7m4q9x2/`。静的サイト・現在の表示・計算ルールを維持する。

## 正本と計算

- `data/portfolio-data.mjs`：JSON形式のオブジェクトをdefault exportするデータ正本。
- `portfolio-model.mjs`：データ検証と純粋な計算関数。
- `report.js`：データと計算モデルを読み込んで描画する。通常の評価額更新では編集しない。
- `tools/update-asset-report.mjs`：日次データ、履歴、HTML更新日、既存build metadataの更新窓口。

`basePrincipal` は全体成績の基準元本、各資産の `costBasis` は取得原価。両者の合計が一致する必要はない。
履歴の `rawMarketValue` と保有資産の `marketValue` 合計は売却損調整前の金額。
`performanceAdjustmentSnapshots` は `effectiveFrom` 以降に有効になる**累計調整値** `cumulativeValue` を保持する。
対象日以前で最も新しい1件だけを適用し、過去のsnapshotと合計しない。将来snapshotは過去の日付を変えない。

上部の時価総額はraw合計＋当日の調整値、損益はその金額−基準元本、損益率は損益÷基準元本。
ドーナツの構成比とセグメントはraw合計を基準にする。中央の表示額は従来どおり調整後金額。
`realizedProfit` は表示のみで、時価総額・成績へ加算しない。履歴チャートも各履歴日の調整値を使う。

## 通常の更新

入力JSONをignore済みの `tmp/` に用意する。必須項目は `period`（実在する `YYYY-MM-DD`）と
`marketValues`（**全銘柄**のstable IDをキー、評価額の非負整数を値にするオブジェクト）。
任意の `rawMarketValue` を渡すと、銘柄合計と一致するかも確認する。
`basePrincipal` を渡す場合は現在の値との一致が必須。銘柄名での照合・基準元本の自動変更は行わない。

全IDと現在値は、次の読み取りコマンドで取得できる。この出力を元に次の報告日と評価額を入力する。

```sh
node --input-type=module -e "import d from './asset-report-k7m4q9x2/data/portfolio-data.mjs'; console.log(JSON.stringify({period:d.period,marketValues:Object.fromEntries(d.assets.map(a=>[a.id,a.marketValue]))},null,2))"
npm run asset-report:update -- --input tmp/prices.json --dry-run
npm run asset-report:update -- --input tmp/prices.json
npm run asset-report:test
npm run verify:changed
```

更新日は現在の最新履歴より後でなければならない。同日二重追加、過去日、未入力・不明ID、不正数値、
合計不一致、基準元本変更を拒否する。検証と既存content-hash同期は一時コピーで完了させてから反映する。
不正入力・build準備失敗では正本を変更しない。正常更新で変更するのはデータ、HTML、Service Workerだけ。
描画コード・計算ルールテスト・月次コメント・取得原価・色は変更しない。

## 意図的な銘柄・調整・方針変更

stable IDは一度設定したら表示名を変更しても維持する。更新ツールは名前や並び順ではなくIDで評価額を対応させる。
銘柄追加時はデータ正本に一意のID、名称、分類、取得原価、評価額、色を追加する。
次回の報告日に初めて保有する銘柄は現在値0で定義してから、その日の更新入力に含めることができる。
過去・現在の保有内容を訂正する場合は現在資産合計と最新履歴のraw値を合わせ、整合性テストを通す。

売却損の変更は新しい有効日と累計値をsnapshotに1件追加する。開始日は重複不可・昇順で、売却損なので値は0以下。
基準元本の方針変更は `BASE_PRINCIPAL` とデータ・履歴の扱いを別途レビューする。価格更新ツールでは受け付けない。
月次コメントはデータ内のentriesを編集する。通常の価格更新で内容を変更しない。
意図的なデータ・モデル変更後のbuild同期には `node tools/sync-web-app-builds.mjs --target asset-report` を使う。

## CI・PWA・公開

資産報告本体・専用データ・更新ツール・テストは既存の差分判定でsiteを選ぶ。
site profileで `asset-report:test` を必ず実行するため、`verify:changed`、GitHubのsite job、公開前検証から漏れない。
計算ルールは架空の固定fixture、現在データは個別金額を固定しない整合性検証に分離する。
更新ツールは拒否入力・dry-run・準備失敗・正常更新を一時checkoutで試験する。

ES moduleのdata/modelはreportと同じbuild queryで読み込む。HTMLのmodulepreload参照を既存buildシステムが同期し、
Service Workerのprecacheへ含める。CSP・認証方式は変更しない。
Chromium試験は実際のPC/スマートフォン表示、範囲切替・tooltip・構成比・表・オフライン再読込、
300/1,000/3,000履歴と20/25/30銘柄をローカルHTTP fixtureで確認する。

正規の本番リリースは[開発フロー](development-flow.md)に従う `npm run release -- site`。
PRは検証と任意のversions upload Previewまでで、本番へは反映しない。
GitHub連携のCloudflare Workers Buildsはこのリリースとは別のチェックであり、成功・失敗を混同しない。
Workers Buildsの設定・ログ権限の現状は[2026-10-17監査記録](history/2026-10-17-asset-report-build-audit.md)を参照。
