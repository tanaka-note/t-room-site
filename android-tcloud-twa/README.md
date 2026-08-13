# T-Cloud TWA

`https://tanaka-note.com/cloud/` をAndroidのTrusted Web Activityとして開く専用プロジェクトです。
既存のネイティブ版 `android-tcloud` とは別アプリIDで共存し、Web版・R2・D1・Worker・暗号方式・保存済みファイルを変更しません。

## アプリ情報

- 表示名: `T-Cloud`
- applicationId: `jp.tanaka.tcloud.twa`
- 開始URL: `https://tanaka-note.com/cloud/?source=twa`
- 対応Android: Android 8.0（API 26）以降
- TWAライブラリ: Android Browser Helper 2.7.2

## ビルド

既存の安全な署名鍵設定を `../android-tcloud/keystore.properties` から参照します。署名鍵・パスワードはGitへ保存しません。

```powershell
./gradlew.bat clean assembleRelease
```

APKは `%LOCALAPPDATA%/TCloudTwaBuild/app/outputs/apk/release/` に作成されます。

APK署名・アプリID・Digital Asset Linksをまとめて検証する場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/verify-release.ps1
```

## Webとの検証

TWAのアドレスバーを消すため、サイト直下の `/.well-known/assetlinks.json` とAPKの署名証明書を一致させます。Web UI・JavaScript・CSSの更新はサイト公開後にTWAへ直接反映され、Android側の設定やアイコンを変える場合だけAPKの更新が必要です。
