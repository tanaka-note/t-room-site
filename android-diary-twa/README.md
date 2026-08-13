# 日記 TWA

`https://tanaka-note.com/diary/` をAndroidのTrusted Web Activityとして開く専用プロジェクトです。
日記のWeb版・アカウント・D1・R2・保存済みデータを変更せず、そのまま利用します。

## アプリ情報

- 表示名: `日記`
- applicationId: `jp.tanaka.troom.diary.twa`
- 開始URL: `https://tanaka-note.com/diary/?source=twa`
- 対応Android: Android 8.0（API 26）以降
- TWAライブラリ: Android Browser Helper 2.7.2
- 現在のバージョン: 1.0.1

## ビルド

T-Cloudと同じ安全な署名鍵設定を `../android-tcloud/keystore.properties` から参照します。署名鍵・パスワードはGitへ保存しません。

```powershell
./gradlew.bat clean assembleRelease
```

APKは `%LOCALAPPDATA%/TRoomDiaryTwaBuild/app/outputs/apk/release/` に作成されます。

APK署名・アプリID・Digital Asset Linksをまとめて検証する場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/verify-release.ps1
```

Web UI・JavaScript・CSSの更新はサイト公開後にTWAへ直接反映されます。Android側の設定やアイコンを変える場合だけAPK更新が必要です。
