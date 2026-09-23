# 公開サイトCSS責務マップ

## 目的

この文書は、公開サイトの`styles.css`で「どのUIをどこで直すか」を判断するための正本である。CSSの短縮や分割そのものを目的にせず、現行表示を維持しながら責務とカスケードを管理する。

対象はルートの`styles.css`を直接参照する38個のHTMLである。`asset-report-k7m4q9x2/`、Worker配下のDiary・T-Cloud・Billing・Security Center・Downloader、各独立Webアプリは専用CSSを使用するため対象外とする。

行番号は現在位置の補助情報である。編集後は区分コメント、開始セレクタ、責務を優先して判断する。

## ページ群と所有責務

| ページ群 | ページ数 | 主なファイル | 所有するCSS |
| --- | ---: | --- | --- |
| ホーム | 1 | `index.html` | Hero、Rooms、Latest、About |
| 記事一覧 | 1 | `articles.html` | 検索、タグ、記事カード、サイドバー |
| 汎用Room | 2 | `work.html`、`life.html` | 汎用2カラム、空状態、Roomパネル |
| Investment | 4 | `investment.html`、投資記事3ページ | 投資Hero、マーケット、記事一覧、分析、記事本文 |
| 公開Diary | 3 | `diary.html`、`diary/`配下 | 日記一覧、検索、年月、タグ、記事本文 |
| Learning | 17 | `learning/`配下 | 学習トップ、科目、トピック、ログ、検索、学習用図解 |
| Game／App | 4 | `game.html`、ゲーム2ページ、`apps.html` | 一覧カード、ゲーム盤面、操作UI、アプリカード |
| Thought／Columns | 6 | `thought.html`、`columns/`配下 | Thought専用テーマ、一覧、シリーズ、記事本文 |

## 15区分

| 区分 | 現在位置 | 責務 | 主な注意点 |
| --- | ---: | --- | --- |
| 01 Foundation and site shell | 1–104 | 基本token、reset、本文、共通ヘッダー、ブランド、ナビゲーション | 全ページへ波及する。`[hidden]`とゲーム中のヘッダー制御は状態契約 |
| 02 Shared hero and controls | 105–215 | 共通Hero、見出し、導入文、CTA、ボタン | Hero画像・overlay・contentを一つのcomponentとして扱う |
| 03 Home sections and topic cards | 216–422 | 共通Section、ホーム概要、Roomsカード | 共通surface指定とカード固有構造を区別する |
| 04 Archives, profile, and article content | 423–818 | 記事一覧、検索、タグ、記事カード、プロフィール、汎用記事本文 | `.post-card`は`site.js`の生成UIでもある |
| 05 Subpage hero variants | 819–899 | 下層ページHeroとInvestment／Game／App差分 | 共通Heroとの差分だけを持つ |
| 06 Investment hub | 900–1266 | Investmentトップ、記事導線、分析、マーケット、注意表示 | マーケットカードは`site.js`が生成する |
| 07 Generic rooms | 1267–1329 | Work／Lifeの2カラムと空状態 | `.room-side`は構造とstickyの責務が分かれる |
| 08 Public Diary | 1330–1727 | 公開Diaryの一覧、タグ、検索、年月、本文、固有responsive | 860px／620pxはこの区分内で完結する |
| 09 Learning | 1728–2523 | Learning全体、検索、カード、科目、ログ、記事、表、図解 | 動的カードと種類別表現を単純な重複として削除しない |
| 10 Game and app catalog | 2524–2756 | ゲーム／アプリ一覧カードと装飾 | 疑似要素とdata URI装飾もVisual Regression対象 |
| 11 Playable games | 2757–3098 | BLOCKS／Garden Hopの盤面、HUD、操作、状態 | JavaScriptの状態クラスに依存する |
| 12 Site footer | 3099–3118 | 共通フッター | Thoughtでは後続テーマが色を特化する |
| 13 Shared responsive rules | 3119–3379 | 920px／640pxでの共通・ページ群別切替 | 影響範囲が広いため順序を変えない |
| 14 Thought theme and columns | 3380–3883 | Thought専用token、Hero、一覧、シリーズ、本文 | `body.thought-page`を独立したテーマ境界として維持する |
| 15 Small-screen exceptions | 3884–3922 | 720px以下のThought表示とInvestment導線 | 640px規則より後に適用される現行順を維持する |

## JavaScriptとのCSS契約

静的HTMLだけで未使用判定をしない。次の生成・状態クラスも利用箇所として照合する。

| JavaScript | 主なクラス |
| --- | --- |
| `site.js` | `.header-hidden`、`.app-card*`、`.post-card*`、`.market-card*` |
| `diary/diary.js` | `.diary-entry-card`、`.diary-tags`、`.diary-month-group`、`.diary-empty` |
| `diary/diary-search.js` | `.diary-search-result` |
| `learning/learning.js` | `.learning-log-card`、`.learning-subject-card`、`.learning-topic-card`、`.learning-mini-stats` |
| `learning/learning-search.js` | `.learning-search-result`、`.learning-card-meta` |
| `blocks-game.js` | `body.blocks-game-playing`、`.is-playing`、`.hidden`、`.active` |
| `hop-game.js` | `.hidden` |

## Design Token

`:root`のtokenは、複数の責務で同じ意味を持つ値だけを管理する。

