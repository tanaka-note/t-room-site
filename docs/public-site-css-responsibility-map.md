# 公開サイトCSS責務マップ

## 目的

この文書は、公開サイトの`styles.css`を整理する前の現行責務を示す正本である。行数削減やファイル分割の計画ではなく、表示を変えずに「どのUIをどこで直すか」を判断するために使う。

基準は`origin/main`の`6dc14945edf439c588e7380611150dcb8f4ac0ff`と、Visual Regression基盤を追加した`codex/css-foundation-public-site`である。調査時点の`styles.css`は4,010行で、38個のHTMLが直接参照している。

行番号は調査時点の補助情報とし、境界セレクタを優先して判断する。CSS編集後に行番号がずれても、開始・終了セレクタと責務が同じならこの区分を維持する。

## 対象範囲

| ページ群 | ページ数 | 主なファイル | 所有するCSS |
| --- | ---: | --- | --- |
| ホーム | 1 | `index.html` | Hero、Rooms、Latest、About |
| 記事一覧 | 1 | `articles.html` | 検索、タグ、記事カード、サイドバー |
| 汎用Room | 2 | `work.html`、`life.html` | 汎用2カラム、空状態、Roomパネル |
| Investment | 4 | `investment.html`、投資記事3ページ | 投資Hero、マーケット、記事一覧、分析、記事本文 |
| 公開Diary | 3 | `diary.html`、`diary/archive.html`、`diary/tags.html` | 日記一覧、検索、年月、タグ、記事本文 |
| Learning | 17 | `learning/`配下 | 学習トップ、科目、トピック、ログ、検索、学習用図解 |
| Game／App一覧 | 4 | `game.html`、`blocks-game.html`、`hop-game.html`、`apps.html` | 一覧カード、ゲーム盤面、操作UI、アプリカード |
| Thought／Columns | 6 | `thought.html`、`columns/`配下 | Thought専用テーマ、一覧、シリーズ、記事本文 |

`asset-report-k7m4q9x2/`、Worker配下のDiary・T-Cloud・Billing・Security Center・Downloader、各独立Webアプリは`styles.css`を参照しないため、この責務マップの対象外とする。それぞれの専用CSSは公開サイト整理へ混ぜない。

## 現在のカスケード順

| 現在位置 | 境界セレクタ | 責務 | 主な利用先 | 整理時の注意 |
| --- | --- | --- | --- | --- |
| 1–102 | `:root`〜`.site-nav a` | 基本token、reset、本文、共通ヘッダー、ブランド、ナビゲーション | 全38ページ | 全ページへ波及する。`[hidden]`、`.header-hidden`、ゲーム中のヘッダー制御は状態契約でもある |
| 103–212 | `.hero`〜`.button.secondary` | 共通Hero、見出し、導入文、CTA、ボタン | ホームと共通Hero利用ページ | Hero画像・overlay・contentは一つの部品。分割して別のoverride層を作らない |
| 213–428 | `.section`〜`.investment-card-note` | 共通Section、ホーム概要、Roomsカード | 主に`index.html` | `.topic-card`は複数の共通surface指定にも参加する |
| 429–817 | `.article-body`を含む共通色指定〜`.article-body ol` | 記事一覧、検索、タグ、記事カード、プロフィール、汎用記事本文 | ホーム、`articles.html`、投資記事、汎用記事 | 共通surfaceのグループセレクタと、後続の個別寸法指定を区別する |
| 818–897 | `.sub-hero`〜`.app-hero` | 下層ページHeroとInvestment／Game／AppのHero差分 | Investment、Game、Apps、Room系 | 共通Heroとの差分だけを所有する |
| 898–1350 | `.investment-layout`〜`.caution-panel` | Investmentトップのレイアウト、記事リンク、運用実績導線、分析、マーケット、注意表示 | `investment.html` | マーケットカードは`site.js`が生成する。末尾の720px例外にも依存する |
| 1351–1412 | `.room-layout`〜`.empty-state` | Work／Life等の汎用Roomレイアウトと空状態 | `work.html`、`life.html` | `.room-side`はレイアウト指定とsticky指定に分かれている |
| 1413–1810 | `/* Diary */`〜Diary用620px media query | 公開DiaryのHero、一覧、タグ、検索、年月、本文、Diary固有レスポンシブ | 公開Diary 3ページ | `diary.js`と`diary-search.js`の生成クラスを含む。860px／620px media queryはこの責務内にある |
| 1811–2606 | `.learning-hero`〜`.learning-article-footer` | Learning全体、検索、カード、科目、ログ、記事、表、学習用図解 | Learning 17ページ | 同じセレクタをsurface・寸法・interactionに分けた定義が多い。単純な重複として削除しない |
| 2607–2720 | `.game-library-grid`〜`.game-card-meta` | ゲーム一覧カードとカード内装飾 | `game.html` | 疑似要素の絵柄をVisual Regressionで保護する |
| 2721–2838 | `.app-card-grid`〜`.app-install-note` | アプリ一覧カードとアプリ別イラスト | `apps.html` | data URIの装飾を含む。機能ページ側のCSSとは別責務 |
| 2839–3179 | `.game-layout`〜ゲーム操作のfocus指定 | BLOCKS／Garden Hopの盤面、HUD、操作、メッセージ、サウンド | `blocks-game.html`、`hop-game.html` | `blocks-game.js`と`hop-game.js`の状態クラスに依存する |
| 3180–3198 | `.site-footer`〜`.site-footer a` | 共通フッター | 全38ページ | Thoughtでは後続テーマが色を上書きする |
| 3199–3459 | 920px／640px media query | 共通レイアウトと各ページ群のPC→SP切替 | Thought以外のほぼ全ページ | 複数責務を横断する最も影響範囲の広い層。移動・分割は個別検証なしに行わない |
| 3460–3962 | `.thought-page`〜`.thought-page .thought-site-footer a` | Thought専用token、Hero、一覧、シリーズ、本文、埋め込み、履歴、出典、ナビゲーション | Thought／Columns 6ページ | `body.thought-page`をテーマ境界として維持する。基本tokenへ無理に統合しない |
| 3963–4010 | 720px media query | ThoughtのSP表示とInvestment運用実績導線のSP例外 | Thought、`investment.html` | Investment指定がThoughtブロック後に置かれた越境箇所。移動時は640px規則との適用順を確認する |

