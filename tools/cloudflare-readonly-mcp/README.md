# Cloudflare読み取り専用MCP（未公開）

公式 `https://mcp.cloudflare.com/mcp` の設定変更ではなく、独立した読み取り専用ツール実装。
現在はローカルstdioと、認証済みホストに組み込むserver factoryのみ。HTTP listener、OAuth、
Cloudflare Worker、route、Secretは作成していない。既存ChatGPT接続にはまだ適用されていない。

## 調査結果（2026-09-20）

- Codexに接続済みの公式MCPで、accounts GET、D1一覧、sqlite_master SELECT、日記schema、
  本文検索を実行できた。全てHTTP 200。SELECTは `rows_written=0` / `changed_db=false`。
  日記本文や実際の検索結果をこのリポジトリへ保存しない。
- ChatGPT側で報告されたOpenAI安全性ブロックはこのCodex環境では再現しなかった。
  OpenAI内部の判定ログは参照できず、ブロック原因は未確定。
- 現在見える `execute` は `{code: string, account_id?: string}`。HTTP method enumはJSON入力schema
  そのものではなく、説明内の `cloudflare.request` 型定義。説明はGET/POST/PUT/PATCH/DELETEと
  create/update/deleteを含む。
- 公式公開ソース `cloudflare/mcp@76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1` の
  `src/tools/execute.ts` は `readOnlyHint:false`, `destructiveHint:true`, `openWorldHint:true`。
  接続先が同commitで動いていることや、生のtools/listのannotationsまでは確認できていない。
- 同ソースのGlobalOutboundは送信先hostnameと資格情報を管理するが、method・SQLの読み取り専用
  検証は行わない。OAuth read-only presetは存在するが、ツールは汎用のまま。
- ChatGPTプラグイン設定は「Allow read actions」を継承。これはOAuth/API Tokenの権限とは別。
  接続に付与済みの全scope/permission一覧は未確認。読み取り成功は書き込み権限不在の証明ではない。

## ツール

| name | 入力 | 上流通信 |
| --- | --- | --- |
| cloudflare_read | path, query? | allowlist内GETだけ |
| d1_read_query | database_id, sql, params? | 検証済み単一SQLをD1 queryへPOST |
| cloudflare_analytics_read | query, variables? | query operationだけをGraphQLへPOST |

全て `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`。
private account/zone scopeに限定。method/code/body/headers/tokenを入力として受け取らない。
`policy.mjs` がallowlistの正本。未知endpointは追加レビューするまで拒否する。

対象: D1、R2バケットmetadata、Workers、Deployments、Versions、Bindings（値を伏せる）、
Routes、Queues metadata（pull/ack禁止）、Containers構成、Pages、KV namespace/key metadata、
GraphQL Analytics。R2 object本文、KV value、Workerソース、Secrets、任意URLは対象外。
Analyticsは現行OpenAPIで確認できない旧REST endpointを推測で追加せずGraphQLへ分離。

SQLはSQLite ASTを再帰検証。SELECT/CTE/サブクエリ/UNION/集計と許可済み関数を受理。
EXPLAINの対象もSELECTに限定。PRAGMAは単一table_infoだけ。複数文、DML/DDL、任意PRAGMA、
extension/file/eval関数、未知構文/未知関数は拒否する。SQL本文は書き換えずparamsを分離して送る。
対応していない最新SQLite構文は安全側で拒否するため、分析に必要な構文は回帰試験とともに追加する。
AST検証だけで将来のSQLite拡張まで保証しない。上流のD1 Read権限を必須の独立防御として維持する。

GraphQLは構文解析で単一queryのみ許可し、accountTag/zoneTagを固定scopeと照合する。
送信先固定、redirect禁止、15秒timeout、レスポンス1MiB、返却D1 rows最大200。
Token、SQL、params、本文、rawエラーをログ出力しない。メタデータの資格情報フィールドは伏せる。

## ローカル検証

このディレクトリで `npm ci --ignore-scripts`、`npm test`。
テストは偽fetchと合成データだけを使用し、本番へ変更SQLや変更methodを送らない。
MCP SDKの実際のtools/list応答とtools/call経路も検証する。

ローカルstdioを接続する場合は `.env.example` の変数をプロセス環境へ安全に設定し、
`npm start`。この実装は.envを自動読込しない。Wranglerの既存書き込み可能tokenを流用しない。
`CF_READ_API_TOKEN` は対象accountだけのRead権限に制限した専用tokenを使う。
D1 Read、Account Settings/Resources Read、Workers Scripts Read、R2 Read、Queues Read、
Containers Read、Pages Read、Workers KV Read、Analytics Read等、必要な各APIの現行permissionを
確認して設定する。write/edit等は一切付与しない。permission名とgrantは公開前に実物で確認する。
Tokenの実値を設定確認のために表示・取得・記録してはいけない。

## 本番化の承認対象と戻し方

既存の公式MCPをユーザー側から書き換えることはできない。ChatGPT用には独立したremote MCPと
OAuth 2.1の認証済みホストが必要。stdioを公開トンネルや認証なしWorkerで代替してはいけない。

承認後の予定:
1. 既存T-lain Workerと分離した `t-lain-cloudflare-readonly-mcp` を追加する。
2. 既存の確立されたOAuth providerを使い、利用者限定、issuer/audience/期限/scope検証とPKCEを設定。
   認証providerとclient登録は未構成。ここを先に完了し、認証なし・別利用者拒否を検証する。
3. 専用Read tokenを新WorkerのSecretへ設定（既存アプリSecretは変更しない）。
4. 上記factoryを認証後のみ利用し、今回のallowlistを固定して公開する。
5. ChatGPTに別接続として登録し、tools/schema再読込とGET→SELECTの再確認を行う。

影響: 新Worker/OAuth接続/Secret設定のみ。既存D1 schema、レコード、R2 object、既存Worker、
契約/課金設定は変更しない。通常のWorker実行・D1 read/analytics利用量は発生し得る。
戻し方: 新ChatGPT接続を無効化して旧接続へ戻し、新Workerのrouteを無効化する。
既存データ移行がないためDBのrollbackは不要。新token削除・revokeは別途承認後に行う。

## 根拠

- [公式execute実装](https://github.com/cloudflare/mcp/blob/76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1/src/tools/execute.ts)
- [公式OAuth scope preset](https://github.com/cloudflare/mcp/blob/76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1/src/auth/scopes.ts)
- [OpenAI MCP tool annotations](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI認証要件](https://developers.openai.com/plugins/build/auth)
- [D1 query API / D1 Read](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
