# Downloader連携調査（2026-09-09）

調査時main: ca92c1d536a9882c19e40fa6982d572d9512eac7。D1本番の全8 Identity・28連携を読み取り調査。時刻は特記のない限りUTC。既存監査の原本は変更しない。

## 結論と既存データの扱い

| Identity | Downloader link ID | 分類 | 証拠・扱い |
| --- | --- | --- | --- |
| primary-admin（田中宏知・オーナー） | 4ce9bf6219868e1f66d4e12f56ab0be7 | 正常（基幹連携） | 2026-09-03 09:00:15、0011適用時刻と一致。初期INSERTはprimary-admin限定。維持。 |
| 812040b0-9cc4-4e69-8e66-96d03fa18945（田中暢美） | f6e684ec-ae67-43c1-90b9-cbb996aea447 | A：正常な明示追加 | 2026-09-07T15:31:13.253Zのservice_link_added（event e64d3df2-9af2-43df-885b-5ef94cbad98c）にchangedBy=primary-admin,count=1。秒まで同時刻に作成された連携はDownloaderの1件のみ。addIdentityLinksの明示リクエスト経路。維持。 |
| 48b42ac3-0092-4ae7-a342-9e772c8a8e8b（田中千晴） | d9250af5-bf86-4538-b13b-29b76e5a3bbd | C：選択意図を判断不能 | 2026-09-08 03:51:55にIdentity・招待・4連携を作成、13:05:09に承認。招待のcreated_by_identity_idはprimary-admin。当時のidentity_created / invite_createdにはサービス内訳がない。招待リクエストに含まれていた経路は確認できるが、個別の意図までは断定せず維持。 |

田中暢美の直接原因はオーナーの認証済み追加リクエスト。本人確認用パスキーを持つだけの自動付与ではない。UIの実際のクリックや操作した自然人そのものは監査だけから証明できない。田中千晴については、招待作成時のUIはサービス・連携先とも空欄が初期値であり、コードにDownloaderの自動挿入はない。ただし当時の選択内訳の監査が不足しているため、今回の指定どおりCとして残す。

残り5 Identityはdisabled（田中暢美4件・田中宏知一般1件）でDownloader連携なし。現在invited / pending_approval Identityは0件。非オーナーへの自動付与・不具合による作成を示すBの確証は見つからなかった。

**本番データ変更：0件。既存連携のbefore/afterは同一。** 正常・判断不能の連携を一律に解除するmigrationは作らない。パスキー、監査、T-Cloud鍵、各サービスの実データに変更なし。田中千晴の継続利用許可はオーナーの判断待ち。

## 確認した経路と変更

- 0011はDownloader追加時のスキーマ移行とprimary-adminの初期連携のみ。適用済み日時2026-09-03 09:00:15。0017は表示名だけのUPDATE、適用日時2026-09-09 10:31:32。リンクは生成しない。
- ensurePrimaryAdminRecordsとPRIMARY_ADMIN_CORE_LINKSはprimary-admin限定の基幹連携を作成・保護する。SERVICE_REGISTRYは候補プロバイダーの対応表であり、連携の自動付与ではない。
- createIdentityAndInviteは入力された連携だけを作成していた。今後はDownloaderを招待候補から除外し、APIでも招待同時追加を拒否。作成後の利用者詳細から個別に追加する。
- addIdentityLinksのDownloader追加はprimary-adminかつ既存の5分以内の再認証を必須とする。認証設計や鍵管理は変更しない。
- 明示追加をリンクごとにservice_link_addedとして、service / account / link ID / changedBy / source / status付きで同一D1バッチに記録。招待時の他サービス連携にも内訳を残す。過去ログは補作・書き換えしない。解除イベントにもlink IDを追加。
- invitationVerify / approveIdentity / reinviteIdentityはDownloaderを新規生成しない。承認はすでに存在するpending連携のみ更新する。
- authenticationOptions / authenticationVerify / createHandoffは対象Identityのactiveな対象サービス連携を要求。redeemHandoffのJOINにもl.identity_id = h.identity_idを追加し、不整合なhandoffの引換を拒否。
- Downloader requireSessionは全保護リクエストでSecurityのvalidatePasskeySessionを呼び、Identity・credential・link・service・account・epochを照合。解除はリンクをdisabledにし、対象リンクのactive-session記録を終了。旧cookieは次の保護アクセスで拒否、再追加は別link ID。オーナーsessionと他サービスは継続。
- 本番の田中暢美の詳細でDownloaderが「基幹連携」と誤表示され、解除ボタンが隠れる不具合も確認。identityDetailのprotected判定がservice/accountだけを比較していたため、isPrimaryAdminCoreLinkにもprimary-adminのIdentity条件を加え、APIの解除保護と一致させた。一般ユーザーの明示付与は通常の解除可能な連携になる。
- UIの現在連携はD1から返るactive/pendingリンクのみ。追加候補は別の閉じたeditorで、サービス・連携先とも初期選択なし。既存構成を維持。

