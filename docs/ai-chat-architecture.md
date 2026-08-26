# AI Chat By T-ROOM アーキテクチャ

## 境界

- Security Center: Identity、Passkey、AI service link、月額予算、安全停止、予備枠、管理監査の正本。
- AI Worker / AI D1: 会話、メッセージ、character別Memory、実利用量、処理中の料金予約の正本。
- Android: UI、Credential Manager、暗号化されたsessionと未同期送信の一時保存。Identity、料金、権限を決定しない。
- 将来のDiary / Billing / Cloud連携: AI Workerから各Workerの限定RPCを呼ぶ。各D1/R2をAI Workerへ直接束ねない。

## 認証

Android Credential Manager → Security `auth/options` → WebAuthn UV → `auth/verify` → 検証済みAI service linkのone-time handoff → AI session、の順です。AI sessionは毎リクエストSecurityのsession epoch、credential、service linkを再検証します。独自PW・復旧コードは持ちません。

## 分離と冪等性

すべての会話・message・Memoryは認証済み`identity_id`で絞り込みます。Memoryは`identity_id × character_id` namespaceです。Androidの`clientRequestId`をAI D1で一意にclaimし、通信再試行による二重課金・二重回答を防ぎます。

## 料金

Security policy（初期値3,000円、通常停止2,700円、予備枠後2,850円）を各AI処理前に取得し、AI D1で保守的な最大料金を原子的に予約します。完了時に実token料金へ置換し、失敗時に予約を解放します。JSTの年月でperiodを切り替え、過去usage eventは保持します。Androidから予算値を受け取りません。

## 音声とキャラクター

chat/voiceは同一conversationの`current_mode`とmessage `source_mode`で共存します。`VoiceEngine`をOpenAI Realtimeと将来のVOICEVOXで差し替えます。人格、声、Live2D参照はcharacter recordへ分離し、コード内の単一人格へ固定しません。
