# 支払明細

公開先は `https://tanaka-note.com/payments/`、Workerは `t-room-payments`、D1は `payments-db`。

支払日・支払先・摘要・支払総額（日本円の整数）・対象開始月・対象月数・備考を登録する。対象月は開始月を含み、月単価は総額÷月数を小数第2位まで表示する参考額。端数を実際の引落額へ配賦する機能ではない。残り月数は今月を含み、期間前は全月数、終了後は0。編集・削除にはバージョンを照合し、競合は409。削除は一覧から除外する論理削除。リクエストIDで同じ操作の再送を受け付ける。

アカウントは `owner` の1件。Security Centerの `primary-admin` Identityに後から連携し、登録・承認済みパスキーでログインする。自動連携・新しいIdentity作成・パスワード認証は行わない。既存の60秒・一回限りのhandoff、独立Secret、共通rolling session・失効照会・監査を使う。

`npm run check`、`npm test`、`node ../tools/verify.mjs --target payments --browser --build`で対象検証。ブラウザfixtureは合成データのみを使う。

初回公開はD1を作成してwranglerのIDを設定し、paymentsのmigrationを適用する。初回のpayments公開後に `tools/bootstrap.mjs --remote`へ標準入力JSONの`displayName`を渡すと、未設定の場合だけ安全なSESSION_SECRETとownerを作成する。値は出力しない。SESSION_SECRET未設定の間はAPIが503で停止する。paymentsを先に公開し、検証済みのSecurity migration `0025_payments_service.sql`を適用後、Securityを公開する。このmigrationは既存連携・鍵envelope・health grant・handoff・session・監査・集計を保持してservice制約を拡張する。通常公開はリポジトリの `npm run release -- payments` を使う。

HTMLと個人データはno-store。共通updaterを利用し、未保存入力・認証・保存・削除中は更新を延期する。編集と確認画面は既存の共通dialog-navigationを同梱し、戻る・Esc・背景・閉じるを統一する。
