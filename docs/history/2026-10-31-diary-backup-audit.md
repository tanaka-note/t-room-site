# 2026-10-31 日記バックアップの読取監査

対象mainは`e45bd7a`。既存の作業差分は別worktreeに残し、今回の実装は新branchで行った。本番はCloudflare Read-Only MCPのGETと、単一SELECTのD1 Query APIだけを使用。写真本文・日記本文・Secretは取得せず、本番書込・削除・デプロイ・設定変更・Bucket Locks変更は行っていない。

## 確認事実

- Diaryの本番Cronは`25 18 * * *`（03:25 JST）の1つ。DB/MEDIA/BACKUP/SECURITY bindingはmainと一致した。Backupは03:40、Securityは03:41と毎時17分。
- Diary D1の集計は写真1,815件、3種類の参照計5,445、原本サイズ合計5,901,464,525 byte。過去の682件から増加している。
- R2 `v7/daily/`・`v7/monthly/`はどちらも0件。
- `media/photo-receipts/`は384件・116,460 byte、検証日時は10月27〜30日18:25 UTC。`media/verified-photos/`も384件・406,034,238 byte。現在のD1との個別突合はしていないため、参照総数との差を厳密な現在の未処理件数とは断定しない。
- Security監査を10月27日00:00 UTC以降・Diary backupイベント・最新16件に限定した。10月28〜31日JSTの各定期実行は`backup_partial / photos / media_incomplete / attempt=3`。未処理は順に1,736・1,631・1,625・1,623。最後の終端は10月31日03:30:29 JSTで、その後の上記D1件数集計とは観測時点が異なる。
- 両R2ともr2.dev無効・custom domainなし。Lifecycleは7日経過の未完multipart中止のみで、正式写真の`diary/staging/`objectを削除する規則はない。バックアップR2のBucket Locksは空。

## 原因と判断

mainの`runDiaryBackupUnlocked`はD1 snapshot取得後に`backupPhotos`を呼び、写真の`complete`がfalseならD1の圧縮・公開より前にreturnする。したがって、写真が処理枠内に終わらないことがD1世代未作成の直接原因である。監査の工程・理由も一致する。

写真は全件LISTと全参照配列を作り、古いreceipt順に新規コピーと7日再検証を同じ40 object枠で処理する。3試行でも理論最大120 object/日、さらに256 MiB推定I/Oと90秒で制限される。5,445 objectを7日で再検証するだけでも平均778 object/日で、枠を上回る。新着・再検証・過去分の競合とD1への依存を分離する必要がある。

Workerの実際のCPU・最大メモリや課金契約枠は測定していないため、プラットフォームのCPU/メモリ制限超過を本件の発生原因とは断定しない。公式のWorkers/R2制約とBucket Locksの比較、新方式の運用条件は[運用正本](../../backup-worker/README.md)に記載する。提案の新Cron・v8保存・写真追いつきは本番未反映である。