## Git照合

Downloader導入commitは4ef5193。導入後、田中暢美の追加・田中千晴の招待時点のSecurityコード（83bd826まで）も確認した。現在および当時のaddLinkRowには空の選択肢があり、createIdentityAndInvite / addIdentityLinks以外に一般ユーザーへDownloaderを生成する処理は見つからない。コミット日時単体から本番適用日を推定せず、D1の適用日時・連携日時・監査記録を優先した。

## 全Identity横断のサービス連携（調査時）

| identity_id | 表示名 (Identity status) | service | service_account_id | link status | created_at | updated_at | link id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2545327a-96e6-4b38-ad24-a8fe85de292a | 田中宏知（一般ユーザー） (disabled) | diary | main-user | disabled | 2026-08-23 01:52:45 | 2026-08-23 12:38:08 | 870daf3c-c45e-497f-88d7-cc2e03b4f6eb |
| 48b42ac3-0092-4ae7-a342-9e772c8a8e8b | 田中千晴 (active) | cloud | folder-member | active | 2026-09-08 03:51:55 | 2026-09-08 13:05:09 | 861a686b-089b-4fd0-b76f-aec26c3d09c1 |
| 48b42ac3-0092-4ae7-a342-9e772c8a8e8b | 田中千晴 (active) | diary | chiharu-admin | active | 2026-09-08 03:51:55 | 2026-09-08 13:05:09 | 78af95eb-8f79-49b0-8572-43a931cf2a2c |
| 48b42ac3-0092-4ae7-a342-9e772c8a8e8b | 田中千晴 (active) | billing | chiharu | active | 2026-09-08 03:51:55 | 2026-09-08 13:05:09 | 0d86690d-6f7e-4b8d-a501-6a7110b3d425 |
| 48b42ac3-0092-4ae7-a342-9e772c8a8e8b | 田中千晴 (active) | downloader | owner | active | 2026-09-08 03:51:55 | 2026-09-08 13:05:09 | d9250af5-bf86-4538-b13b-29b76e5a3bbd |
| 66504118-bf2e-4236-ae7c-7d75daed6ad0 | 田中暢美 (disabled) | cloud | folder-member | disabled | 2026-08-23 12:16:36 | 2026-08-25 14:16:53 | 9b69728b-d5f7-4c15-9402-7e73844069d0 |
| 66504118-bf2e-4236-ae7c-7d75daed6ad0 | 田中暢美 (disabled) | diary | wife-admin | disabled | 2026-08-23 12:16:36 | 2026-08-25 14:16:55 | fe14555c-dfec-4e1d-bdde-46e9ad68fa50 |
| 66504118-bf2e-4236-ae7c-7d75daed6ad0 | 田中暢美 (disabled) | billing | masami | disabled | 2026-08-23 12:16:36 | 2026-08-25 14:16:51 | c75044f8-584e-476d-b5c1-83c21b974e3e |
| 6bda75d8-5204-4c84-84d1-cef7b825b772 | 田中暢美 (disabled) | cloud | folder-member | disabled | 2026-08-25 14:18:46 | 2026-08-25 14:23:43 | 64952ff4-7ea7-48da-894b-71cedfe463c6 |
| 6bda75d8-5204-4c84-84d1-cef7b825b772 | 田中暢美 (disabled) | diary | wife-admin | disabled | 2026-08-25 14:18:46 | 2026-08-25 14:23:45 | c5ebd745-f9db-4f99-855c-f698f9b7c131 |
| 6bda75d8-5204-4c84-84d1-cef7b825b772 | 田中暢美 (disabled) | billing | masami | disabled | 2026-08-25 14:18:46 | 2026-08-25 14:23:42 | 0b298b86-bd70-441c-b328-0174574bd3b7 |
| 812040b0-9cc4-4e69-8e66-96d03fa18945 | 田中暢美 (active) | cloud | folder-member | active | 2026-08-25 14:24:17 | 2026-08-26 12:27:37 | 8dd08266-2480-4076-a5f3-8c9226c04dbe |
| 812040b0-9cc4-4e69-8e66-96d03fa18945 | 田中暢美 (active) | diary | wife-admin | active | 2026-08-25 14:24:17 | 2026-08-26 12:27:37 | f01bc46f-38f8-46f6-b231-9bb7e03163c6 |
| 812040b0-9cc4-4e69-8e66-96d03fa18945 | 田中暢美 (active) | billing | masami | active | 2026-08-25 14:24:17 | 2026-08-26 12:27:37 | 2b4cd45f-3f67-40cc-a589-1c533914ff90 |
| 812040b0-9cc4-4e69-8e66-96d03fa18945 | 田中暢美 (active) | downloader | owner | active | 2026-09-07 15:31:13 | 2026-09-07 15:31:13 | f6e684ec-ae67-43c1-90b9-cbb996aea447 |
| bf991bf2-5a8e-49b3-a43d-275996641eda | 田中暢美 (disabled) | diary | wife-admin | disabled | 2026-08-23 12:05:08 | 2026-08-23 12:16:21 | 27cd8528-86ab-4877-9e82-824d1efcf50f |
| bf991bf2-5a8e-49b3-a43d-275996641eda | 田中暢美 (disabled) | billing | masami | disabled | 2026-08-23 12:05:08 | 2026-08-23 12:16:16 | bc41d47b-c94d-4c3b-bd19-eab013e3ba26 |
| bf991bf2-5a8e-49b3-a43d-275996641eda | 田中暢美 (disabled) | cloud | folder-member | disabled | 2026-08-23 12:05:08 | 2026-08-23 12:16:19 | c7f29ca6-bebf-4039-8ade-59ab9a306e2c |
| c34f73ee-200f-4113-a0a6-b10d0d8a9f4f | 田中暢美 (disabled) | diary | wife-admin | disabled | 2026-08-23 12:03:00 | 2026-08-23 12:16:27 | bb47a9b5-d0b5-475d-affb-7930731140c0 |
| c34f73ee-200f-4113-a0a6-b10d0d8a9f4f | 田中暢美 (disabled) | billing | masami | disabled | 2026-08-23 12:03:00 | 2026-08-23 12:16:25 | 30167e2c-8016-4fb6-8dec-a35114bb1d22 |
| primary-admin | 田中宏知（オーナー） (active) | cloud | admin | active | 2026-08-22 05:43:05 | 2026-08-22 06:20:19 | f9b1bd2c-b820-4a07-81fb-596e5967447a |
| primary-admin | 田中宏知（オーナー） (active) | diary | main-admin | active | 2026-08-22 05:43:05 | 2026-08-22 05:43:15 | 684f4e68-99aa-475e-924e-86d81bef05c2 |
| primary-admin | 田中宏知（オーナー） (active) | billing | owner | active | 2026-08-22 05:43:05 | 2026-08-22 05:43:15 | a53b1124-8e29-4cd7-a27e-8dbc76d8c59e |
| primary-admin | 田中宏知（オーナー） (active) | cloud | subadmin | disabled | 2026-08-23 10:10:18 | 2026-09-05 04:58:46 | primary-admin-cloud-subadmin-v1 |
| primary-admin | 田中宏知（オーナー） (active) | diary | main-user | active | 2026-08-23 14:14:58 | 2026-08-23 14:14:58 | primary-admin-diary-main-user-v1 |
| primary-admin | 田中宏知（オーナー） (active) | ai | owner | active | 2026-08-26 12:38:13 | 2026-08-26 12:38:13 | ae86df69bc264b2b0bba2224e2c0e894 |
| primary-admin | 田中宏知（オーナー） (active) | downloader | owner | active | 2026-09-03 09:00:15 | 2026-09-03 09:00:15 | 4ce9bf6219868e1f66d4e12f56ab0be7 |
| primary-admin | 田中宏知（オーナー） (active) | cloud | folder-member | active | 2026-09-05 04:59:54 | 2026-09-05 05:01:32 | 6249a049-cbf6-43d1-814c-3e6ea2bda255 |

## 検証

- downloader-grants.test.js：実ハンドラー・実SQL・SQLite D1バッチ・署名セッションでライフサイクル、複数利用者の分離、基幹保護、migration再実行、Identity不一致handoff、失効cookie/未使用handoffを検証。WebAuthnの端末認証部分とサービスのアカウント説明RPCはfixture。
- 既存のdomain・contract・kill switch・service session・Downloader migration・名称表示・Downloader contractと合わせて100テスト成功。
- PC1280px / スマホ390pxで招待からの除外、詳細追加候補、空初期値、明示選択後のpayloadを確認。
- Container起動、実ダウンロード、課金スキャン、大量データ生成は行わない。
