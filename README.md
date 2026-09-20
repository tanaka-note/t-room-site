# T-lain

T-lainは、公開サイト、日記、T-Cloud Storage、請求書管理、Security Center、Downloader、AI Chatなどをまとめた個人向けプラットフォームです。Web、PWA、TWA、Androidネイティブアプリを同じリポジトリで管理します。

## 主要サービス

- 公開サイトと小規模Webアプリ
- T-Cloud Storage（Web／TWA／Android）
- 日記（Web／PWA／TWA）
- 請求書管理
- T-lain Security Center（共通Identity／Passkey）
- T-lain Downloader（非公開）
- AI Chat By T-lain（Android＋API）

## 主要ディレクトリ

- `site-worker/`、ルートのHTML、`apps/`：公開サイトとWebアプリ
- `cloud-worker/`、`android-tcloud/`、`android-tcloud-twa/`：T-Cloud
- `diary-worker/`、`android-diary-twa/`：日記
- `billing-worker/`：請求書管理
- `security-worker/`：Identity、Passkey、Security Center
- `downloader-worker/`：Downloader
- `ai-worker/`、`android-ai-chat/`：AI Chat
- `assets/`：サービス間で共有する処理
- `tools/`：検証、build、release用ツール
- `docs/`：設計、運用、履歴

## 開発ドキュメント

- 開発・検証・公開: [docs/development-flow.md](docs/development-flow.md)
- Identity／Passkey／T-Cloud鍵: [docs/security/passkeys.md](docs/security/passkeys.md)
- LINE内ブラウザ、PWA、TWA: [docs/browser-support.md](docs/browser-support.md)
- AI Chat: [docs/ai-chat-architecture.md](docs/ai-chat-architecture.md)
- Downloader: [downloader-worker/README.md](downloader-worker/README.md)

リポジトリ全体の作業ルールと文書ルーティングは[AGENTS.md](AGENTS.md)を参照してください。
