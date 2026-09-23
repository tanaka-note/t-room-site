# 公開サイトCSS整理候補

## 目的

この文書は、`styles.css`の責務コメント追加後に、同一セレクタ・同一プロパティの再指定と、見かけ上重複している定義を現在のカスケード結果まで確認して分類した記録である。ここでは候補の評価だけを行い、CSS宣言、セレクタ、記述順、media queryの位置は変更しない。

調査基準は`codex/css-foundation-public-site`の`fdb5030`である。HTML上の静的利用だけでなく、`site.js`、Diary、Learning、ゲームのJavaScript生成クラスと状態クラスも照合した。画面幅による結果は通常ルール、920px、720px、640pxの各条件を分けて確認した。

## 最初に整理する順序

影響範囲が小さく、現在値を変えず、既存Visual Regressionで保護できる順序は次のとおりとする。

1. 640px以下の`.market-card-grid`の相反する列指定
2. `.post-card h3`の分散したmargin指定
3. `.learning-mini-stats dd`の重複した`margin-left: 0`

1はInvestmentのmobile基準で画像・領域画像・computed styleがすでに揃っている。2はホームのLatest領域画像と記事一覧画像で確認できるが、二画面で使う共通生成カードの定義移動を伴う。3はLearning内だけの同値再指定で影響は最小だが、利用ページの科目一覧が現在の代表10画面に含まれないため、先に対象画面または要素のVisual Regressionを追加してから扱う。

## 明確な矛盾

### `.post-card h3`の`margin-top`

| 項目 | 確認結果 |
| --- | --- |
| 先行宣言 | Home区分の`.post-card h3`で`margin: 18px 0 8px` |
| 後方宣言 | Archives区分の`.post-card h3`で`margin-top: 6px` |
| 現在の最終値 | `margin: 6px 0 8px` |
| 最終値になる理由 | 同一セレクタ・同一詳細度・同一通常コンテキストのため、後方の`margin-top`だけが先行shorthandの上辺を上書きする |
| 利用範囲 | `site.js`がホームのLatestと`articles.html`の記事一覧に生成する`.post-card` |
| 自然な整理先 | Archives区分のカード本体付近へ、`font-size`、`line-height`と最終的な`margin: 6px 0 8px`を一つの`.post-card h3`として置く。Home区分の同定義は残さない |
| 波及確認 | 静的HTMLには生成されず、生成元は`site.js`の共通`createPostCard()`だけ。ホームと記事一覧の両方が同じ最終値を使っているため、最終値を保持する統合なら他ページへ波及しない |
| 保護手段 | desktop/mobileのhome・articles、homeのLatest領域画像 |

これは意図的な状態差ではなく、同じ要素の基本余白が二つの責務区分に分散し、後勝ちで完成している。整理時も表示値は変更しない。

## 不要なoverride候補

### `.learning-mini-stats dd`の`margin-left`

| 項目 | 確認結果 |
| --- | --- |
| 先行宣言 | `.learning-mini-stats dd`に`margin: 5px 0 0` |
| 後方宣言 | `.learning-mini-stats dt, .learning-mini-stats dd`に`margin-left: 0` |
| 現在の最終値 | `dd`は`margin: 5px 0 0`。左余白は先行shorthandの時点ですでに`0` |
| 最終値になる理由 | 後方の`margin-left: 0`は同一詳細度で再適用されるが、値が同じため結果を変えない |
| 利用範囲 | `learning/learning.js`が科目カード内に生成する`dl.learning-mini-stats` |
| 自然な整理先 | `dt`に必要な定義だけを`.learning-mini-stats dt`の既存文字指定へ寄せ、`dd`を後方のmargin-left指定から外す |
| 波及確認 | 対象はLearningの生成済み統計だけ。`dd`の四辺の最終値は変わらず、`dt`のブラウザ既定左余白だけは引き続き0に保つ必要がある |
| 保護手段 | 現在の代表10画面には利用ページがない。実変更前に`learning/sharoushi/subjects/`または`.learning-mini-stats`の領域画像とcomputed styleを追加し、最終marginを固定する |

### 640px以下の`.market-card-grid`

