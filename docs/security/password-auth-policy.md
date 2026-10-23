# Password認証の恒久廃止とパスキー復旧

## 日記・請求書のPasskey専用化

日記と請求書管理は、将来追加されるアカウントも含め全利用者をPasskey専用とする。`assets/password-auth-policy.mjs`はサービス単位でPassword認証を恒久拒否し、個別IDのallowlistやDBポリシーの有無・有効値に依存しない。Password cookieと認証方式が記録されていない旧cookieは拒否し、rolling更新で復活させない。`PASSKEY_ENABLED=false`でもPasswordへ戻さず停止する。

請求書の`POST /billing/api/login`は従来の同一Origin・JSON要求を維持し、正規要求にはbodyの資格情報を解析・照合せず401を返す。アカウント照会、ハッシュ更新、試行カウンタ更新は行わない。旧画面からの拒否試行は`password_login_failure` / `password_auth_disabled`としてSecurity Centerへ同期記録し、障害時は同じevent IDでQueueへ補完する。入力IDから本人を推測せず、Passwordや入力本文を監査へ保存しない。旧キャッシュ向けの安全な監査メタデータ受付・配信helperは維持する。

両サービスのログイン画面は「パスキーでログイン」だけとし、ID・Password入力、保存・記憶、PasswordCredential保存、Passwordログイン送信を廃止する。準備・復旧はSecurity Centerの既存招待・管理者承認へ案内する。請求書のIdentity・WebAuthn・一回限りのhandoff・サービスCookie・12時間rolling・失効判定・管理者と一般利用者の権限分離は維持する。有効な既存パスキーの再登録は不要。

日記の`POST /diary/api/login`は入力を検証せず401、初回Password設定APIは410を返す。初回設定フラグが残っていてもPasskeyで業務APIを利用できる。

アカウント、ID、権限、請求書・支払通知書・精算・残高・履歴、Identity、credential、サービス連携、Password hash・Salt・関連カラム、既存ポリシー行・監査ログは変更・削除しない。今回の専用化にはDB migration・Secret更新は不要。Security Centerの第一管理者本人確認とパスキー紛失時の復旧経路、T-Cloud暗号化・鍵処理は維持する。

## T-CloudのPasskey専用ログイン

T-Cloud Web／PWA／TWAの通常入口は「パスキーでログイン」だけとする。管理者・副管理者のID/PW入力、保存、ログイン送信を廃止する。`POST /cloud/api/login`は入力された資格情報を照合せず401を返し、`password_login_failure` / `password_auth_disabled`を既存のSecurity監査へ送る。試行カウンタ・アカウント・過去の監査は変更しない。旧画面の安全な失敗監査メタデータ受付は維持する。

既存のPW cookieと認証方式を省略した旧cookieは、Cloudの保護APIで次の検証から拒否する。PasskeyのSESSION_VERSION・epoch・credential・Identity・連携・role・root scope・rolling期限・暗号鍵は変更しない。PASSKEY_ENABLED停止時にもPWログインへ戻さない。

Security Centerの初期登録・復旧は、Cloudの公開ログインではなく`SecurityIntegration.verifyPrimaryAdmin`による内部本人確認を継続する。管理者ID、認証用Secret、互換用credential salt、`getPrimaryAdminCryptoConfig`、PWで包んだ管理者秘密鍵・緊急復旧鍵は保存し、暗号処理とSecurity Workerは変更しない。副管理者の過去データ・role定義も削除しない。DB migration・Secret更新・パスキー再登録・ファイル再暗号化は不要。

PRF非対応端末は対応環境へ案内する。管理者の鍵準備・パスキー復旧はSecurity Centerを使用する。ID/PWだけに対応した旧Androidネイティブクライアントは新規ログインできないため、Web／PWA／TWAのパスキー入口を使用する。反映にはCloud Workerの公開が必要であり、GitHub pushだけでは本番は変わらない。

## 旧個別停止・復旧ツール

`tools/password-auth.mjs`の歴史的なinspect対象は`billing/chiharu`、`billing/masami`、`billing/hideaki`のまま保持する。このリストは認証可否の判定には使用しない。`inspect`は実効値`passwordAuthEnabled: false`と、DB上の過去の値`storedPasswordAuthEnabled`を区別する。

```sh
node tools/password-auth.mjs inspect billing chiharu --remote
```

日記・請求書のPassword認証は恒久廃止済みのため、同ツールの`enable`・`disable`およびSQL生成はDB照会・書き込みの前に拒否する。古いスクリプト等がDBの有効値を変更してもWorkerのサービス単位の拒否が優先し、認証は復活しない。端末紛失時もSecurity Centerで既存の本人確認・招待・管理者承認を行い、Passwordログインへ戻さない。

## 検証と公開条件

`npm run password-auth:test`はローカルSQLiteと本物のWorker handlerを使い、既存6名（owner・chiharu・hideaki・masami・yuuka・machiko）と将来アカウントの拒否、旧cookie拒否、DB値からの復活防止、handoff・session復帰・権限・失効・既存データ維持を確認する。rollingの12時間継続とcredential・Identity・link失効は`tools/test-passkey-rolling.mjs`の合成データで確認する。実端末WebAuthnの成功を代替するものではない。

本番公開前には6名全員について、active Identity、有効かつ承認済みのcredential、正しい請求書accountへのactiveサービス連携、既存roleを確認する。未登録者には既存の招待・パスキー登録・管理者承認を完了し、本人の実端末でログイン・ログアウト・再ログインを確認する。欠けている利用者がいる場合は公開を保留する。

今回のPR作成時点では、読み取り専用Cloudflare連携が利用不可を返したため、6名の本番登録状況と実端末ログインは未確認。マージ・本番公開・本番DB変更は行わない。GitHubへのpushだけでは本番の認証方式は変わらない。
