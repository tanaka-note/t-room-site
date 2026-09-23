# 公開サイトCSS整理記録

## 目的

この文書は、`styles.css`のカスケードを調査し、整理候補を実装・検証した記録である。現行の責務と今後の編集ルールは`docs/public-site-css-responsibility-map.md`を正本とする。

## 完了した候補

| 対象 | 元の状態 | 整理内容 | commit |
| --- | --- | --- | --- |
| 640px以下の`.market-card-grid` | 同一media query内で1列指定の後に2列指定が勝っていた | 共通1列化グループから対象だけを外し、Investment固有2列指定を維持 | `aa3a8bc` |
| `.post-card h3` | Home区分のshorthandへArchives区分の`margin-top`が後勝ちしていた | 最終値`margin: 6px 0 8px`をArchives区分の一定義へ統合 | `efeef2d` |
| `.learning-mini-stats dd` | 先行shorthandですでに0の左marginを後方で再指定していた | `dd`を後方指定から外し、`dt`の契約だけを維持 | `f1b93b9` |

Learningの整理前には、動的生成される科目カードをVisual Regressionへ追加した（`8daf9a6`）。既存基準画像は更新していない。

## 追加監査で整理した項目

| 対象 | 判断 | commit |
| --- | --- | --- |
| `.investment-performance-*` | ルート公開サイトのHTML・JavaScriptから参照されず、Worker Diaryは専用CSSを使うため未使用 | `8f6e75c` |
| 基本色とfocus ringのraw値 | 複数責務で既存tokenと同じ意味を持つ箇所だけtokenへ統一 | `3db8529` |

## 意図的に残したもの

- Learning共通surfaceからTopicカードのgradientへ特化するbackground指定
- Learning表の共通セル色から見出しセルを強調する指定
- Thoughtカードの共通borderから指定辺をaccent化する指定
- Thoughtシリーズのラベルと値の色の視覚階層
- 920pxと640pxで責務が異なるInvestmentカードのresponsive指定
- JavaScriptが生成・切替するクラスと状態クラス
- Diary固有860px／620px、共通920px／640px、末尾720pxの現在の適用順
- 状態契約と既存shared selectorとの関係から必要な7件の`!important`

最終CSSOM監査では53個の同一context・同一selectorの分割が残るが、同一propertyの再指定は上記の共通値から固有値への特化、またはshorthandの機械的展開として説明できる。最終表示を不要な後勝ちだけで完成させる候補は残っていない。

## 検証

各CSS変更は対象画面のPC・スマートフォン、computed style、寸法、位置、要素間隔、横スクロールを確認し、全Visual Regressionと`npm run verify:changed`を通した。Visual Regressionは最終的に代表11画面×PC/SPの22パターンで、基準画像を変更に合わせて更新していない。
