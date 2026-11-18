# 投資・学習・コラム・体調管理・転送便のサービス終了

対象はT-lainトップのRoomsに掲載していた5件。再構築時は[終了前の実装](https://github.com/tanaka-note/t-room-site/tree/6a0ba3ff59df5091c73f028a69b9a62fffb426e5)を参照できる。

| サービス | 旧仕様と再構築時の参照先 |
| --- | --- |
| 投資 | `investment.html` は相場カードと分析記事3本を表示し、旧 `site.js` が相場JSONの取得・整形を担当した。別管理の `troom-market-worker` が更新日時と銘柄ごとの価格・変化率・取得状態を返す。旧 `investment-performance.html` は日記内の保護された投資履歴への転送入口。 |
| 学習 | `learning/` は社労士学習ログ、科目、トピックの静的サイト。ログの一覧データは `learning/learning-data.js`、本文の検索は Pagefind、図解は `images/learning/` と `tools/learning-visuals/` にある。 |
| コラム | `thought.html` が入口。音楽・時事のシリーズと本文は `columns/`、トップと記事一覧への掲載順は旧 `site.js` が管理した。 |
| 体調管理 | [Healthの設計](../../health-worker/README.md)を参照する。専用WorkerとD1、Security Centerによるサービス連携、パスキーPRFによる端末内復号を使った。共通Identityとcredentialは他サービスと共有し、利用権限と暗号化レコードは体調管理専用だった。 |
| 転送便 | `transfer/index.html` に、大容量ファイルを期限付きで受け渡す構想を掲載していた。転送処理、ストレージ、認証の実装は公開リポジトリで確認できなかった。 |

日記本体、日記内の投資履歴、資産運用報告を回帰確認の対象とする。再開時は体調管理に新しい連携IDを発行する。GitHubに保管するのは仕様とソースの参照情報で、実データや鍵は別管理とする。

## 本番反映と確認

1. Security Center、公開サイト、Health Workerを既存の本番公開手順で反映する。Security Centerが最初に反映された場合も旧Healthの連携・セッションは拒否される。Health Workerが先に反映された場合も、従来のSecurity向けRPCは空の候補を返す。従来のURLとAPIは `410 Gone` で応答する。
2. Security Centerの反映後、`security-db` で体調管理の連携件数を再確認する。終了前調査では active・pending・disabled がいずれも0件だった。`0031_retire_health_links.sql` は体調管理の連携、対応するhandoffと鍵の利用許可、体調管理セッションだけを削除する。共通パスキーと監査履歴は保持する。適用前後に対象件数と他サービスの連携を照合する。
3. `t-room-backup` は[専用Workerの公開手順](../../backup-worker/README.md)で反映する。体調管理を定期実行とBackup-data一覧から外し、他サービスの実行を確認する。既存のHealth世代と復元用定義は含めて保管する。元のHealth D1とR2世代の廃棄は、今回の連携削除とは独立した運用判断になる。
4. 公開トップと記事一覧、旧URLの `410`、学習のPagefindデータが配信されないこと、Security Centerの追加候補・ユーザー詳細・連携履歴から体調管理が消えたことを確認する。Googleで早く非表示にする場合は[Search Consoleの削除機能](https://developers.google.com/search/docs/crawling-indexing/remove-information)で対象URLを申請する。
5. `troom-market-worker` は別管理で、本PRはT-lainからの参照を外す。公開Worker自体を停止する場合は、他の利用元と定期実行の有無を確認してから別途切り替える。
