# AI Chat By T-ROOM (Android)

`jp.tanaka.troom.ai` のAndroidネイティブアプリです。Web版はありません。

## Phase 1

- Jetpack Compose / Material 3のチャット、会話、履歴、アカウント画面
- Android Credential Managerから既存Security CenterのPasskey認証を利用
- Security handoffでのみAI Worker sessionを開始（ID・パスワードなし）
- D1を正本とする会話と、暗号化された未同期メッセージ1件の端末キャッシュ
- AI Workerが返す利用額、予算、安全停止状態の閲覧
- `VoiceEngine`境界（OpenAI Realtime / 将来のVOICEVOX差し替え用）

音声会話のWebRTC接続、VOICEVOX、Live2D、T-ROOM各サービスのツール連携は次Phaseです。OpenAI APIキーやRealtime client secretをAPKへ保存してはいけません。

## Build

既存の `android-tcloud/keystore.properties` とrelease keystoreを参照します。これらはGit管理外です。

```powershell
cd android-ai-chat
.\gradlew.bat test lint assembleRelease
```

署名情報がない環境ではdebug buildのみ生成できます。新しいkeystoreは作成しません。
