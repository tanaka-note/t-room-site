# 個別ID・パスワード認証の停止・緊急復旧

通常は指定利用者のPasskeyを使用する。管理者がCodexへサービスとアカウントを明示して依頼した場合だけ、以下のスクリプトで個別に停止・復旧する。操作UIは設けない。

許可対象は `diary/chiharu-admin`（田中千晴）、`diary/wife-admin`（田中暢美）、`billing/chiharu`（田中千晴）、`billing/masami`（田中暢美）の4組だけ。スクリプトは完全一致のallowlistでCloud・第一管理者・その他アカウントを拒否する。対象拡張は別途レビューが必要。

## 仕組み

- 各サービスのD1に `password_auth_policy` を置く。行なしはPassword有効・epoch 0。Diary固定アカウントも同じテーブルで管理する。
- Passwordの新規ログインと署名済みcookie検証にだけ適用する。Passkey、アカウント本体の有効状態、既存session version、role、household、鍵・認証情報は変更しない。
- 停止・復旧の各状態変更で `password_session_epoch` を増加させる。古いcookieのepoch省略は0として扱う。rolling更新や画面切替は検証済みの世代を引き継ぎ、最新世代へ昇格させない。
- キャッシュを挟まずPasswordリクエストごとにD1を確認する。停止後の次の検証から無効になる。既に実行中のリクエストや端末に表示済みのデータを撤回する機能ではない。
- スキーマが未適用・D1障害の場合、Passwordは安全側に失敗する。先に空のschema migrationを適用し、その後Workerをdeployしてから個別停止する。
- ポリシー削除・世代番号巻き戻しは禁止。DB triggerでも防止する。復旧は必ずenableで行い、ポリシーのない状態へ戻さない。

## 操作

最新mainと本番の配信buildを確認する。rootで `pnpm install --frozen-lockfile` を実行し、Wranglerの正しいアカウントへ認証した状態で使用する。

```sh
node tools/password-auth.mjs inspect diary chiharu-admin --remote
```

現在の氏名、有効状態、Password状態・epoch、Passkey連携を確認する。復旧例（epochはinspectの実値に置き換える）：

```sh
node tools/password-auth.mjs enable diary chiharu-admin --remote --apply --expect-name "田中千晴" --expect-epoch 1 --reason "管理者指示による端末紛失時の一時復旧"
node tools/password-auth.mjs inspect diary chiharu-admin --remote
```

再停止例：

```sh
node tools/password-auth.mjs disable diary chiharu-admin --remote --apply --expect-name "田中千晴" --expect-epoch 2 --reason "管理者指示によるPasskey復旧後の再停止"
```

他の指定アカウントもサービス・account_id・氏名を完全一致で指定する。氏名不一致、無効アカウント、世代競合、停止時の有効Passkey連携不足は中止する。緊急復旧のenableはPasskeyが失われていても実行できる。書込結果が不明な場合は自動再試行せずinspectする。理由にPassword・hash・Salt・Secret等を書かない。

変更は1件の主キーと期待epochに限定し、後からSELECTで照合する。`password_auth_policy_audit`に停止／復旧、無効化されたセッション世代、操作者、理由を同一transactionのtriggerで記録する。停止済みアカウントへのログイン試行は既存 `password_login_failure` の `details.reason = password_auth_disabled` で監査する。個々のcookieや認証情報はログへ保存しない。失効したセッションを使った全リクエストごとの監査追加は行わない。

## 公開・検証

新規migrationはDiary `0019_password_auth_policy.sql`、Billing `0008_password_auth_policy.sql`。どちらも空のテーブル・trigger追加のみで、既存アカウントや履歴を更新しない。初期停止は本番レコードを確認した上で上記4組へ1件ずつdisableする。

`pnpm run password-auth:test` はローカルSQLite・実際のWorker handlerを使い、4組の停止／復旧、旧cookie失効、rolling、Passkey handoff、他アカウント非影響、migrationの安全性を検証する。本番の本人端末でのWebAuthn操作は別の手動確認であり、このテストの成功で代用しない。
