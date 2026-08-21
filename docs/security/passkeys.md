# T-ROOM 共通Identity・パスキー仕様

## 境界

Security Centerは「誰か」を表すIdentity、パスキー、招待、承認、サービス連携、共通監査を管理する。日記、T-Cloud、請求書管理のアカウントとroleは統合せず、認可の正本は常に各サービスとする。共通認証成功後は60秒・一回限りのhandoffを対象サービスが引き換え、従来どおりサービス固有cookieを発行する。3サービスへ共通SESSION_SECRETを配布しない。

既存PWは移行中もすべて維持する。第一管理者PWは、パスキー紛失時に管理者パスキーとT-Cloud鍵envelopeを復旧登録する恒久経路であり、パスキー登録を理由に無効化・変更・削除しない。`PASSKEY_ENABLED`を`false`にするとPW経路を触らずパスキー経路だけ停止できる。

## WebAuthn

- RP ID: `tanaka-note.com`
- Origin: `https://tanaka-note.com`
- platform authenticatorを優先
- discoverable credential / resident key: required
- user verification: required
- challenge: 5分、一回限り、DBにはhashだけを保存
- 招待token: 1時間以上30日以内、一回限り、DBにはhashだけを保存
- 新規、追加、再登録は第一管理者の招待が必要
- 登録後は`pending_approval`となり、第一管理者の承認までログイン不可

## T-Cloud鍵解除

既存ファイル・folder key・file keyは交換せず、PW経路とパスキー経路を並行維持する。WebAuthn署名鍵を暗号鍵として流用しない。

第一管理者は現在のPW由来account keyで既存RSA管理者秘密鍵PKCS#8を端末内復号し、WebAuthn PRF出力からHKDFで導出したAES-GCM鍵で再暗号化する。一般Identityは端末でRSA-OAEP鍵ペアを生成し、秘密鍵を同じPRF由来鍵で暗号化する。第一管理者の端末がfolder keyを復号し、一般Identityの公開鍵へRSA-OAEPでwrapして承認する。サーバーが保存するのは公開鍵、暗号化済み秘密鍵envelope、暗号化済みfolder keyだけである。

PRF出力はJavaScriptからサーバーへ送信しない。PRF非対応端末では安全性を下げず、従来PWを案内し、T-Cloudパスキー利用可能とは扱わない。一般IdentityのCloud sessionは紐付けたroot folder IDを持ち、一覧、検索、ファイル取得、thumbnail、download、upload、rename、move、trash等の直接IDアクセスをroot配下へ制限する。

## 監査

各サービスの既存監査ログを維持したまま、Queue経由でSecurity D1へ共通イベントを非同期送信する。監査障害だけで通常ログインを停止しない。成功・失敗・停止・キャンセル、PW/パスキー、Identity、サービスaccount、role、時刻、salt/hash化したアクセス元、User-Agent、安全なsession識別子、重要な管理操作を記録する。

PW、authProof、cookie、session token、生の招待token、PRF出力、秘密鍵、復号鍵、folder/file key、日記・請求書・ファイル本文は記録しない。
