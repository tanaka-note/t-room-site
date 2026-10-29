# Calendar API

Android版「カレンダー」のAPI。`https://tanaka-note.com/calendar/api/`を提供する。T-CloudのDBへ予定を書かず、`calendar-db`のサービスアカウントごとに分離する。Security CenterがIdentity・パスキー・明示的なサービス連携・失効・監査の正本となる。

## データと同期

`calendar_accounts`に利用先を登録する。初期の`main`・`second`の表示名は運用設定で指定し、認可処理へ氏名を固定しない。追加する場合は管理者が領域を登録した後、Security Centerで必要なIdentityへの連携だけを追加する。自動共有・初期権限の自動付与は行わない。

予定・追跡・タグはアカウント単位、設定はさらにIdentity単位で分離する。各変更は期待versionとrequestIdを持つ。SQLite triggerで同時更新を拒否し、受理済みの同じ再送は同じ応答を返す。シリーズ分割・個別通知の同時更新は同じtransactionへ含める。同期は単調なcursorを使い、1回の応答を200件・payload約6MiB以内に制限する。参照先・統合先も同じアカウント内に限定する。

ゴミ箱は30日で内容を除去し、削除済みIDをtombstoneとして保持する。繰り返しの個別削除も復元期限・完全削除の対象。古いオフライン変更で完全削除済みの予定を復活させない。復元作業後は`calendar_accounts.session_version`を増やして旧sessionを失効させ、古い端末状態を無条件で再適用しない。

`backup-worker`が日次30世代・月次12世代を既存の非公開R2へ取得する。schema fingerprintとsnapshot上限、保存後の読み戻し、隔離復元試験、監査・失敗監視を既存方式に従って使用する。本番への復元は別の承認を伴う操作とする。

## 初期構築・公開

新規Worker・D1作成・migrationは通常の既存Worker向けActions tokenと分離したインフラ操作。対象CI成功・main反映後にローカルの通常Wrangler認証で行う。既存の公開tokenの権限を勝手に拡大しない。

1. `calendar-db`を作成し、CalendarとBackupのbindingを設定する。
2. 新規Calendar DBへ`0001_calendar.sql`を適用し、利用者指定の表示名を設定する。
3. Securityの復旧可能な状態とpending migrationを確認して`0027_calendar_service.sql`を適用する。既存のリンク・handoff・鍵envelope・監査・session・集計・index・triggerは保存する。
4. Calendar専用の暗号学的乱数32byte以上の`SESSION_SECRET`と`PASSKEY_ENABLED=true`をWrangler Secretへ設定する。生成値をファイル・Git・ログ・チャットへ出さない。他サービスのSecretを再利用しない。
5. Calendarを公開し、Securityの`CALENDAR_AUTH`とBackupの`CALENDAR_DB`を反映する。既存のsite・Security・日記は対象CIとbuild markerの通常手順で公開する。
6. `.well-known/assetlinks.json`へ署名証明書に一致するAndroid packageを掲載する。パスキーのorigin・招待・管理者承認・復旧方針は変更しない。
7. 公開versionと未認証時の拒否を読み取りで確認する。実際のサービス連携は利用者がSecurity Centerで設定する。

通常のCalendar API更新もcleanな最新mainで対象verify後にWrangler公開し、`/api/version`とCloudflare deployment versionを照合する。新規CalendarとBackupは既存11 Worker向けのproduction Actions一覧に自動追加せず、必要な権限の準備後に改めて追加する。

```powershell
node tools/verify.mjs --target calendar --build
node tools/verify.mjs --target android-calendar
# clean main・対象CI成功後、calendar-worker/で実行
pnpm exec wrangler deploy --var BUILD_ID:<verified-commit>
```

rollbackはCalendarのサービス利用を停止し、直前のWorker versionへ戻す。拡張済みのSecurity CHECK制約は既存行と互換なので、既存データを削除してmigrationを巻き戻さない。新規DBも利用データが入った後は自動削除しない。
