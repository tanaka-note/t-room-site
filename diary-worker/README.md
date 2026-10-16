# 日記 Worker

`/diary/` のWeb、API、PWAを配信する。認証・鍵・公開手順の正本はリポジトリの `docs/security/passkeys.md`、`docs/browser-support.md`、`docs/development-flow.md` を参照する。

## 起動

HTMLは共通Updater、Passkeyクライアント、軽量な `diary-bootstrap.js` を読み込む。`/api/session` で現在の認証と権限を確認し、未ログインなら本体を取得せずログイン画面を表示する。Passkey成功またはsession再開後に、本体・日付選択・モーダル処理を読み込む。

本体は信頼できるsessionの権限を適用し、前のデータを消してからヘッダー・検索・一覧のローディングを表示する。検索・本文表示・天気のモジュール準備と初期データ取得を並行する。操作の受付は必要なモジュールとイベント設定の準備後に開始する。写真処理／アップロードは最初の写真選択まで読み込まない。本文のrich text処理は一覧・詳細の表示にも必要なため、本体とともに準備する。アルバムは開いた時点で従来の写真APIを呼ぶ。

`GET /diary/api/bootstrap` は、検証した同じsessionを使って `session`、`households`、`meta`、`entries` を返す。`entries` の検索・日付・月・タグ・お気に入り・下書き・ゴミ箱・ページングは既存 `/entries` と同じ処理／権限判定を使い、写真本体や詳細写真一覧は含めない。既存APIは維持する。初回は `/session` と `/bootstrap` の2往復を使い、データ取得前に安全な画面枠を表示できるようにする。再開の監査は従来の `/session` で記録する。

bootstrapもrequestごとに現在のSecurity状態を検証し、同じGET requestの内部だけで検証結果を再利用する。foregroundのbootstrapは置き換え元の一覧GETと同じRolling Session更新条件を維持する。バックグラウンド・エラー・session確認だけでは延長しない。遅い応答は検索のrequest IDとsession／householdの世代で区別し、ログアウト後や切替後に前のデータを再表示しない。

## キャッシュと更新

Service Workerは登録された正確なbuild付きの公開JS／CSS／アイコンURLだけをcache-firstにする。install時の先読みはログイン入口に必要な資産だけとし、本体や写真モジュールは利用後に保存する。API・HTML・写真・投資資産・manifestはこのキャッシュを経由しない。エラー、redirect、private、no-store応答は保存しない。

Diary Workerの公開静的資産で `v=diary-` と12桁hexのbuild IDがあるJS／CSS／PNGは `public, max-age=31536000, immutable`。HTMLは `no-store`、SW本体は `no-cache`、manifestと未version資産は従来の1時間。投資資産とR2写真の認可・配信方針は別に維持する。build同期は `node tools/sync-web-app-builds.mjs --target t-room-diary` を使う。共通Updaterと未保存入力・処理中の更新延期も維持する。

## 起動の検証

`pnpm run test:startup` は起動契約、実SQL／Security連携のbootstrap、静的キャッシュ、cold／warm／Passkey模擬／再開／standaloneのローカルブラウザfixtureを実行する。恒久的な性能計測や個人追跡は追加しない。模擬試験は実端末のWebAuthn・PWAの性能を代替しない。[初回比較と制約](../docs/history/diary-startup-performance-20261016.md)を参照。