## JavaScriptが生成・切替するCSS契約

HTML検索だけでは使用状況を判定できないため、次のクラスはJavaScriptとの契約として扱う。

| JavaScript | 主なクラス | CSS責務 |
| --- | --- | --- |
| `site.js` | `.header-hidden`、`.app-card*`、`.post-card`、`.post-meta`、`.post-tag`、`.post-arrow`、`.market-card*` | ヘッダー状態、アプリ一覧、Latest／記事一覧、マーケット表示 |
| `diary/diary.js` | `.diary-entry-card`、`.diary-tags`、`.diary-tag`、`.diary-month-group`、`.diary-empty` | Diary一覧、タグ、年月、空状態 |
| `diary/diary-search.js` | `.diary-search-result` | Diary検索結果 |
| `learning/learning.js` | `.learning-log-card`、`.learning-tag`、`.learning-subject-card`、`.learning-topic-card`、`.learning-mini-stats` | 学習ログ・科目・トピックの動的カード |
| `learning/learning-search.js` | `.learning-search-result`、`.learning-card-meta` | Learning検索結果 |
| `blocks-game.js` | `body.blocks-game-playing`、`.is-playing`、`.hidden`、`.active` | プレイ中のヘッダー、盤面、メッセージ、サウンド状態 |
| `hop-game.js` | `.hidden` | ゲームメッセージ状態 |

これらはHTMLに静的な同名クラスが見つからない場合でも、未使用CSSとして削除しない。

## 意図的に分かれている定義

同一セレクタが複数回現れるだけでは負債と判定しない。現在は次のような責務分担がある。

- `.hero-image, .hero-overlay`の共通配置と、`.hero-overlay`の背景表現
- `.topic-card`等の共通surfaceと、各カード固有の寸法・内部配置
- `.profile-panel, .newsletter-panel`の共通surfaceと、後続のpadding・本文・リスト指定
- `.room-main, .room-side`の共通gridと、`.room-side`のsticky指定
- `.learning-main, .learning-side`の共通gridと、`.learning-side`のsticky指定
- Learningカード群の共通surface、共通padding、種類別レイアウト、hover状態
- `.learning-status-grid`の共通grid宣言と列数指定
- `.game-card-label, .game-card-meta`の共通文字指定と、`.game-card-meta`の余白
- Thoughtカード群の共通surfaceと、一覧カード・シリーズカード・記事本文ごとの構造

整理時は、同じ意味の宣言を一か所へ集約できる場合だけ統合する。異なる責務を持つ宣言は、理由が読み取れる区分へ置いたままにする。

## カスケード上の注意点

1. 現在の明示的な区分コメントはDiary開始位置だけで、他の責務境界はセレクタ名から推測する必要がある。
2. media queryはDiary内の860px／620px、全体後方の920px／640px、末尾の720pxに分散している。並べ替えるだけでも適用順が変わる。
3. 末尾720px media queryの先頭にInvestment指定があり、Thought責務へ越境している。これは次工程で区分を明示する対象だが、現時点では移動しない。
4. `!important`は9件ある。`[hidden]`やゲーム中の状態制御と、Investment内部の局所指定が混在するため、一括削除しない。
5. `site.js`が生成するマーケット・記事・アプリのクラス、Diary／Learningの動的カード、ゲーム状態クラスは静的HTMLだけでは網羅できない。
6. 共通920px／640px media queryはInvestment、Room、Learning、Game、Appを横断する。この層をページ固有ブロックへ移す場合は、現在の後勝ち関係を一件ずつ確認する。

## 次工程で付ける区分名

次の工程では、宣言値と記述順を変えず、以下の境界コメントだけを`styles.css`へ追加する。

1. Foundation and site shell
2. Shared hero and controls
3. Home sections and topic cards
4. Archives, profile, and article content
5. Subpage hero variants
6. Investment hub
7. Generic rooms
8. Public Diary
9. Learning
10. Game and app catalog
11. Playable games
12. Site footer
13. Shared responsive rules
14. Thought theme and columns
15. Small-screen exceptions

コメント追加後はVisual Regression 20パターン、重要領域14画像、computed style・矩形・要素間距離、`npm run verify:changed`を通す。ここで表示差分が出た場合は、CSS統合へ進まずコメント追加以外の差分を調査する。

## 責務の判断基準

- 全ページで同じ意味を持つものだけをFoundationまたは共通componentへ置く。
- 見た目が似ていても、用途や状態契約が異なるものはページ群の責務に残す。
- Theme tokenは基本テーマとThoughtテーマを分ける。Investment、Game、Learning固有値も意味が共通でない限り基本tokenへ移さない。
- responsive指定は対象componentの構造と後勝ち関係を確認してから移動する。
- overrideが必要になった場合は、既存責務の定義場所で解決できない理由を先に確認する。
- セレクタ詳細度の上昇と`!important`追加を整理の代替にしない。
- 未使用判定は38ページのHTMLだけでなく、上記JavaScript生成クラスも含めて行う。
