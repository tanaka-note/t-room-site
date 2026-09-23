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

依存パッケージの任意のinstall scriptを動かさず、lockfileのプラットフォーム別esbuild/workerdを利用する。CIは対象に必要なディレクトリだけinstallする。ブラウザ依存は既存の `diary-worker` のPlaywrightを共用する。AI Workerにも既存Wrangler 4.121.0を固定するlockfileを追加した。

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

Web契約テストはOS一時ディレクトリへ現在のソースをコピーし、既存 `web-apps:sync` と `web-apps:test` を実行して生成物を検証する。元のworktreeや公開中のbuildは変更しない。これは**公開済みbuildとの一致確認ではない**。公開時は下記の厳密な照合を行う。従来の `pnpm run web-apps:test` の厳密な挙動も変更していない。

## CIと失敗の調査

PR/main pushで **Verify changed services** が差分を判定し、構文→既存テスト→選択したブラウザ→dry-runを実行する。`verify` が集約結果。docsのみなら実行対象なしで成功する。fork PRにもSecretを渡さない。PRコードを `pull_request_target` で実行しない。

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

releaseは最新origin/main一致、対象verify、committed build marker、検証中のmain進行を確認して対象Workerだけdeployし、同deploy targetの全登録アプリの公開marker・shell・SWを照合する。markerが古ければ失敗するので、対象appのみ `syncContentHashApp`（`tools/web-app-registry.mjs`）で同期しcommitしてやり直す。Cloudのcanonicalファイルと公開runtimeコピーも既存手順どおり一致させる。全体syncを無関係なサービスへcommitしない。

DownloaderのProductionはこのコマンドで拒否し、既存の署名・lease・reconciliation付きContainer/定義手順を使う。AIには公開Web build registryがないため既存専用手順を維持する。各Workerの従来deployコマンドも削除しない。

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
