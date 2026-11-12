# 日記D1暗号化：ローカルCodexへの引き継ぎ

記録日：2026-11-12（日本時間）。状態：実装途中・公開不可。

## 再開する場所

- repository：`tanaka-note/t-room-site`
- 元のDraft PR：<https://github.com/tanaka-note/t-room-site/pull/221>
- 元のPR branch：`codex/diary-d1-encryption-review`
- ローカル移行用の保存branch：`codex/diary-d1-encryption-local-handoff`
- 元の保存済みコード：`2629fa12e88d9445557249d6b1c27a3f3369e1f2`
- 仕様：[`../security/diary-encryption.md`](../security/diary-encryption.md)

クラウド実行環境の通信障害後、このセッションから作業フォルダへのアクセスが回復した。元の保存済みコードに対する未コミット変更60ファイルを回収した。保存branchはこの途中コードと本メモを含む。元のDraft PRへの追加コードpush・merge、本番deploy、実データ移行は今回行わない。

回収した差分は一時index上でpatch化し、元commitに適用したtreeが回収時のtreeと一致することを確認した。これは移送の整合性確認であり、機能・安全性の検証完了を意味しない。元の作業treeとindexは変更していない。依存パッケージ、認証情報、実データ、秘密鍵、node_modulesは移送しない。

## ユーザーが承認した範囲

現在は仕様と隔離実装・合成データ試験まで。実端末を操作できないため、実パスキー・予備端末・既存復旧を用いた確認は後工程とする。本番反映・本番DB migration・既存平文削除・写真の再アップロード・PR mergeを進めない。

優先事項は、既存の日記D1データ、新規投稿の保護、現在と同等に近い操作感。写真本体の暗号化は別工程。日記独自の利用者保管用復旧キーは発行せず、既存Security Center/T-Cloudの管理者復旧基盤を使用する。

## ローカルでの開始

既存のローカル変更がある場合は、そのcheckoutを変更せず別フォルダへcloneする。

```sh
git clone --branch codex/diary-d1-encryption-local-handoff --single-branch https://github.com/tanaka-note/t-room-site.git t-room-diary-local
cd t-room-diary-local
```

GitHubへのアクセス認証はローカルで行う。認証情報・パスキーPRF・復旧秘密鍵をチャットやGitへ貼らない。Codexアプリ/CLIでこのフォルダを開き、次を依頼する。

> docs/history/2026-11-12-diary-local-handoff.md を読み、日記D1暗号化の実装を引き継いでください。AGENTS.mdと関連正本文書に従い、回収済みの途中コードの差分確認から始めてください。既存Security Center復旧を使用し、独自の利用者保管用復旧キーは追加しません。未解決事項の修正、実Workerと実UIを接続した合成データ試験、関連回帰・build、Draft PR #221への反映まで進めてください。本番deploy、本番DB操作、実データ移行・削除、写真本体の移行、PR mergeは行わず、実端末確認は未実施として残してください。保存branchをmergeせず、検証後のコードを元のPR branchへ反映してください。

Node.js 24、pnpm 11.19.0を使用する。依存install、verifyの選び方は `docs/development-flow.md` が正本。保存branchのコードは元のPR commitから直接続くので、後で元のPR branchへ反映できるが、その時点のremote差分を確認し、force pushは行わない。クラウド内の会話・プロセス・ログイン状態がローカルへ自動移送されるわけではない。

## 保護の境界と既定方針

- 本文、タイトル、タグ、日記日付・天気、表示名、写真名・寸法等のmetadata、お気に入りを端末側で暗号化する。検索・集計・絞り込みは端末内。
- 認可・同期に必要な不透明ID、世帯・記事等の関連、公開/下書き/ゴミ箱の状態、revision、epoch、sequence等は残る。D1全体の全列が秘匿されるわけではない。
- 写真bytes、EXIF、既存R2 objectや過去backup/Time Travelの平文は、この実装だけでは保護し終わらない。
- Cloudflare上の保存情報だけを取得されても復号させないことが目的。配信JavaScriptまで攻撃者が変更できる場合、Web版だけで復号後の情報の窃取を完全には防げない。
- 専用のHTTPS originをSecurity Centerと分離。公開authorityと最低generationは信頼済み端末等から渡す。同じAPIが返すanchorを無条件に信頼しない。
- AES-256-GCMとAAD、RSA-OAEP受取鍵、独立したECDSA署名鍵、WebAuthn PRFとHKDFによるvault解除。PRF非対応時にサーバー平文鍵へfallbackしない。
- 既存T-Cloud復旧用RSA鍵で日記専用復旧bundleのAES鍵をwrapする。日記のscope鍵・署名authorityは独立させる。秘密鍵をCloudflareに渡さない。