| 項目 | 確認結果 |
| --- | --- |
| 先行宣言 | 640px media queryの共通1列化グループで`grid-template-columns: 1fr` |
| 後方宣言 | 同じ640px media queryのInvestment固有ルールで`repeat(2, minmax(0, 1fr))` |
| 現在の最終値 | 640px以下は2列。390px基準では149px + 149px、gap 10px |
| 最終値になる理由 | 同一セレクタ・同一詳細度・同一media query内で、後方のInvestment固有ルールが1列指定に勝つ |
| 利用範囲 | `investment.html`の一か所。カードは`site.js`がAPI fixtureから生成する |
| 自然な整理先 | `.market-card-grid`を共通1列化グループから外し、直後のInvestment固有ルールを唯一の640px指定にする。920px以下の2列指定は別のブレークポイント責務として維持する |
| 波及確認 | グループ内の他セレクタには触れず、`.market-card-grid`の後方最終値も変わらない。Investment以外に同クラスの利用はない |
| 保護手段 | desktop/mobileのinvestment、Market領域画像、`.market-card-grid`のcomputed styleと横スクロール検査 |

## 意図的な分割

次は後方宣言が現在値を変えているが、共通責務から固有責務への正常な特化である。削除・一本化の候補にはしない。

| 定義 | 現在の最終値 | カスケードの理由 | 維持する責務 |
| --- | --- | --- | --- |
| `.learning-table th, td`の`color: #4f5b66` → `.learning-table th`の`color: var(--ink)` | `th`は`#1f2933`、`td`は`#4f5b66` | 共通セル指定の直後に、同一詳細度の見出しセル指定が後勝ちする | セル共通可読性と見出し強調の分離 |
| `.thought-series-card dt, dd`の`color: var(--thought-muted)` → `dd`の`color: #384550` | `dt`は`#70757b`、`dd`は`#384550` | 用語と値の共通タイポグラフィを置いた後、値だけを強くする | Thoughtテーマ内のラベルと値の視覚階層 |
| Learningカード群の`background: var(--surface)` → `.learning-topic-card`のgradient background | Topicカードはgradientと`var(--surface)`の二層背景 | 共通surfaceを受けた後、カード種別の装飾を完全なbackground shorthandで特化する | Learning共通surfaceとTopic固有装飾 |
| Thoughtカード群の`border` → articleの`border-left`、series/readingの`border-top` | 共通四辺borderを保持し、指定辺だけ太さと色を変更 | border shorthandの後に固有辺を上書きする | Thought共通surfaceとカード種別のアクセント |
| 920pxの`.market-card-grid` 2列 → 640pxの同2列 + gap 10px | 920px以下も640px以下も2列、640px以下だけgap 10px | ブレークポイントごとに固有の間隔を追加する | Investmentカードのスマートフォン密度 |

CSSOMではbackgroundやborderのshorthandが各longhandへ展開され、空文字の同値重複として検出される場合がある。上表のbackground・borderはその機械的な展開を重複削除の根拠にしない。

## 今回は整理対象にしないもの

- `[hidden]`、`.header-hidden`、`body.blocks-game-playing`、`.active`、`.hidden`は、表示状態をJavaScriptから切り替える契約であり、静的HTMLに見つからないことを未使用の根拠にしない。
- Diaryの860px／620px media queryはDiary責務内で完結している。共通responsiveへ移す理由はない。
- 末尾720px media query内のInvestment運用実績指定は責務区分上は越境しているが、640px規則より後に適用される現行順を含めて動作している。最初の整理候補にはせず、Investment全体のresponsive整理時に個別検証する。
- Thoughtは`.thought-page`配下の独立テーマであり、基本tokenと値が似ていても統合しない。Thoughtのborder・色の再指定はテーマ内の状態差として維持する。
- 9件の`!important`は、`[hidden]`、ゲーム中の状態制御、Investment内の局所指定が混在する。今回の重複調査だけでは安全な削除根拠にならないため候補化しない。
- JavaScript生成クラスは`site.js`、`diary/diary.js`、`diary/diary-search.js`、`learning/learning.js`、`learning/learning-search.js`、`blocks-game.js`、`hop-game.js`まで照合済みであり、未使用候補には含めない。

## 次工程の停止点

次に着手する場合も、上記1件ずつを独立した差分として扱い、宣言値を変えずに統合する。各変更後に対象ページのVisual Regressionを実行し、最後に20パターン一式と`npm run verify:changed`を通す。この文書作成時点ではCSSの実変更には入らない。
