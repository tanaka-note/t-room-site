# T-ROOM 共通Identity・パスキー仕様

## 境界

Security Centerは「誰か」を表すIdentity、パスキー、招待、承認、サービス連携、共通監査を管理する。日記、T-Cloud、請求書管理のアカウントとroleは統合せず、認可の正本は常に各サービスとする。共通認証成功後は60秒・一回限りのhandoffを対象サービスが引き換え、従来どおりサービス固有cookieを発行する。3サービスへ共通SESSION_SECRETを配布しない。

既存PWは移行中もすべて維持する。第一管理者PWは、パスキー紛失時に管理者パスキーとT-Cloud鍵envelopeを復旧登録する恒久経路であり、パスキー登録を理由に無効化・変更・削除しない。`PASSKEY_ENABLED`を`false`にするとPW経路を触らずパスキー経路だけ停止できる。

パスキー由来の各サービスcookieにはIdentity、credential、service linkを識別するIDを保持し、保護APIごとにSecurity Centerへ有効状態を照会する。credential無効化、service link解除、Identity停止、`PASSKEY_ENABLED=false`のいずれかが発生した場合は次の保護APIアクセスで失効する。古い形式で検証用IDを持たないパスキーcookieも再ログインを要求する。PW由来cookieはこの照会対象外である。

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
- Identity IDは英大文字・英小文字・数字・`_`・`-`のみ、最大64文字
- 再招待時は同じIdentityの以前の未使用招待を取り消し、新しい招待だけを有効にする

## T-Cloud鍵解除

既存ファイル・folder key・file keyは交換せず、PW経路とパスキー経路を並行維持する。WebAuthn署名鍵を暗号鍵として流用しない。

第一管理者は現在のPW由来account keyで既存RSA管理者秘密鍵PKCS#8を端末内復号し、WebAuthn PRF出力からHKDFで導出したAES-GCM鍵で再暗号化する。一般Identityは端末でRSA-OAEP鍵ペアを生成し、秘密鍵を同じPRF由来鍵で暗号化する。第一管理者の端末がfolder keyを復号し、一般Identityの公開鍵へRSA-OAEPでwrapして承認する。サーバーが保存するのは公開鍵、暗号化済み秘密鍵envelope、暗号化済みfolder keyだけである。

PRF出力はJavaScriptからサーバーへ送信しない。PRF非対応端末では安全性を下げず、従来PWを案内し、T-Cloudパスキー利用可能とは扱わない。一般IdentityのCloud sessionは紐付けたroot folder IDを持ち、一覧、検索、ファイル取得、thumbnail、download、upload、rename、move、trash等の直接IDアクセスをroot配下へ制限する。

WebAuthn credential登録とT-Cloud鍵準備は別状態として扱う。PRF非対応または鍵envelope作成・通信が失敗しても、登録済みcredentialをSecurity・日記・請求書の「登録失敗」とは扱わない。T-Cloud linkだけを未準備のまま保ち、端末内で安全に再試行できる。第一管理者もT-Cloud鍵envelope保存完了までCloud linkを有効化しない。

## 監査

各サービスの既存監査ログを維持したまま、Queue経由でSecurity D1へ共通イベントを非同期送信する。監査障害だけで通常ログインを停止しない。成功・失敗・停止・キャンセル、PW/パスキー、Identity、サービスaccount、role、時刻、salt/hash化したアクセス元、User-Agent、安全なsession識別子、重要な管理操作を記録する。

PW、authProof、cookie、session token、生の招待token、PRF出力、秘密鍵、復号鍵、folder/file key、日記・請求書・ファイル本文は記録しない。

ダッシュボードと監査の日付境界は日本時間（Asia/Tokyo）を使用し、保存時刻はUTC ISOを維持する。ログイン成功・失敗は定義済みイベント種別で集計し、文字列の部分一致には依存しない。
