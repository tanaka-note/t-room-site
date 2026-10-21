# 開発・検証・公開

## Secret管理とセッション署名

各Workerの `SESSION_SECRET` はサービスごとに独立した、暗号学的乱数32 byte以上から生成した値をWrangler Secretで設定する。同じ値を複数サービスへ配布しない。生成例（出力はGit・ログ・チャットへ貼らない）:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`assets/session-secret.mjs` の共通検証は、UTF-8で32 byte未満、空白、制御文字、不正Unicode、既知の仮値、単純な繰り返しを拒否する。文字列から乱数の生成元やエントロピーは証明できないため、生成手順も必須。署名する値をtrim・変換せず、Cookie・有効期限・SESSION_VERSION・パスキーの仕様は維持する。不適切な設定ではAPIを503で停止し、署名・検証も拒否する。テストも同じ検証を通し、仮Secretを実行時に生成する。

環境ファイルは全階層でGit除外し、`*.example` のみ管理可能とする。テンプレートの `GENERATE_A_RANDOM_32_BYTE_OR_LONGER_SECRET` は検証に通らない。`npm run secrets:test` で検証とGit除外を確認する。

Wrangler 4.121.0は `secrets.required` に対応しているが、指定外のローカル環境変数を読み込まなくなるため今回は設定しない。任意Secretや既存のローカル設定を切り捨てず、別途その全体を整理してから導入する。

本番Secretは読み戻さない。新しい検証を反映する前に、各Workerの現在値が適合することを値を露出せず確認できなければデプロイを保留する。自動ローテーションはしない。設定した時点の安全な確認記録がなければローテーションを推奨し、実施にはユーザーの承認が必要。新旧Secretの併用や強度検証の迂回は追加しない。

通常は `git fetch origin main` → 既存差分を保護したbranch/worktree → 変更 → 差分verify → Preview/ローカルfixture → PRのCI確認 → main → 対象だけ公開 → build一致確認。全サービスの再調査・全テスト・全Worker deployを毎回行わない。

## 環境とコマンド

