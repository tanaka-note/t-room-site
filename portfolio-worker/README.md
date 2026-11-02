# 資産運用報告（編集対応）

新URLは `https://tanaka-note.com/asset-report/`。旧 `asset-report-k7m4q9x2/` は変更しない。トップページ・記事一覧・検索インデックスへ入口を追加しない。HTMLとHTTPヘッダーの両方でnoindexとする。

## データと計算

初期データは `seed/report.mjs`。2026-10-31までの11銘柄・75日分を既存の正本から複製した。基準元本、売却益の別表示、日付別の累計売却損控除、4分類への控除配分、コメントを維持する。基準元本は管理者が編集でき、全期間共通の成績計算基準として過去を含む損益・損益率へ反映する。1円以上・1兆円以下の整数円とし、変更時は影響範囲を確認して保存する。調整値は通常編集の対象外。個別銘柄の損益金額・損益率は非表示、全体成績と構成比は維持する。

`portfolio_state` は報告設定とrevision、`portfolio_records` は日付ごとの合計額と任意の銘柄内訳、`portfolio_changes` は訂正前後・保存IDを保持する。全銘柄を一括保存し、同日なら訂正、別日なら追加する。更新日と任意の時刻は日本時間の入力値、実際の保存時刻は別のUTC時刻として記録する。過去日の保存は後日のデータを変更しない。

移行元に銘柄別の過去内訳はないため、過去履歴へ架空の内訳を作らない。その日を選ぶと全体成績を表示し、合計額だけを訂正できる。新規の日付は入力中の銘柄をテンプレートとして引き継ぐことを明示し、全銘柄の名前・分類・評価額を保存する。銘柄の追加・削除・名前変更は安定したIDで管理する。

保存APIは期待revisionによる原子的な競合判定、保存IDによる再送検出、日付・整数円・分類・控除後の非負検証、同一Origin/JSON検証を行う。履歴と現在値・revisionは単一SQLスナップショットで読み取る。元本は同じrevision・保存IDのトランザクションで記録と同時に保存し、明示指定時は訂正履歴のprevious_record／saved_recordに変更前後のbasePrincipalも保持する。既存クライアントの元本未指定時は現在値を維持する。保存後はDBを再読込し、合計・ドーナツ・推移チャートを描き直す。バックアップのJSON書き出しには設定、全日付、訂正履歴を含め、認証情報は含めない。

共通D1定期バックアップへの追加は[バックアップ運用](../backup-worker/README.md)を参照。対応版のBackup Workerと専用D1 bindingの反映後は、他サービスと同じ毎日03:40 JSTの呼び出しで、設定・全日付の記録・訂正履歴・アカウント状態を既存の非公開R2へ日次30・月次12世代で保存する。独立したCronは設けず、旧静的ページへ変更を戻す方式には依存しない。JSON書き出しとは別の経路で、PRのみの段階では本番の自動保存開始を意味しない。

## 認証

既存Security Centerに `portfolio` を追加し、既存のパスキー、60秒・一回限りhandoff、サービス専用Secret、12時間rolling session、credential・Identity・linkの都度確認と監査を使用する。独自の認証方式は追加しない。ログインボタンは家計簿・請求書管理と同じ緑色、鍵アイコン、フォーカス表示とし、確認中の連打を防ぐ。複数アカウント選択・キャンセル・Escには共通パスキークライアントを使用する。

アカウントは `owner`（管理者、第一管理者Identity専用）と `viewer`（閲覧のみ）。閲覧用は明示的に複数Identityへ連携でき、同じIdentityの複数パスキーも利用できる。登録・承認・権限付与はユーザーがSecurity Centerで行う。初期化やmigrationからパスキー・Identity・サービス連携を自動作成しない。APIも閲覧者の更新を403で拒否する。

財務データは認証後のAPIだけから配信し、公開assetへ初期データを含めない。APIはno-store、Service Workerによるオフライン保存は追加しない。ログアウト・権限失効ではチャート、表、入力、保留通信を消去する。画面は現在のセッションに紐づけ、他タブのアカウント変更で止める。Web自動更新は未保存入力・保存中・インストール操作中に延期する。

## 初回公開

`portfolio-db` と `t-room-portfolio` は専用リソース。新規Workerの作成・route・D1初期化は既存production tokenの権限と別の、クラウドのインフラ用認証を使う。既存の限定production tokenの権限は変更しない。Portfolioはverify対象へ登録し、初回・以後の公開は、対象CI成功済みの最新mainから専用公開手順で行う。通常のActions自動公開への追加は、このWorkerへの限定権限を別途設定した後に行う。

1. 新規D1に `0001_portfolio.sql` を適用し、`tools/seed.mjs` のパラメーター付き文を実行する。既存日付は上書きしない。初回にrevision=0、全75日、日別金額、最新11銘柄と報告設定を移行元と照合する。
2. Security `0030_portfolio_service.sql` を適用する。全既存行・FK・索引・トリガーを保持することを合成データで検証済み。共通バックアップのSecurity schema許可リストも対応版へ更新する。新規PortfolioのRPC入口を先に準備し、対応するSecurity/Diary/Backupを公開する。
3. Portfolio専用の32byte以上の暗号学的乱数から `SESSION_SECRET` を新規設定する。既存Secretは読み戻さず共有・変更しない。値をGit・ログ・チャットへ出力しない。
4. CIが成功した最新mainのclean checkoutで、Portfolio対象のverify/buildとbuild freshnessを確認して新Workerを公開する。routeは `/asset-report` と `/asset-report/*` だけに限定する。
5. HTMLのcontent build、公開中version、未認証APIの401、noindexを読み戻す。Security Centerの候補は管理者・閲覧者の2件であることを確認する。実利用者への権限付与は行わない。

切り戻しは新URLのrouteまたは新Workerを停止し、旧サイトを継続利用する。新規D1・記録・訂正履歴を削除しない。Securityの既存利用者を解除せず、既存サービスを維持する。

## 検証

```sh
npm --prefix portfolio-worker run check
npm --prefix portfolio-worker test
node portfolio-worker/test/portfolio.browser.mjs
node --test security-worker/test/portfolio-migration.test.js
node tools/verify.mjs --target portfolio --browser --build
```

ブラウザ試験は合成データ、PC/390px/320px、過去日追加・同日訂正・時刻保存・チャートの再描画・閲覧専用・失効時消去を確認する。実端末のWebAuthn本人確認と区別する。
