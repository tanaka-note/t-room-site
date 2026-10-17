# 日記の起動速度比較（2026-10-16）

## 原因と変更

調査開始時の最新main `61f99778e049` では、ログイン判定前に本体と5つのモジュールを順次importし、初期データが揃うまでapp-viewを隠していた。全体管理者の再開はsession・households・meta・entriesの4往復（通常利用者は3往復）で、保護GETごとに現在のsessionを確認していた。SWのinstallも本体／写真モジュールを先読みし、通常取得はnetwork-firstだった。

軽量入口、認可済み画面枠の先行表示、bootstrap API、写真投稿処理のlazy-load、公開静的資産のcache-firstと長期キャッシュへ変更した。現行の構成は [Diary README](../../diary-worker/README.md) を参照する。

## 計測方法

`tests/browser/startup-performance.mjs` の同じローカルHTTP fixtureで変更前後を実行した。最終比較の変更前は追従後のmain `4603ab118554` の公開資産を `git archive` で一時領域へ出力し、`TROOM_STARTUP_ROOT` で同じ試験へ渡した。Chromium、公開資産のHTTPキャッシュ／実SW、合成の読み取り専用accountと1件の日記を使う。各静的応答に30ms、認証APIに80ms、データAPIに250msの固定遅延を与え、MutationObserverからテスト内の `performance.mark` を記録した。単回の比較例であり、ネットワークやCPU性能を代表するp50/p95ではない。

Passkey試験は共有クライアントの認証結果を合成し、options・verify・security handoff・Diary handoffの4往復を再現する。実WebAuthnの操作時間、署名性能、本人の端末／本番DB性能は測っていない。PWAは実SWとstandalone表示条件のfixtureであり、実機でインストールしたOSアプリの測定ではない。

## 比較例

時刻はnavigation開始からのms。CだけはDiary handoff応答からの経過時間を示す。ログイン画面の表示とPasskeyボタン利用可能のmarkは同時だった。

| 条件 | 指標 | 変更前 | 変更後 |
|---|---|---:|---:|
| A 未ログインcold | ログイン画面／ボタン | 521 | 216 |
| B 未ログインwarm | ログイン画面／ボタン | 219 | 186 |
| C Passkey模擬、初めて本体を取得 | 画面枠 | 313 | 128 |
| C 同上 | 検索等の操作受付 | 313 | 139 |
| C 同上 | 一覧完成 | 313 | 397 |
| D ログイン済みwarm | 画面枠 | 441 | 171 |
| D 同上 | 一覧完成 | 441 | 436 |
| E standalone warm | 画面枠 | 445 | 179 |
| E 同上 | 一覧完成 | 445 | 440 |

初回ログインの一覧完成は約84ms増えている。ログイン前の本体取得を認証後へ移したためで、データ待ちと表示モジュールの取得は並行している。優先した改善は、ログイン画面の軽量化と、認証後にヘッダー・検索・読み込み状況が見える／操作できるまでの時間である。一覧そのものの大幅な短縮や本番での同じms値は主張しない。

| 通信・読み込み指標 | 変更前 | 変更後 |
|---|---:|---:|
| 未ログイン画面で実行するJS | 10本 / 247,343 bytes | 3本 / 30,812 bytes（約88%減） |
| A 観測した初期HTTP request、SW先読み込みを含む | 24 | 13～14 |
| B warm HTTP request | 3 | 3 |
| C 認証開始から一覧までのAPI | 6 | 5 |
| C 同期間のHTTP request（本体取得を含む） | 6 | 11 |
| D／E 再開時API（通常利用者） | 3 | 2 |
| D／E 再開時HTTP request | 5 | 4 |
| 全体管理者の初期API（実装経路） | 4 | 2 |

JS量はResource TimingのdecodedBodySizeの合計で、圧縮後の転送量ではない。試験用Passkeyスタブも同条件で含む。初期HTTP件数は画面markから50ms後までのserver観測値で、favicon／SWバックグラウンド取得の順序により1件程度変わる。SWキャッシュヒットはサーバーへのHTTP requestに含めない。HTMLの再取得を行う既存自動更新チェックは残っている。

## 安全性と確認

- challenge／credential／Identity／serviceLink／serviceAccount／sessionEpoch／single-use／expiry／replayの認証手順は変更していない。verify→handoff統合は共有認証の設計変更になるため見送った。
- bootstrapは保護GETとして毎回検証する。現行Securityの実コード＋両サービスの全migrationを適用したメモリーSQLiteで、query互換、household分離、一般利用者権限、単一request内の検証回数、foreground renewal、version／account version、改ざん、失効、logout replay、監査を試験する。
- ブラウザ試験で、未ログイン時に本体が未取得、閲覧時に写真投稿モジュールが未取得、権限付きUIのちらつきなし、初期検索と遅いbootstrapの競合、戻る条件の復元、ログアウト後の遅延応答、再ログイン中に古いログイン完了がボタンを再有効化しないこと、別household応答の拒否を確認する。
- SW試験でcold／warm／offline、正確なbuild URL、旧build URL・API・HTML・写真・投資・manifestの除外、エラー／private／no-store不保存、no-store応答bodyの解放を確認する。共通Updaterと未保存入力の保護も維持する。
- 既存の対象verifyに加え、起動安定性、検索、タグ、下書き、写真投稿の失敗回復、戻る位置、Rolling SessionのDiary限定回帰を実行する。本番公開は通常の対象限定releaseとbuild照合を使う。

FTS、DB再構築、migration、追加index、検証省略、認可結果の時間キャッシュ、個人テレメトリは追加していない。実端末LINE→外部ブラウザ、実端末のPasskey／PWA起動と通信条件別の統計計測は未実施。
