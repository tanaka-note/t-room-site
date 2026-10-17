# 資産報告リリース経路の読み取り監査（2026-10-17）

対象：`tanaka-note/t-room-site` の最新main `95f9bd144b58`、Worker `t-room-site`。
Cloudflareの設定変更、deploy、token・権限変更はこの監査で行っていない。

## 確認できた事実

- GitHub Actions `Verify changed services` の `verify`・`node (site)` とCodeQLは成功。
- 同じcommitの `Workers Builds: t-room-site` はfailure。
  [失敗したbuild 097d1e4a-2640-4ec0-a047-40601a3ea3d5](https://dash.cloudflare.com/277e86de986181599ce0db2b3ca1f186/workers/services/view/t-room-site/production/builds/097d1e4a-2640-4ec0-a047-40601a3ea3d5)
- GitHub checkのsummaryにはbuild IDとdashboardリンクだけがあり、失敗原因のログは含まれない。
- 読み取り専用Cloudflare MCPでWorker名・script tag・更新時刻を取得できた。
- 直近3件の本番deploymentはいずれも `source: wrangler`。最新は2026-10-17 03:58:15 UTC、
  version `3ebe180e-46da-497a-8b24-cbc3d3d06953` が100%で、直前の正規リリース結果と一致。
- 同MCPからWorkerのbuild一覧および上記buildのlogsをGETしたが、いずれもAPI code `12004: Forbidden`。
  したがって、Workers Buildsの失敗原因・設定済みbuild/deploy command・自動本番deployの有無は未確認。
  認証エラーをビルド失敗の原因とみなしてはいけない。

## リポジトリで確認した経路

- root `pnpm run build`：検索インデックス生成→`site:prepare`。生成物のないcheckoutからのbuild契約テストがある。
- `site:deploy`：target限定build同期→アセット準備→Wrangler deploy。
- 正規の本番公開：`npm run release -- site`。最新main・依存・対象verify・commit済みbuild整合性を検査し、
  アセット準備とdeploy後に本番buildを読み戻す。直近の手動公開はこの経路で成功している。
- GitHubのPublic site PreviewはPRからproduction trafficを切り替えないversions uploadのみ。

GitHubに記録されるWorkers Buildsは別の外部チェックで、ローカルリリース成功とは独立してfailureになっている。
Cloudflare側が正規の手動経路と競合しているか、単に不要な失敗通知になっているかは、ログとtrigger設定が必要で断定できない。

## コード外で必要な確認

アカウント所有者が上記buildのログとtrigger設定を確認するか、Buildsログを読める権限で再監査する必要がある。
失敗したcommand・終了理由・本番deploy commandを確認してから、リポジトリの修正かアカウント設定変更かを判断する。
自動本番deployが二重化している場合は正規経路を決めたうえで所有者が整理する。今回、無効化や設定変更は行わない。