## 元のPRに保存済みだった範囲

`diary-worker/e2ee/` に隔離した暗号・署名・scope・認可・CAS保存・同期・migration・backup/restore・cache・既存復旧への暗号的接続候補がある。26のprotocol試験、旧ブラウザprototypeと関連CIは元commitで成功していた。

旧ブラウザprototypeはfixtureでfetchを差し替えており、本番Workerと実UIの正式な接続試験ではない。実端末や本番公開可能性の根拠にしない。詳細な仕様書の「未接続」はこの保存済み段階の説明であり、以下の回収コードと照合して更新する必要がある。

## 回収した追加コード

### 日記Workerと端末runtime

- `e2ee/codec.mjs`：gzip後のAES暗号化format 2。format 1/2読取、AADにheaderを含める。復号後文書上限2 MB。directoryはversion 1のまま。
- `e2ee/rollout.mjs`、schema、`legacy-fences.sql`：legacy/migrating/encrypted/paused/restoringとgeneration CAS。既定legacy。暗号化済み実績後のlegacy降格を禁止。旧平文書込や停止中書込をDBで遮断。候補SQLは通常migrations外。
- `e2ee/http.mjs` と `src/index.js`：実Workerの暗号化API、署名済みsession由来のactor、実権限・世帯分離、暗号化切替後の旧API遮断。importは通常HTTPから許可しない。
- `client/cache/snapshot/store`：暗号文だけのIndexedDB、sequence下限の永続化、cache+delta同期。headから最大50行・約1 MBのページを作り最大4並列で取得する追加処理は未検証。
- `e2ee/media*.mjs`：新規写真metadataの暗号化、generic binary upload名、CAS attach、参照保護と安全な孤立object処理。画像bytes/EXIFの暗号化は未実装。
- `e2ee/privacy.mjs`：sessionStorage/historyの状態を暗号化し、タグ名をURLへ平文で出さない。
- `public/diary-encryption.js`、bootstrap、diary.js、photo-upload：実crypto adapter、RAM内鍵を維持するSPA遷移、世帯切替・ログイン更新・期限切れとの接続。30秒同期はforegroundかつ最近の操作がある場合。
- `e2ee/origin.mjs`：専用origin制約、認証に限定したSecurity proxy。DNS/routes/TWA/本番設定は未変更。機能flagは既定OFF。

### Security Center

- `security-worker/e2ee/diary-keys.sql`、`src/diary-keys.js`、`public/diary-setup.mjs` と既存UI/Workerへの接続。
- 同じWebAuthn credentialがmain-admin/main-user両方に対応する現行仕様を考慮し、credential+serviceLinkから論理recipientを導出してvaultを分離。
- 署名済みdirectory/grant、暗号化vault、既存復旧bundle、現在のlink/credentialとDiary RPCの実権限を照合。
- 新規承認済みパスキーには過去の個別record鍵への補助grantを作る。旧署名検証情報を保持。
- 既存復旧秘密鍵を端末で解除し、公開鍵の照合を経て使用。設定応答喪失時は暗号化済みpending proposalを保存し同じ設定を再送。
- `rekeyRequired` による書込停止はあるが、失効後の完全な全件再暗号化・鍵交換機能は未完成。完了扱いにしない。

`web-apps.json` にassetCopies/buildFilesを追加済み。`public/crypto/`、`public/diary-crypto/` とHTML/service-workerの生成コピー・hashは途中時点であり、最新ソースと一致していない。回収時のまま保存したので最終同期が必要。

## 確認済みと未確認

追加実装の途中時点では、protocol 26 + rollout 4 + cache/codec 2の計32試験が成功。実Worker HTTP試験6件も成功し、同一credentialの論理account分離、世帯越境拒否、phase書込停止、失効、写真metadata staging/attach/参照保護を確認した。