Node.js 24（`node:sqlite`使用）、pnpm 11.19.0。各Workerは独立したpackage.json/lockfileを維持する。ルートのworkspace設定へ吸い込まれないよう、そのディレクトリで次を実行する。

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false
```

依存パッケージの任意のinstall scriptを動かさず、lockfileのプラットフォーム別esbuild/workerdを利用する。CIは対象に必要なディレクトリだけinstallする。ブラウザ依存は既存の `diary-worker` のPlaywrightを共用するが、InventoryはSafari検証用に専用のPlaywright 1.64.1を固定し、他サービスの依存を更新しない。AI Workerにも既存Wrangler 4.121.0を固定するlockfileを追加した。

```sh
npm run verify:plan                     # 未commit差分の対象・コマンドを表示（実行しない）
npm run verify:changed                  # 未commitの関連テスト・Chromium・dry-run
npm run verify:changed -- --base origin/main --head HEAD
npm run verify:cloud                    # 同様に security / diary / billing / downloader / ai
npm run verify                         # 明示的な全体確認。Androidも含むため通常は使わない
node tools/verify.mjs --target cloud    # ブラウザ・buildを省いた対象テスト
node tools/verify.mjs --target android-ai-chat
```

対象表は `tools/verify-plan.mjs` 一か所。サービス内の標準回帰を選び、認証共通変更は `auth`、暗号資産変更はSecurityにも広げる。`web-apps.json` のbuild依存も参照する。削除・rename元も差分に含め、不明refは失敗する。未知のWebファイルはsiteへ回す。機能固有の試験（検索・動画デコーダなど）が必要なら既存package.jsonの追加試験を実行し、恒常的に必要なものだけprofileへ追加する。

Downloaderの通常verifyはNodeテスト・Python構文・Worker bundleまで。Container変更だけ `container-unit` を追加し、既存のローカルPython試験を実行する（ffmpeg/ClamAV等がない場合のskipは既存試験の表示に従う）。Docker image作成、定義rollout、R2実転送は行わない。ClamAVの既存3 Workflowは維持する。

Android/TWAは該当ディレクトリの変更時だけJava 21でdebug buildとunit test。SDK 36が必要。署名鍵、release build、実機/emulatorをCIへ持ち込まない。Webだけの変更でAndroid buildは走らない。

Web契約テストはOS一時ディレクトリへ現在のソースをコピーし、既存 `web-apps:sync` と `web-apps:test` を実行して生成物を検証する。元のworktreeや公開中のbuildは変更しない。この生成テストとは別に、site／diary verifyは実checkoutを変更しないfreshness checkを実行し、それぞれ`t-room-site`／`t-room-diary`に属するcontent-hash appのcommit済みmarker・updater・Service Worker・app shellが現在のhashと一致しなければCIを失敗させる。

markerを同期する場合はdeploy targetまたはapp idを必ず指定し、対象外Workerのmarkerを巻き込まない。

```sh
node tools/check-web-app-builds.mjs --target t-room-site
node tools/sync-web-app-builds.mjs --target t-room-site
```

## CIと失敗の調査

PRとmain・`codex/**`へのpushで **Verify changed services** が差分を判定し、構文→既存テスト→選択したブラウザ→dry-runを実行する。`verify` が集約結果。作業ブランチはmainとの共通祖先からの変更全体を毎回対象にするため、初回pushの全サービス実行を避け、前回のCIが中止されても未検証の変更を取りこぼさない。mainはpush前後の差分を検証し、runごとに別のconcurrency groupを使って後続pushによる中止・待機置換を防ぐ。PRはマージ結果の検証として維持する。対象差分がdocsのみなら実行対象なしで成功する。fork PRにもSecretを渡さない。PRコードを `pull_request_target` で実行しない。

ブラウザは通常Chromiumのみ（PC/タッチfixtureは維持）。必要な時だけ既存コマンドでWebKit等を追加する。共通preloadが既存Playwrightのcontextを記録し、成功時のTrace/画像は一時領域ごと削除。失敗時だけ `tmp/verify-artifacts/<test>/` のTrace ZIP・screenshot・failure.logを **verify-failure-対象** Artifactへ5日間保存する。CIの該当run → Artifactsから取得し、次で開く。

```sh
# diary-worker で実行
pnpm exec playwright show-trace /path/to/chromium-1.zip
```

Traceはローカル合成fixture専用。本番ログイン、実ユーザーデータ、秘密情報を含むブラウザ操作には有効化しない。タイムアウト/強制killでTrace未確定の場合はActionsの失敗ログを確認する。

公開サイトのCSS変更は、ローカル静的fixtureによるVisual Regressionも通す。代表11画面をPC・スマートフォンで確認し、基準画像、重要な下部領域、主要要素のcomputed style・寸法・安定した要素間距離・横スクロールを比較する。JavaScript生成UIは対象要素の生成と表示を待ってから検査する。Noto Sans JPが実際に読み込めない場合は失敗させる。本番APIは使わず、市場表示は固定fixture、外部埋め込みは遮断する。

公開サイトの`styles.css`を整理する場合は、現行の責務境界、利用ページ、JavaScript生成クラスを[`public-site-css-responsibility-map.md`](public-site-css-responsibility-map.md)で確認する。

```sh
npm run site:visual:test
```

基準の更新は、意図した表示変更をレビューした場合か、最新mainを初めて記録する場合だけ行う。差分を通す目的で自動更新しない。PowerShellでは`$env:TROOM_UPDATE_VISUALS='1'`、shでは`TROOM_UPDATE_VISUALS=1`を付けて同じコマンドを実行し、PNGとJSONを両方確認する。

## PreviewとProduction

ルートの `pnpm run build` は検索インデックスを生成した後、`site:prepare` でWranglerの配信元 `.site-assets` を作る。`tools/test-site-build.mjs` は、packages未指定の最小fixtureへのCIと同じ安全なinstall、および生成物のないcheckoutからのbuild・Wrangler dry-runを検証する。build試験は既存の依存関係を参照し、そのリンク経由で再installしない。

### Cloudflare Workers Builds（公開サイトのみ）

`t-room-site` のSettings → Buildsは次を正とする。ルートの `pnpm-workspace.yaml` はinstall許可設定用で、Workerを一括installするworkspaceではない。Cloudflare標準の `pnpm install --frozen-lockfile` は `packages field missing or empty` で停止するため、自動installを無効にし、CIと同じ指定でルートの依存関係だけを導入する。

| 設定 | 値 |
| --- | --- |
| Root directory | `/` |
| Production branch | `main` |
| Build variable `PNPM_VERSION` | `11.19.0`（CIと同じ） |
| Build variable `SKIP_DEPENDENCY_INSTALL` | `1` |
| Build command | `pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false && pnpm run build` |
| Deploy command | `node tools/check-web-app-builds.mjs --target t-room-site && npx wrangler deploy && node tools/verify-web-app-builds.mjs --target t-room-site` |
| Version command（作業ブランチ） | `node tools/check-web-app-builds.mjs --target t-room-site && npx wrangler versions upload` |

作業ブランチはversion uploadだけとし、本番trafficを切り替えない。mainへの反映はPRの対象CI成功後に行う。Build前の依存install失敗、Build失敗、公開失敗をログの工程別に区別する。Build tokenは既存のものを使い、調査・修正のために権限を拡大したり値を読み出したりしない。

設定方法は[Cloudflare Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)を参照。Cloudflare側の設定はGit管理外なので、復旧時は実画面・実ログとこの表を照合する。

横断認証・失効のHTTP E2Eは `pnpm --dir security-worker run test:revocation` で明示実行する。ローカルのSecurity／Cloud／Diary／Billing等と合成データを使い、現行のPasskey専用サービスで旧Passwordログイン・cookieを拒否する。通常のSecurity unit verifyとは別の試験で、実端末WebAuthn／PRFの確認を代替しない。

現在、安全にremote Previewへ出せるのは、DB/R2/Queue/Service Bindingを持たない公開静的サイト `t-room-site`。次のコマンドは既存のWorkerへ **versions uploadのみ**を行い、production trafficを切り替えない。URLはWrangler出力に表示される。

```sh
npm run preview
```

**Public site Preview** Workflowは対象PRでsite検証後にuploadする。`preview` GitHub Environmentに `CLOUDFLARE_PREVIEW_API_TOKEN`、変数 `CLOUDFLARE_ACCOUNT_ID` が必要。未設定ならupload未実施とJob Summaryへ明記する。ClamAV専用tokenやローカルOAuth tokenを流用・保存しない。取得したURLはActionsのJob Summaryに表示する。外部forkにはuploadしない。

Cloud/Security/Diary/Billing/AIの既存設定をそのままPreview uploadしてはいけない。同じproduction D1/R2/サービスに接続し、別ホストではWebAuthnのRP/origin条件も異なる。DownloaderはさらにContainer/DOを持つ。今回はこれらの認証設計・リソースを変更せずremote Preview対象外とし、localhost fixtureを使う。本格的stagingが必要になった時だけ専用リソース・鍵・テストIdentityを設計する。

本番はPRイベントからdeployしない。CI確認後にmainへ反映し、cleanな最新mainで以下を実行する（ローカルWranglerの通常認証を利用）。

```sh
npm run release -- cloud               # registry app id。security / diary / billing / site 等
node tools/verify-web-app-builds.mjs --target t-room-cloud
```

releaseは最新origin/main一致を確認後、CIと同じ`installDirectories()`を正本として対象verifyに必要な依存関係だけを上記の安全なpnpmオプションで導入する。その後、対象verifyと検証中のmain進行を確認し、**deploy前preflight**で同deploy targetの全content-hash appについてcommit済みmarker・updater・Service Worker・app shellをread-only検査する。不一致時はWranglerを実行せず、target限定syncコマンドを表示して停止する。preflight成功後だけ対象Workerをdeployし、既存の**post-deploy verify**で同deploy targetの全登録アプリをproductionから読み戻して照合する。Cloudのcanonicalファイルと公開runtimeコピーは`web-apps.json`の`assetCopies`を正本とし、target限定syncで自動的に一致させる。freshness検査はmarkerが一致していてもコピーの差分を拒否する。全体syncを無関係なサービスへcommitしない。

DownloaderのProductionはこのコマンドで拒否し、既存の署名・lease・reconciliation付きContainer/定義手順を使う。AIには公開Web build registryがないため既存専用手順を維持する。各Workerの従来deployコマンドも削除しない。

## GitHub Actionsからの本番自動公開

### Codex Cloudから実装・公開する

公開まで承認された依頼では、クラウド内で実装・対象verify・commit・push・PR作成を行い、対象CI成功後に接続済みGitHub連携のmerge操作でmainへ統合する。main pushの`Verify changed services`で`production (<target>)`（Containerは専用job）の成功と`Production verified`のcommit/version、および対象の公開buildを確認して完了する。PRのCI成功、mainへのpush、公開jobのskipだけでは本番反映の証拠にならない。PR作成だけの依頼ではmergeしない。

この経路のCloudflare認証はGitHubの`production` EnvironmentからActionsへ渡される。クラウドにローカルPCのWrangler OAuthや本番Secretをコピーする必要はない。Cloudflare読み取り専用MCPの権限と、GitHub Actionsの公開権限は別であり、MCPから変更できないことを本番公開全体の権限不足と混同しない。`tools/release-actions.mjs`はActions内の専用コマンドであり、クラウドのshellで`GITHUB_ACTIONS`等を偽装して実行しない。

最新mainの対象を再公開する場合、GitHub CLIが認証済みなら次を使う。接続済みGitHubツールがworkflow dispatchを提供する場合はそれでもよい。CLI・RESTの認証とGitHub連携ツールの認証は別で、連携が使えても`gh auth status`が成功するとは限らない。

```sh
gh workflow run verify.yml --repo tanaka-note/t-room-site --ref main -f production_target=site
gh run list --repo tanaka-note/t-room-site --workflow verify.yml --branch main --event workflow_dispatch --limit 5
gh run watch <run-id> --repo tanaka-note/t-room-site --exit-status
gh run view <run-id> --repo tanaka-note/t-room-site --json jobs,url,headSha,conclusion
```

`site`は依頼対象へ置き換える。dispatchのない連携でCLI認証もない場合でも、検証済み変更のmain統合による通常の自動公開は利用できる。変更のない再公開のために空commitを作らず、未提供の操作と必要な認証だけを具体的に報告する。

権限エラーは次の順で切り分ける。

| 層 | 確認・対応 |
| --- | --- |
| クラウド環境の通信 | Settings → Codex Cloud → 登録済みの対象環境 → 編集。インターネットを許可し、GitHub API、必要なCloudflare APIと公開先を許可する。パッケージマネージャーのプリセットだけではすべてのAPI・公開先を含まない。設定の公開後、新規タスクで確認する。 |
| GitHub連携 | 対象repositoryの取得・push・PR作成・mergeを確認する。GitHub Appの対象repositoryと許可が正本。shellの`gh`未認証だけで連携ツールまで使用不能と判断しない。 |
| Actions設定 | `CLOUDFLARE_PRODUCTION_ENABLED=true`、production EnvironmentのSecret/変数、main限定policy、対象jobの実行結果を確認する。Secret値を読み出さない。 |
| Cloudflare公開 | production jobの失敗stepとHTTP statusを調べる。Cloudflare APIの拒否、build不一致、CI失敗、古いmain、非version設定変更を区別する。D1/R2の認可拒否は限定tokenの正常な検査結果になり得る。 |

通常のコード公開は既存の11 Worker向け権限を使う。D1 migration、R2操作、DNS/route/Queue/Container変更、新規Worker作成はこの公開経路と別の作業であり、対象の操作に必要な権限と専用手順を確認する。クラウドへ永続認証を追加する場合は環境のNetwork secrets（HTTPS宛先限定）を使い、GitHub用とCloudflare用を分ける。ユーザーの認証・署名・復号鍵は渡さない。環境を更新しても既存タスクの保存状態は自動更新されないため、更新後は新規タスクを使う。[公式クラウド環境設定](https://learn.chatgpt.com/docs/environments/cloud-environments)を参照。

### 公開jobと認証

`Verify changed services` はmain pushの差分対象だけを検証し、集約`verify`成功後に対象Workerだけを公開する。PR・開発branch・通常の手動verifyからは本番公開しない。手動公開は同Workflowの`production_target`で1サービスを選び、branchをmainにする。手動対象にも既存の対象別CI（Securityのauth回帰、Downloader 2のNative試験等）を適用する。

初期設定はGitHubの`production` Environmentをbranch `main`だけに限定し、Environment Secret `CLOUDFLARE_API_TOKEN`とEnvironment変数`CLOUDFLARE_ACCOUNT_ID`を登録する。repository変数`CLOUDFLARE_PRODUCTION_ENABLED=true`で有効化する。無効時はCIだけ実行し、Production planに公開対象なしを明記する。失敗時は同じmainコミットのrunを再実行するか、最新mainから`production_target`を指定する。mainが進んだ古いrunは新規公開を拒否するため、失敗した対象を最新mainで明示再実行して公開漏れを解消する。

専用のaccount-owned tokenは既存の本番11 Worker（`t-room-site/cloud/security/diary/billing/downloader/downloader2/ai/inventory/health/payments`）を個別指定した`Individual Workers Editor`と、同アカウント全体の`Workers Scripts Read`を付与する。後者はWranglerがversion upload後に取得する共通`workers.dev`サブドメインの読取に必要で、個別Worker権限だけではHTTP 403/code 10000で失敗する。アップロード前にもこのAPIを検査して早期停止する。`Workers Scripts Read`は対象外Workerのmetadata/sourceの読取も許可するため、その範囲も含む権限である。アカウント管理、token管理、DNS/ルート編集、D1/R2の直接読み書き権限を追加しない。Editorには対象Workerのコード・binding・設定の変更権限があり、コード変更を通した本番データへの間接的なアクセスまで遮断する権限ではない。mainへの変更内容とCIがその境界になる。[Cloudflareの権限仕様](https://developers.cloudflare.com/workers/authorization/workers/)を参照。初期構築の専用トークンはユーザー指定により期限なしとする。漏えいの疑い・権限変更等で交換する場合は、同じ限定権限の新トークンを発行し、Environment Secretだけを差し替える。値をチャット・Git・ログ・スクリーンショットへ出さない。

既存のCloudflare Buildsによるsiteの独立した自動公開は停止し、CIを迂回する二重公開を避ける。他の10 WorkerにBuilds連携がないことも初期構築時に確認した。`Disable builds`を解除する場合はCIとの公開順序を再設計する。

通常の10 Workerは`tools/release-actions.mjs`がCIとcheckoutのSHA、最新main、clean状態、対象configのWorker名を確認する。CIと同じ`installDirectories()`で依存を準備し、siteだけ公開用assetを生成する。検証済みの同一SHAの試験を繰り返さず、既存のtarget全体のbuild freshness preflight、HealthのSecret名preflight、公開後のWeb build照合を維持する。`versions upload`の構造化出力から対象Workerの一意なversion IDを取得し、そのIDだけを100%へ昇格してAPIで読み戻す。AIはWeb registryを持たないためversionの一致を確認する。手動公開時はアカウント共通サブドメインおよび対象11 Workerのmetadata読取成功と、D1一覧・R2一覧への認可拒否（製品により401/403、success=false）も確認する。これはreadによる権限範囲の確認であり、削除API等の実行試験はしない。

この経路は既存のroutes、Custom Domains、Cron、Queue設定、Containerを変更しない。これらの非version設定やDB migrationを変更する作業は、通常コード公開と別に既存の専用手順で扱う。勝手に権限を増やしたり、未適用の設定変更を適用済みとして報告しない。ローカルの`npm run release`は従来どおり利用できる。

Downloaderは通常のversion公開から除外する。Containerディレクトリの変更と手動のDownloader指定では、CI成功後に既存の`ClamAV daily definitions`をreusable workflowとして`release_code=true`で呼ぶ。Workerだけの差分では既存専用Secretを使い、`--containers-rollout=none`でWorkerだけを更新してversionとWeb buildを照合する。Container設定・非version設定の変更はこのWorker単独経路では拒否し、手動のDownloader指定で専用公開を実行する。両経路は日次更新と同じconcurrency groupを使う。専用の既存repository Secret `CLAMAV_CLOUDFLARE_API_TOKEN`、署名・鮮度・小容量fixture・lease・job/grace保護・digest照合・Worker build確認を維持する。日次更新・独立監視は変更しない。Containerコード公開を伴うため、初期構築の動作確認だけを目的にこの高コスト経路を実行しない。利用者の本番データは検証用に作成・変更・削除しない。

## ローカルD1/R2・ログ

```sh
npm run local:dev -- cloud migrate     # security / diary / billing / ai も可
npm run local:dev -- cloud dev
npm run logs:errors -- cloud
```

local:devは `tmp/local-dev/<service>/` に本番binding/route/cron/varsを引き継がない設定を生成し、`--local` で既存migrationとローカルR2を利用する。サービス連携・本番パスキーは使えない。CRUD/権限/失敗試験には既存のCloud session-fixture、Diary permissions.e2e、SecurityのSQLite fixtureを優先する。合成データだけを使用し、本番dumpをコピーしない。既存Wranglerの `dev --local` も維持する。

既存の監査・Downloader/AI構造化ログは維持し、ログ件数やobservability設定を増やしていない。`logs:errors` はWrangler tailのerrorイベントを service / version / operation / result / timestamp に限定して出力する。request URL、ID、Cookie、Authorization、console本文、例外messageは転送しない。versionはCloudflare Version ID（build markerとは別）。deploy出力のVersion IDとcommit/buildを対応付けて調査する。本番で故意のエラーを起こさない。

## GitHubの補助機能

CodeQLはJavaScript/TypeScriptとActionsのみ、PR/main/週次。既存vendor・生成runtimeコピーを除いて二重解析を抑える。Dependabotはpnpm/npmとActionsの週次更新、minor/patchをまとめ、PR上限を設定。自動mergeは行わない。

CopilotのSemantic Indexは[リポジトリを指定した会話開始で自動作成される](https://docs.github.com/en/copilot/concepts/context/repository-indexing)。今回、認証済みGitHubでリポジトリを指定して検索を開始したが、Copilot側の検索がアクセス失敗し、Index readyは確認できなかった。Web上では公開repoの閲覧とGit/APIの取得が可能。Copilot Chatでこのrepoを選んで再試行し、継続して失敗する場合はGitHub側を確認する。CodexのGitHub connectorとCopilotのIndex共有は確認していない。Indexのためのアプリ変更・独自Index実装は行わず、最新の正確な確認はローカル `rg` を使う。

Preview仕様: [Cloudflare Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)。
