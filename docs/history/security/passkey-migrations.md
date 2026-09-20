# Identity・Passkey移行記録

この文書は一回限りのmigration、本番データ補正、当時の公開範囲を保存する履歴であり、現在の実装手順ではない。現行仕様は[`docs/security/passkeys.md`](../../security/passkeys.md)を正本とする。

## 0012: T-Cloud旧subadmin連携の整理

0012 migrationは旧subadmin linkを論理無効化した。既存PWアカウント、D1／R2構成、ファイル暗号方式は変更しなかった。

本番の第一管理者には、既存Atsushiトップフォルダー（当時の`rootFolderId=7`）への通常のfolder-member linkを追加した。これは配備時のデータ対応であり、認可コードへ氏名や固定root IDは埋め込まなかった。既存linkを確認して再利用し、無効化済みIDは再活性化しなかった。

## 0016: active session開始時刻の補正

0016 migrationはepoch、不正値、空値だけを対象に、session hash、Identity、service、認証方式が一致する矛盾のない成功ログイン監査から開始時刻を復元した。根拠のない値を現在時刻や最終アクセスで埋めず、監査、期限、失効状態は変更しなかった。

## 0017: 表示名データ補正（2026-09-09）

0017 migrationは対象IDと旧名称を限定した表示用データ補正で、再実行可能とした。2026-09-09の読み取り調査ではIdentity 2件、オーナー用連携5件が対象だった。本人の旧一般用Identityは既存main-user連携を確認して更新した。Atsushi等のfolderラベル、日記・請求書の氏名データは対象外とした。AI accountは調査時0件で、以後の登録と既存session応答は共通表示関数を通す方針とした。

当時の公開対象はSecurityの0017と6 Worker（Security／Cloud／Diary／Billing／AI／Downloader）だった。
