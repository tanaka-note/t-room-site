# カレンダー Android

個人配布用のネイティブAndroidアプリ。Android 14以上、compile/target SDK 36、Kotlin・Jetpack Compose。packageは`jp.tanaka.troom.calendar`。Google Playへの公開は今回行わない。

## 画面

月間カレンダーを中心にした48dpの上部バーと右下の追加ボタン。画面上のアプリ名の大きな見出しと下部タブは設けない。左上メニューから月間・週間・予定一覧・追跡・設定へ移動する。表示中の予定をタイトル・追跡・タグ等で絞り込める。

追跡は任意で複数選択でき、予定名とは別のIDで管理する。終了した予定だけを経過日数・年間回数・履歴・間隔へ集計する。通常追加では追跡OFF、追跡からの追加ではその追跡を選択済みにする。タグ・配色・繰り返し・例外・ゴミ箱・アーカイブ・統合を備える。写真投稿・外部カレンダー連携・ウィジェットは含めない。

## 認証と保存

初回に「パスキーでログイン」と「ログインせずこの端末で使う」を選択できる。ローカル利用はログイン期限なしで、予定・追跡・タグ・設定・通知を端末内で利用する。ローカル操作・定期更新・通知処理から認証APIやCalendar APIへ通信しない。サーバーバックアップ・端末間同期は行わない。

ローカルの主データは`local-cache`、プロフィールは`local-profile`、サーバーからの取得済みデータは`cache`へ分離し、どちらもKeystoreで暗号化する。選択方法を`mode`に保持して次回起動時に再開する。「利用方法を選び直す」ではローカルのデータを保持し、その通知を停止する。ログインしてもローカルの予定を自動送信・統合しない。容量上限は両保存領域の合計に適用し、ローカルの主データをキャッシュとして自動削除しない。

ローカルの通知は認証情報を必要とせず、保護した予定ルールから予約を再構成する。端末が圏外でも定期処理とアラームで予約範囲を更新する。通知データにはタイトル・日時・繰り返しなど必要な項目だけを含め、メモ・場所・URLをコピーしない。利用方法の切り替えと通知処理は共通の排他制御で同期する。

Credential Managerで既存のパスキーを使用し、Security Centerで明示的に許可されたカレンダーのアカウントだけを表示する。複数権限の場合は選択する。アカウントを選び直す際は現在のサービスsessionを終了し、その端末の通知とキャッシュを消す。未同期データは同期または明示的な破棄が必要。他の端末のsessionは終了しない。

前面での実操作に伴う正常な保護APIで30日へ延長する。バックグラウンド同期・定期polling・session照会・通知・オフライン操作では延長しない。最後の確認から最大30日、かつ署名されたsessionの期限内で取得済みデータをオフライン閲覧・編集できる。

キャッシュ・未送信変更はAndroid KeystoreのAES-GCMで保護し、Identityとアカウントを照合する。初期上限100MiB、設定で50/100/200/500MiBを選択できる。全期間のテキストを上限内で保存し、上限を超える保存は失敗を表示して既存データを維持する。履歴を黙って間引いて追跡集計を不正確にしない。未送信変更を自動削除しない。

通知snapshotと認証は閲覧データの予算から独立させる。通常保存には64MiB以上の空き領域を要求し、対応するファイルシステムでは16MiBを重要更新用に事前確保する。領域不足時はこの枠を通知・認証の更新へ解放する。原子的な書込みで既存の正常データを保護する。通知許可・正確なアラームの許可が必要。予約失敗を保存成功と混同せず、設定画面とエラー表示から再確認できる。

## ビルド

JDK 17以上とAndroid SDK 36を使用する。`local.properties`に`sdk.dir`を設定する。署名情報はGit管理外の既存`android-tcloud/keystore.properties`または環境変数`TROOM_SIGNING_PROPERTIES`で指定する。秘密情報をコマンド出力へ表示しない。Windowsでは`LOCALAPPDATA/CalendarByTLainBuild`にビルド出力を置く。

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleRelease --no-daemon
```

配布前に`apksigner verify --print-certs`で署名を確認する。署名鍵をAPK・Git・GitHubへ添付しない。同じpackage・同じ署名鍵と増加したversionCodeで更新し、将来のGoogle Play登録を妨げない構成を維持する。ソース・テストは既存GitHubリポジトリで管理する。

内閣府の[国民の祝日CSV](https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv)を2026-10-29に取得した。公表済みの2027年までを収録する。更新は`node tools/update-calendar-holidays.mjs`で公表済みデータを取得し、差分を確認してAPKへ取り込む。未公表の春分・秋分などを推測して追加しない。

## 検証の区分

配布APKは最適化が有効なrelease版そのものを、専用のAndroid 16エミュレーターで起動確認する。debugビルド・JVM単体試験では、Roomが反射で生成するWorkManager内部DBのコンストラクター欠落を検出できない。`proguard-rules.pro`でこの生成処理を保持する。初回画面と、ローカル選択後の再起動を各3回確認する。

```powershell
# 専用エミュレーターの起動完了後、android-calendar/で実行
node tools/smoke-release.mjs --adb <adb.exe> --serial emulator-5556 --apk <release.apk> --screen welcome
# ローカル利用を選択した後
node tools/smoke-release.mjs --adb <adb.exe> --serial emulator-5556 --apk <release.apk> --screen local
```

単体試験とlint・releaseビルドはローカルで実行する。実機が接続されていない状態では、パスキー画面・通知の実発火・再起動・メーカーの省電力動作・容量逼迫時の動作を「実機確認済み」と扱わない。API・DB初期設定とリリース手順は[`calendar-worker/README.md`](../calendar-worker/README.md)を参照する。
