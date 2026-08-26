# T-ROOM AI Worker

Android専用AI ChatのAPIです。Web UIは配信しません。

- Security Workerのone-time handoff以外ではsessionを開始しない
- 会話・Memory・usageは認証済みIdentityで分離
- MemoryはIdentity × Character namespace
- 予算policyはSecurity D1、実usageと原子的な料金予約はAI D1
- OpenAI API keyはWorker Secret `OPENAI_API_KEY`のみ
- session署名はWorker Secret `SESSION_SECRET`、安全識別子saltは`AI_SAFETY_SALT`

本番の`AI_PROVIDER_MODE`は`openai`ですが、`OPENAI_API_KEY`が存在しない間は新しいAI処理だけを503で停止し、履歴・アカウント・料金確認は利用可能です。