その後の変更全体は再検証していない。特にparallel head、SPA遷移、BroadcastChannel、世帯/role切替等の最後の修正は未確認。実runtimeブラウザ試験はまだ作成していない。今回の回収ではコードを修正せず、patch適用とtree一致だけを確認した。

`tests/e2ee/system-fixture.mjs` は実Diary Worker、合成SQLite、候補schema、実Security鍵設定関数を使用する。Securityの認証・handoffのみstub。主identityは同じ物理credential/PRFでmain-admin/main-userの別論理vaultを持つ。実データは使用しない。

## 再開後の優先作業

1. 差分・構文を確認し、公開trust importを厳密な公開鍵限定validatorにする。秘密JWK/未知fieldをlocalStorageへ保存させない。vault/config/grantのscope・世帯・version・wrapped key長も検証する。
2. `rekeyRequired` がcredential/link失効に加え実role・scope変更も検知するようにする。失効を無視するfallbackは追加しない。完全rekeyは未完成として有効化を止める。
3. 新規パスキーの過去record grant、狭いゴミ箱受取人、復旧・backup restore、pending configの応答喪失/idempotenceを試験する。
4. head分割境界、長文byte上限、同時更新時の再試行停止、rollout leaseとtransactionのgeneration競合を試験する。snapshot全件metadata走査に戻さない。
5. `system-fixture` で実WorkerをNode HTTP bridgeから配信し、実public bootstrap/runtimeを使うPlaywright試験を作る。実passkey-clientを配信し、合成PRF/trustはaddInitScript等で端末側だけへ注入。PRFをHTTPへ渡さない。
6. 投稿・編集・共有下書き・お気に入り・検索・タグ・Back/forward・scroll・dialog・写真upload/save・reload・停止中saveの未保存入力保持・世帯/アカウント切替を確認。HTTP URL/body、SQLite、IDB、sessionStorage/historyへ本文等のcanaryが漏れないことを確認する。写真bytes/EXIFは別工程として区別する。
7. SPAのroute reset/popstate、世帯変更時のsessionContextとnavigationの再生成、再login後のupload client差し替え、期限更新、BroadcastChannel pingpong防止、通常network errorでの鍵維持を重点確認する。
8. 写真attachのrevision更新と現行finalize/retry、target/epoch照合、retire時の参照保持、pause中upload遮断を確認する。`diary/staging/` に自動削除Lifecycleを追加しない。
9. runtimeの利用者向けエラー/鍵準備導線、operator向け手順、format 1/2対応の既知良好版への復帰を仕上げる。
10. 必要な生成コピーを作ってから、`node tools/sync-web-app-builds.mjs --target t-room-diary` と `--target t-room-security` を別々に実行する。新規assetCopy先が存在しないと既存toolが失敗する点に注意。対象外ファイルは整形しない。
11. 新試験をpackage/verify-planへ組み込み、Diary、Security/認証、web-apps/toolingの関連回帰・buildを実行する。差分verifyで範囲を決める。実端末・本番の高コスト試験で代替しない。
12. 仕様書とrollback手順を最終実装に更新し、計測後に元のDraft PRへ反映する。回収branchのcommit自体を公開可能性の証拠にしない。

## 速度・費用・復帰に残る条件

旧計測は合成1,200記事・写真metadata 21,600件で、初回暗号文約17 MB、暗号処理p95約428 ms、端末内検索p95約3.8 ms。PRF・実回線・描画を含まない。新しい圧縮・cache・並列取得の結果ではないので、再計測して初回転送と通常操作の快適さを評価する。

本番移行前に、D1保存量・read/write、Workers CPU/requests、R2の新旧backup容量と操作回数、logs等を他サービスとの合算で確認する。今回の回収はCloudflareリソースを作成せず本番へ接続しない。通常のGitHub pushに伴うCI等が発生する可能性はある。

切替前にformat 1/2を読める既知良好版を用意し、binding/origin/機能flagも揃えて退避する。暗号化切替後に旧平文専用Workerへ戻さない。問題時は書込を止め、暗号文と新規投稿を保持して互換版・検証済みbackupへ復帰する。コードを戻すだけでデータも即座に戻るとは扱わない。平文旧世代・Time Travel・cacheの保持期間は別管理する。

実PRF、予備パスキー、既存Security Center経由の実復旧、専用origin/DNS/TWA、実端末の速度と戻る操作の確認が終わるまで、本番切替の準備完了とは報告しない。
