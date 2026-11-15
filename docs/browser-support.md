# LINE内ブラウザのサポート制限

LINE WebViewでのパスキー・Web機能の互換性問題を避けるため、LINE内では画面とHTTP APIの利用を止める。UAはサポート環境の判定であり、認証境界ではない。通常ブラウザのWebAuthn、セッション、権限、Password停止ポリシーには手を加えない。

## 共通入口と更新

- 正本は `assets/line-browser-policy.mjs`。`Line/数字` の独立したUAトークンだけを判定し、一般的なWebViewやブラウザ名で許可を限定しない。
- サイト、Diary、Billing、Cloud、Security、Downloader、AIのHTTP fetch入口で、認証・DB・Container・アセット処理より前に `lineBrowserResponse` を呼ぶ。内部Service Bindingの認証メソッドやQueue/Cronは対象外。
- LINEの画面は403の専用HTML、API・アセットは403のJSON。`no-store`、`Vary: User-Agent`、専用ヘッダーを付け、Cookieは発行・削除しない。Asset Linksの検証URLはそのまま配信する。
- HTMLの最初のスクリプトは同じ正本から生成する。キャッシュされたHTMLでもパーサー・リソース読み込みを止め、本体DOMを案内画面へ置き換える。閉じる操作や自動リダイレクトは設けない。
- 現在standalone/fullscreen/minimal-uiまたはiOS standaloneで動作している場合、クライアント側案内は出さない。インストール有無や`source=twa`は免除条件にしない。実際のPWA/TWAは通常ブラウザのUAを使う。LINE UAを偽装したHTTPアクセスにはサーバー側制限が適用される。
- 通常表示では外部通信・インストール照会・認証API照会を追加しない。SecurityのCSPは生成スクリプトと案内CSSの正確なSHA-256だけを許可する。
- `web-apps:sync`で正本、CSPハッシュ、全アプリのbuild/cacheを同期する。静的公開準備は新規HTMLにも自動適用する。既存Worker内の新規URLは共通入口で制限される。新Workerは同じ入口を使用し、必要な場合は`web-apps.json`へ登録する。
- 小型WebアプリのSWはエラー・案内・no-store応答を保存しない。既存の通常オフラインキャッシュは維持する。配信前の旧版を完全オフラインで保持している端末へ、後からコードを届けることはできないため、更新には一度オンライン接続が必要。

## 外部ブラウザ・アプリ

「既定のブラウザで開く」は現在の `https://tanaka-note.com` URLへ`openExternalBrowser=1`を設定する。パス・他のクエリ・フラグメントを保持し、重複フラグと`openInAppBrowser`を取り除く。クエリで外部遷移先やAndroid packageを指定する仕組みは持たない。

Androidのアプリボタンは、既存のHTTPS App Linksに対応する次の範囲だけに表示する。

| URL | インストール済みアプリの宛先 |
|---|---|
| `/diary/…` | `jp.tanaka.troom.diary.twa`（日記TWA） |
| `/cloud/…` | `jp.tanaka.tcloud.twa`（T-Cloud TWA） |

ユーザーのタップで、現在のHTTPS URLをdataに持つAndroid Intentを固定packageへ渡す。既存ManifestのBROWSABLE/autoVerifyと公開済みDigital Asset Linksを利用し、新規アプリ・独自アプリスキーム・署名変更は導入しない。対応アプリがない場合の`browser_fallback_url`は同じURLの外部ブラウザ用リンク。Intentを受け付けないLINE/OSでは、別の「既定のブラウザ」ボタンまたはLINEメニューを使う。Chromeのpackage固定、無操作タイマー、起動ループはない。

単一の全サイト用T-lain TWAは現在存在しない。その他のURLとiPhoneは通常ブラウザへ案内し、iOSホーム画面PWAの強制起動はしない。ホーム画面アプリはユーザーがホーム画面から起動できる。

## 検証

`pnpm run browser-policy:test`、`pnpm run browser-policy:test:browser`、`pnpm run web-apps:test`を実行する。ブラウザテストは既存DiaryのPlaywrightを使い、必要なら`PLAYWRIGHT_PACKAGE`で既存インストールを指定できる。Chromium/Firefox/WebKitで通常UA、LINE UA、standalone、キャッシュHTML、CSP、初期化停止、戻る操作、リンク、画面幅を検証する。本人のパスキー操作と実機LINE→Androidアプリ起動は、UA再現テストとは別に扱う。

仕様参照：[LINE外部ブラウザ](https://developers.line.biz/ja/docs/messaging-api/using-line-url-scheme/#opening-url-in-external-browser)、[Android App Links](https://developer.android.com/training/app-links/about)、[Intentとブラウザfallback](https://developer.chrome.com/docs/android/intents)。

## サイト内のホーム追加ボタン

資産報告はログアウトの横、電卓は設定内、請求書管理はPDF保存ボタンの位置に「ホームへ追加」を置く。
請求書管理のPDF保存ボタンは非表示とし、印刷処理と印刷用レイアウトは維持する。
正本は `tools/shared/pwa-install.js`。`web-apps.json` の `assetCopies` で各アプリへ配信し、
headで読み込んで `beforeinstallprompt` を早期に保持する。タップ時にブラウザの
`prompt()` を直接呼び、確認中の連打とWeb自動更新を防ぐ。

通知が届いていないときにインストール済みとは断定せず、状態を案内する。
Androidを同じブラウザメニューへ誘導し直す処理や、削除・データ消去の案内はしない。
iOSはSafariの共有からの追加を案内する。受け付けと完了を区別し、`appinstalled` で
完了表示にする。standalone・fullscreen・minimal-ui起動では追加ボタンを隠す。
アプリ識別子・起動URL・scopeはこのボタン対応では変更しない。

単体試験とブラウザfixtureは通知の未到着、受け付け、キャンセル、失敗、再通知、
表示位置、更新保護を検証する。Android実機のインストール結果は別に確認する。
