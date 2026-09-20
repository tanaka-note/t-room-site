# Cloudflare読み取り専用MCP

公式 `https://mcp.cloudflare.com/mcp` の設定変更ではなく、独立した読み取り専用ツール実装。
ローカルstdioと、独立Worker用のOAuth付きHTTP実装を含む。
接続URL: `https://t-lain-cloudflare-readonly-mcp.atsushi-vip.workers.dev/mcp`。
既存ChatGPT接続には適用されていない。Secret設定と新接続の実地検証が完了するまで運用開始しない。

## 調査結果（2026-09-20）

- Codexに接続済みの公式MCPで、accounts GET、D1一覧、sqlite_master SELECT、日記schema、
  本文検索を実行できた。全てHTTP 200。SELECTは `rows_written=0` / `changed_db=false`。
  日記本文や実際の検索結果をこのリポジトリへ保存しない。
- ChromeのChatGPTでも再現確認済み。GET /accountsは200、OpenAPI検索も成功したが、
  「D1でピザを食べた日の日記を探して」ではD1一覧の段階でOpenAI安全性ブロックと表示された。
  ChatGPT側のSELECTには到達していない。拒否された呼び出しの生引数やOpenAI内部ログは取得できず、
  汎用ツール定義は要因候補だが、唯一の原因とは断定しない。
- 現在見える `execute` は `{code: string, account_id?: string}`。HTTP method enumはJSON入力schema
  そのものではなく、説明内の `cloudflare.request` 型定義。説明はGET/POST/PUT/PATCH/DELETEと
  create/update/deleteを含む。
- 公式公開ソース `cloudflare/mcp@76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1` の
  `src/tools/execute.ts` は `readOnlyHint:false`, `destructiveHint:true`, `openWorldHint:true`。
  Chromeの接続管理画面でもexecuteに「公開書き込み」「オープンワールド」「破壊的」と表示された。
  同じ公式URLからアクション再読込を完了しても定義は変わらなかった。
  接続先が同commitで動いていることや、公式MCPの生のtools/listのannotationsまでは未確認。
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
EXPLAIN、PRAGMAは全て拒否。schemaはsqlite_masterへのSELECTで確認する。
複数文、DML/DDL、文字列・識別子外のSQLコメント、extension/file/eval関数、未知構文/未知関数を拒否。
構文解析器とSQLiteの解釈差を避けるため、引用符内のbackslashも拒否し、そのような値にはparamsを使う。
文字列内のコメント記号やSQLキーワードはデータとして扱う。SQL本文は書き換えずparamsを分離して送る。
対応していない最新SQLite構文は安全側で拒否するため、分析に必要な構文は回帰試験とともに追加する。
AST検証だけで将来のSQLite拡張まで保証しない。上流のD1 Read権限を必須の独立防御として維持する。

GraphQLは構文解析で単一queryのみ許可し、accountTag/zoneTagを固定scopeと照合する。
送信先固定、redirect禁止、15秒timeout、レスポンス1MiB、返却D1 rows最大200。
Token、SQL、params、本文、rawエラーをログ出力しない。メタデータの資格情報フィールドは伏せる。

## ローカル検証

このディレクトリで `npm ci --ignore-scripts`、`npm test`、`npm run test:worker`。
テストは偽fetchと合成データだけを使用し、本番へ変更SQLや変更methodを送らない。
MCP SDKの実際のtools/list応答とtools/call経路も検証する。

2026-09-20のローカル確認: Node 108件とworkerd統合2件成功、Worker dry-run build成功。
tools/listは3ツールのみで、各tool直下のannotations.readOnlyHintがtrue（二重ネストなし）。
tools/callでGET /accounts・D1一覧・COUNT・schema SELECT・GraphQL queryの正常経路と、
変更系HTTP/SQL/GraphQLの拒否を確認した。上流はfake fetchを使用し、拒否時は呼出回数0を検証。
許可SQLは端末内のSQLiteでも実行し、schema・fixture・total_changesが不変であることを確認。
本番tokenを使用した修正版の実API試験、修正版のChrome/ChatGPT試験は未実施。
このローカル成功をChatGPTでの問題解消として扱わない。