| token | 意味 |
| --- | --- |
| `--ink`、`--muted` | 基本文字色、補助文字色 |
| `--line` | 基本境界線 |
| `--paper`、`--surface` | ページ背景、共通surface |
| `--teal`、`--teal-dark` | 基本accentと強調accent |
| `--amber`、`--rose` | 共通の注意・状態色 |
| `--shadow` | 共通surfaceの影 |
| `--focus-ring` | 共通フォームのfocus ring |

値が同じという理由だけでtoken化しない。Thoughtのtheme token、Investment・Game・Learning固有の装飾色は意味が異なるため固有値のままにする。spacing、radius、breakpointも、複数componentで同じ設計上の意味を持つと説明できる場合だけ追加する。

## responsiveの適用順

source orderは次の順で維持する。

1. Public Diary区分内の860px
2. Public Diary区分内の620px
3. Shared responsive rulesの920px
4. Shared responsive rulesの640px
5. Thought theme
6. Small-screen exceptionsの720px

Diary固有responsiveはDiaryの責務内で完結する。920px／640pxは複数ページ群を横断する共通切替である。末尾720pxはThoughtとInvestmentの小画面例外であり、現状では移動すると適用順を変えるため、その位置を意図的に維持する。breakpointの値や順序を変える場合はリファクタリングではなくresponsive設計変更として扱う。

## 意図的に残すカスケード

次は後方宣言が現在値を特化する、説明可能な責務分担である。

- 共通surfaceから`.learning-topic-card`のgradientへ特化するbackground指定
- `.learning-table th, td`の共通文字色から`th`を強調する色指定
- Thoughtカード群の共通borderから、記事・シリーズ・readingの指定辺をaccent化する指定
- `.thought-series-card dt, dd`の共通文字指定から`dd`を強くする色指定
- 920px以下のInvestmentカード2列に対し、640px以下でgapだけを狭める指定
- 共通フッターからThoughtテーマのフッター色へ特化する指定

CSSOMではbackgroundやborderのshorthandがlonghandへ展開され、同一propertyの再指定として検出される。意味の異なる共通指定と固有指定を、検出件数だけを理由に統合しない。

## `!important`の扱い

最終的な記述は7件で、新規追加は原則禁止する。

| 対象 | 件数 | 維持理由 |
| --- | ---: | --- |
| `[hidden]` | 1 | component固有の`display`よりHTMLの非表示状態を優先する契約 |
| `body.blocks-game-playing .site-header` | 1 | ゲーム中のJavaScript状態でヘッダーを確実に退避させる契約 |
| `.investment-hero-note` | 2 | 共通Hero本文の高い詳細度に対する既存の局所例外 |
| `.market-mood-card p` | 1 | Investment panel共通段落余白に対する局所例外 |
| `.market-name` | 1 | Market card共通段落余白に対する局所例外 |
| `.market-price` | 1 | Market card共通段落余白に対する局所例外 |

Investmentの5件は、削除すると現在値が変わり、解消には詳細度上昇またはshared component構造の変更が必要になるため維持する。新しい`!important`は、native属性またはJavaScript状態契約で通常の責務分離では保証できず、その理由と影響範囲を文書化できる場合だけ検討する。

## 今後の編集ルール

- 共通tokenは`:root`、共通componentは該当する01〜05区分、ページ固有UIは所有する06〜15区分へ置く。
- 既存componentの変更は現在の責務位置で完結させ、ファイル末尾へ補正ルールを追加しない。
- overrideが必要に見える場合は、共通値、固有差分、状態差のどれかを先に判定する。同じ責務の最終形が後勝ちで完成している場合は元の責務位置へ統合する。
- selector詳細度を上げることや`!important`追加を整理の代替にしない。
- 新しいページ固有themeは共通tokenへ混ぜず、明確なbody class等を境界にする。
- CSS変更前に対象画面がVisual Regressionで保護されているか確認する。未保護の動的UIは、生成完了を待つ検査を独立commitで先に追加する。
- リファクタリングで差分が出た場合、基準画像更新や許容値緩和で通さず原因を直す。
- 未使用判定はHTML、JavaScript生成クラス、状態クラス、疑似要素、responsive条件まで確認する。

## ファイル分割の判断

現時点では`styles.css`を分割しない。15区分で修正場所が明確になり、38ページの読込順を変更せず責務を追えるためである。分割すると複数ファイルの読込順という新しいカスケード契約とHTML差分が生じる。

将来、一つの責務が独立して再利用され、他区分との適用順へ依存せず、読込元も明確に限定できる場合にだけ分割を再検討する。

## 基盤整理の結果

- 640px以下の`.market-card-grid`から不要な1列指定を除去し、Investment固有の2列指定を唯一の最終定義にした。
- `.post-card h3`の分散したmarginをArchives区分の一つの定義へ統合した。
- `.learning-mini-stats dd`の同値`margin-left`再指定を除去した。
- 公開サイトから参照されないDiary用Investment CSSを削除した。Worker側Diaryの専用CSSとHTMLは変更していない。
- 基本文字色、補助文字色、Learning accent、focus ringを意味に対応するtokenへ揃えた。
- 代表11画面をPC・スマートフォンで保護し、重要領域、computed style、矩形、要素間距離、横スクロール、Web Font、動的生成UIを検査する。

`origin/main`時点の4,010行・75,216 bytes・595 style rulesから、3,922行・73,481 bytes・583 style rulesになった。行数削減は結果であり、削除内容は未使用定義と不要な重複に限定している。
