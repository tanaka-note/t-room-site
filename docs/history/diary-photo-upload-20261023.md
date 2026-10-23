# 日記画像送信エラーの調査・修正（2026-10-23）

対象は `tanaka-note/t-room-site` の日記のみ。調査開始のmainは `2772e41c150760590c493222d54c34395cbde86d`。本番の内容を読み取ったり、ユーザーの投稿・写真を変更する再現操作は行っていない。

## 確認できた事実と限界

- mainの送信処理は2件並列、250/750ms待機、3試行。fetch例外はすべて「画像の通信に失敗しました。」へ変換し、例外分類・経過時間は失われていた。429は再試行対象外、Retry-After未対応、明示タイムアウトなし。
- 選択した元Fileを画像生成後もそのまま送信していた。提供元ファイルの変更・参照失効と通常の通信断を識別できない。選択元を変更してから送信するローカルブラウザ回帰ケースを追加し、メモリ内snapshotによる送信成功を確認した。これは報告端末で同じ変更が起きた証明ではない。
- サーバー保存後に応答を失うと、冪等性の判定を受けるためにも元画像全体を再送していた。投稿ボタンが進行中の送信を待った場合、その失敗直後にさらに一連の送信試行を実行していた。
- 通常の写真送信は独自fetchだが、一時保存セッション作成・本文保存・commitは共通apiを使用する。共通apiの401処理が `resetState()` で編集画面と写真を消す経路を確認し、編集中はエラーを保持して終了する処理へ修正した。認証・認可の検証自体は変更していない。
- multipartはbyte数制限付きstreamをformDataへ渡すが、解析自体は全体のbuffer化を伴う。原本60MiB、全request80MiB上限。Cloudflareのrequest body上限とWorkerのメモリ上限は異なり、メモリ128MBはisolate内の並行requestで共有される。大容量2件の同時buffer化は負荷要因になりうる。今回の障害で制限超過した証拠は取得していない。大容量・低速時は端末側の並列を抑え、元画像の容量・品質・保存先は変更していない。
- Service Workerは正確なbuild付き静的GETのみを扱い、写真のPOST・APIのGETをcacheしない。既存の未保存入力・送信中の更新延期を維持した。

## 本番の読み取り調査

Cloudflare読み取り専用MCPで以下を照合した。調査操作によるCloudflare設定・データの変更はない。

- Diary Workerのcompatibility date `2026-08-04`、D1 `diary-db`、MEDIA `t-room-diary-media`、BACKUP、SECURITY、監査Queueのbindingはリポジトリ設定と一致。明示的なlimits/observability設定はsettings応答にない。D1 metadataはAPAC、約1.55MB、read replication disabled。metadataは個々の書込の成否や負荷の証明ではない。
- MEDIA Lifecycleは7日経過した未完了multipartのabortのみ。正式写真もある `diary/staging/` を自動削除するルールはない。
- 調査時の最新Diary deploymentは `2026-10-22T01:14:43Z`（日本時間10:14）、version `f1a467c4-11c1-4b23-824c-0c913e1fdd75`。障害時間直前のDiary deployは記録されていない。直近mainの写真処理分離・ナビゲーション変更と、今回の通信例外の直接の因果関係は確定できない。
- zoneのRate Limitは認証・unlock endpointへの10秒20回のルールで、写真upload APIは対象外。Managed WAF/DDoS rulesetも存在するが、イベント履歴なしに誤遮断の有無は確定できない。
- 指定時間帯 `2026-10-23 21:30〜22:45 JST`（`12:30〜13:45 UTC`）のWorkers GraphQL aggregateは日記全体87 requests、runtime errors 0、status success。これはupload専用集計でもHTTP 2xxの証明でもなく、接続前の失敗・管理されたHTTPエラー・応答消失を否定しない。
- 同時間帯のzone requestログ取得は403 `auth.forbidden`。写真APIを絞ったFirewall Events GraphQLもzone access制約で拒否された。過去の詳細request/例外ログ、HTTP status、Ray ID、Android端末のnetwork traceは取得できなかった。

したがって、報告された2枚で実際に起きた低水準の通信失敗は未確定。端末のファイル参照・回線、WAF、Worker/R2/D1失敗、認証再検証を推測で単一原因に断定しない。コードで確認できた復旧・保護の欠陥と、再現可能な失敗境界を修正対象とした。

## 修正と検証

現行の送信方式は[日記README](../../diary-worker/README.md)に記載。DB migration、保存先・公開範囲、認証・暗号化・鍵管理、バックアップ、写真commitの変更はない。

- `tests/photo-upload.mjs`：通常送信、通信断、timeout、408/429/503、Retry-After秒・HTTP日付と長期待機、401/403/400/413の自動再試行抑止、応答消失・成功応答破損の保存照会、有限試行、進行中の投稿操作で試行予算を倍増させないこと、再試行payload保持、大容量と通常画像の並列数。標準のrequest-safetyからも実行する。
- `tests/browser/photo-post-resilience.mjs`：JPEG単数・複数、選択元ファイルの変更、準備中の投稿、5xx、保存後の応答消失、本文作成/commit/最終PUTの応答消失・失敗、400、upload/セッション作成/本文保存の401、通信断時のタイトル・本文・日付・タグ・写真保持、下書き再試行、破棄。Chromium・Firefox・モバイルタッチ相当のfixtureで確認する。
- `tests/photos.e2e.mjs`：既存のローカルD1/R2・Security RPC fixtureによる一時保存/commit/cleanup競合、既存写真表示、アルバム、写真削除、下書き昇格、ゴミ箱/復元。新しい保存確認APIのno-store、所有account制限、未保存404も検証する。
- `tests/write-integrity.e2e.mjs`：既存の投稿冪等性、原子的なDB更新、streamの容量制限。
- EXIF Orientation 1〜8、PNG縦横：Chromium・Firefox・WebKit・タッチ相当で既存の画像処理回帰を確認する。
- 日記限定の標準verify（構文、unit/API、ブラウザ、Wrangler dry-run）。Web契約テストも日記profileで実行する。
- 公開前に、既存のService Worker差分判定が日記に加えてsiteを選び、mainで無関係な公開サイトまでdeployする経路を確認した。日記SW/manifestは日記だけを選ぶよう修正し、Web契約テストを日記profileへ移した。開発フロー・productionPlanの回帰で公開対象がdiaryだけになることを確認する。最終CI対象はtoolingとdiary、公開対象はdiaryのみ。

実行結果・公開commit/buildはPRと完了報告を正とする。初回のphotos E2Eは他処理による開発サーバーreload中にfixtureのメモリ内認証が失効し401で中断したため、配信ソース確定後に再実行し成功した。ユーザーデータを使う本番uploadは実行しない。

実機Android Chrome/WebView/TWA、OSがタブを終了した場合、実回線の大容量最大値・Cloudflare isolate限界の負荷試験は未実施。メモリ内保持はタブ終了・reloadを越えない。全利用者を跨いだWorkerの同時multipart負荷は残る。診断ログは失敗時のconsole出力だけであり、過去ログの復元や新しい永続収集設定を追加するものではない。

AndroidのFile提供元・mtimeと `ERR_UPLOAD_FILE_CHANGED` の関係は[Chromiumの公式issue](https://issues.chromium.org/issues/40123366)にも報告されている。同種の既知事例は原因候補の根拠であり、今回の端末で同じ事象が起きた証拠とは区別する。

参考：[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)。