ローカルstdioを接続する場合は `.env.example` の変数をプロセス環境へ安全に設定し、
`npm start`。この実装は.envを自動読込しない。Wranglerの既存書き込み可能tokenを流用しない。
`CF_READ_API_TOKEN` は対象accountだけのRead権限に制限した専用tokenを使う。
D1 Read、Account Settings/Resources Read、Workers Scripts Read、R2 Read、Queues Read、
Containers Read、Pages Read、Workers KV Read、Analytics Read等、必要な各APIの現行permissionを
確認して設定する。write/edit等は一切付与しない。permission名とgrantは公開前に実物で確認する。
Tokenの実値を設定確認のために表示・取得・記録してはいけない。

## 本番構成と設定

既存の公式MCPをユーザー側から書き換えることはできない。ChatGPT用には独立したremote MCPと
OAuth 2.1の認証済みホストが必要。stdioを公開トンネルや認証なしWorkerで代替してはいけない。

独立Workerと新規専用KVへの認証状態保存は承認済み。
`wrangler.jsonc`は新Workerと専用KVだけを参照し、既存D1/R2/サービスbindingを一切持たない。
Cloudflare参照用Tokenとデプロイ用認証を分離する。

- 本人認証: GitHub OAuth app `T-lain Cloudflare Read-Only MCP`（登録済み、Client Secretは未設定）。
  `read:user`のみ、固定GitHub user IDだけを許可。GitHub TokenはKVへ保存しない。
- MCP OAuth: Cloudflare公式provider、S256 PKCE、固定audience、1時間access token、30日refresh token。
  ChatGPTのコールバックのみ許可。CIMDとDCRに対応し、CSRF・ブラウザcookieとstateの照合・明示同意を必須にする。
- KV: `t-lain-cloudflare-readonly-mcp-oauth`（新規作成済み）。OAuth stateの有効期間は10分。
- D1 SELECTの対象は最小範囲として日記DBのみ。API metadataは設定済みaccount/zoneのみ。
- Workerログ/トレースとPreview URLは無効。上流redirectは追従せず3xxを拒否。

残る接続手順:
1. Cloudflareで対象アカウント限定のRead専用Tokenを作成する。作成前サマリーで
   D1、Account Settings、Account Analytics、Workers Scripts、Workers KV Storage、Workers R2 Storage、
   Cloudflare Pages、Queues、Containersが全てReadであることを確認する。
   Zone権限はtanaka-note.comのWorkers Routes Readだけ。Edit/Writeは一切付けない。
2. 新Workerの暗号化Secretとして `CF_READ_API_TOKEN` と `GITHUB_CLIENT_SECRET` を入力する。
   Secretはチャット、Git、ログへ貼り付けない。`GITHUB_CLIENT_ID`は秘密値ではなく設定済み。
3. `npm run deploy`。未設定時は認証/データ取得をfail closedにし、`GET /health`のreadyはfalseになる。
4. ChatGPTに別接続として登録し、tools/schema再読込とGET→SELECTの再確認を行う。
   GET /accounts、D1一覧、COUNT、sqlite_master、GraphQL queryをChromeで確認する。
   変更命令のChrome確認は新MCPの拒否を対象とし、上流に書き込み権限を与えない。
   新接続の合格後、読み取り用途から旧汎用execute接続を外す。現時点では旧接続を変更していない。

影響: 新Worker/専用認証KV/OAuth接続/Secret設定のみ。既存D1 schema、レコード、R2 object、既存Worker、
契約/課金設定は変更しない。通常のWorker実行・D1 read/analytics利用量は発生し得る。
戻し方: 新ChatGPT接続を無効化して旧接続へ戻し、新Workerのrouteを無効化する。
既存データ移行がないためDBのrollbackは不要。新token削除・revokeは別途承認後に行う。

## 根拠

- [公式execute実装](https://github.com/cloudflare/mcp/blob/76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1/src/tools/execute.ts)
- [公式OAuth scope preset](https://github.com/cloudflare/mcp/blob/76b19f116e53b1d6ad1c8b2c07d0d2e91a37abf1/src/auth/scopes.ts)
- [OpenAI MCP tool annotations](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI認証要件](https://developers.openai.com/plugins/build/auth)
- [D1 query API / D1 Read](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
