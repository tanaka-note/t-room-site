# T-lain 開発ルール

このファイルはリポジトリ全体に適用する。ユーザーの明示的な指示がある場合は、その指示を優先する。

## 1. 自律的に完了まで進める

- 実装方針が確定した後は細かな確認を繰り返さず、原則として`調査 → 実装 → テスト → 回帰テスト → ビルド → Git commit → GitHub push → 本番反映 → 可能な範囲の本番確認`まで完了する。
- Cloudflare等への本番反映は、対象サービスの通常の公開手順に含まれ、ユーザーから公開まで承認されている場合に行う。ユーザーにしか行えない認証、二段階認証、決済情報入力以外は自律的に進める。
- 次の場合だけ停止して確認する。
  - 当初の方針を大きく変更する必要がある
  - 本番データを削除・破壊する可能性がある
  - 認証、暗号化、鍵管理等のセキュリティ設計を変更する必要がある
  - ユーザーの意図を複数通りに解釈でき、結果が大きく変わる

## 2. 変更範囲と原因

- 依頼された目的に必要な箇所だけを変更し、既存UI、仕様、共通処理で判断できる場合はその方式を踏襲する。便利そうという理由だけで機能やUIを追加しない。
- 症状だけを隠さず原因を特定し、影響する既存機能を回帰テスト対象へ含める。重要または再発したバグには、可能な限り再現テストか自動テストを追加する。
- 同種の問題を変更対象外で見つけても勝手に範囲を広げず、完了報告で提案する。ユーザー体験が大きく異なる複数案がある場合だけ実装前に確認する。
- 変更対象外の既存差分を上書き、削除、コミットしない。資産運用報告の「運用手数料・雑費」は短期的には維持し、変動がある場合だけユーザーの指示に従って更新する。

## 3. 調査・検証コスト

- 品質を落とさず、変更範囲に対して必要十分な最小限の調査・検証を選ぶ。必要な安全確認と回帰確認は省略しない。
- 「念のため」だけで全リポジトリ、全Worker、全ブラウザ、高負荷E2Eを実行しない。`npm run verify:plan`や差分判定で対象を絞れる場合は優先する。
- 成功後に関連ファイルを変更していないテストを理由なく再実行しない。同じファイルや情報を読み直さず、確認済みの事実を重複調査せず、変更対象外のサービスまで広げない。
- Container、Queue、R2転送、本番ブラウザ、高負荷E2E等は、ローカル、fixture、単体試験で代替できない最小限の代表ケースだけ実行する。利用量・契約内枠を可能な範囲で確認し、追加課金を避ける。
- 外部MCP、Web、GitHub検索は必要な事実を確認できた時点で終了する。サブエージェントや大規模な並列調査は、独立して進める明確な必要性がある場合だけ使う。

## 4. Repository map

- `cloud-worker/`：T-Cloud Web／API
- `security-worker/`：Identity、Passkey、Security Center
- `diary-worker/`：日記Web／API
- `billing-worker/`：請求書管理
- `downloader-worker/`：Downloader Worker、Queue、Container
- `ai-worker/`：AI Chat API
- `site-worker/`、ルートHTML、`apps/`：公開サイトとWebアプリ
- `android-tcloud/`：T-Cloud Androidネイティブアプリ
- `android-tcloud-twa/`、`android-diary-twa/`：TWA
- `android-ai-chat/`：AI Chat Android
- `assets/`：サービス間の共通処理
- `tools/`：verify、release、build tooling
- `docs/`：設計、運用、履歴

## 5. 文書ルーティング

変更前に、対象に応じて次の正本文書を読む。AGENTS.mdへ詳細を重複させない。

- CI／test／deploy：[`docs/development-flow.md`](docs/development-flow.md)
- Identity／Passkey／T-Cloud鍵：[`docs/security/passkeys.md`](docs/security/passkeys.md)
- Password停止・復旧：[`docs/security/password-auth-policy.md`](docs/security/password-auth-policy.md)
- LINE／PWA／TWAのブラウザ挙動：[`docs/browser-support.md`](docs/browser-support.md)
- AI：[`docs/ai-chat-architecture.md`](docs/ai-chat-architecture.md)
- Downloader：[`downloader-worker/README.md`](downloader-worker/README.md)

## 6. テストと本番データ

- 実際に実行して成功したテストだけを「確認済み」「回帰テスト完了」と報告する。未実施、代替確認、skip、確認不能は区別する。
- 本番確認は実データを破壊せず、安全なfixture、テストデータ、読み取り操作を優先する。従量課金を伴う実環境テストは第3節の基準に従う。
- Secret、token、password、秘密鍵、署名鍵、復号鍵をGit、ソースコード、ログ、チャットへ保存・貼り付けしない。
- 公開前に構文確認、対象テスト、影響範囲の回帰テスト、必要なビルドを実行する。

## 7. Git・公開

- 通常は`npm run verify:plan`、`npm run verify:changed`またはサービス別verifyを使う。PRのCI／Preview、失敗Trace、ローカルD1／R2、対象限定releaseは[開発フロー](docs/development-flow.md)に従う。本番bindingを持つWorkerをそのままPreview公開しない。
- コミットには今回の依頼に関係するファイルだけを含める。調査・比較・検証用の一時ファイルはignore済み`tmp/`かOS一時ディレクトリに置き、Codexが作成した不要な一時ファイルだけを完了前に削除する。
- GitHub pushと本番反映の両方が必要なサービスでは片方だけで完了扱いにしない。変更したサービスだけを正しいtargetへ公開し、本番build一致まで確認する。
- 完了報告には変更内容、原因、実行したテストと結果、未実施の確認、公開先、commitを簡潔に記載する。

## 8. T-Cloudのセキュリティ原則

- R2保存データは原則暗号化し、復号鍵、パスワード、秘密鍵、署名鍵をCloudflare、GitHub、ログ、ソースコードへ保存しない。
- 基本方針は「基本は暗号化。表示高速化に必要な軽量データは例外。動画だけはCloudflare側に平文を見せない」。サムネイル、表示情報、メタデータ等の例外は目的に必要な最小範囲に限る。
- 動画は暗号化済みデータだけをR2へ保存し、端末側で復号する。明示的な方針変更と承認なしに、Cloudflare側で動画の復号・解析を必要とする仕組みを導入しない。
- 日記の正式写真も`diary/staging/`配下のR2 objectを参照するため、このprefixへLifecycle自動削除を設定しない。
- 認証、暗号方式、鍵管理を変更する場合は、実装前に影響と移行方法を説明して承認を得る。詳細なPasskey／T-Cloud鍵仕様は[`docs/security/passkeys.md`](docs/security/passkeys.md)を正本とする。

## 9. 共通Identity・パスキー

- 既存PW認証と各サービス固有account／role／sessionを認可の正本として維持し、共通Identityと権限を混同しない。第一管理者PWは恒久的な復旧手段として残す。
- パスキーの新規・追加・再登録は第一管理者の招待と承認を必須とする。T-Cloudは端末内だけで既存鍵を解除し、PRF出力、復号鍵、folder key、file keyをCloudflare、GitHub、ログへ渡さない。
- Security CenterをIdentity、招待、連携、監査の正本とし、失敗だけでなく成功ログインと重要な管理者アクセスも監査する。詳細は[`docs/security/passkeys.md`](docs/security/passkeys.md)に従う。

## 10. ブランド資産保護

- 明示的な変更指示がない限り、Android／TWA／PWAのランチャーアイコン、ロゴ、favicon、splash、アプリ名、ブランドカラー、キャラクターデザイン等を変更しない。
- 機能追加、バグ修正、リファクタリング、SDK対応、依存更新でも直前の正式版デザインを維持する。依頼範囲外のブランド差分があればコミット前に意図を確認する。

## 11. Web自動反映・公開先

- ユーザー向けWeb／PWA／TWAは安全に最新版へ自動更新される構成を標準とする。未保存入力、upload、download等がある間は更新を延期し、安全になってから再試行する。
- 対象アプリ、公開URL、build marker、Service Worker、deploy targetは`web-apps.json`を正とし、追加・変更時はcontract testを通す。
- 技術的理由で自動更新を適用できない場合は勝手に例外化せず、ユーザーへ説明して確認する。

## 12. 画面遷移・戻る操作

- 詳細、検索結果、フォルダ、子画面等から戻る場合は、遷移元の表示位置と表示状態を復元する。意味のある内部スクロール領域も対象とする。
- 動的リストは安定したitem ID等をアンカーにし、検索、filter、sort、表示mode、読み込み済み範囲を再現して描画後に位置を復元する。標準History／BFCache／scroll restorationで十分なら利用し、明示的な新規遷移と戻る操作を区別する。
- Password、復号鍵、秘密情報、危険操作の承認状態、意図しない再送信につながるform状態は保存しない。

## 13. 文書の維持

- AGENTS.mdには開発判断に必要な原則と文書ルーティングだけを置き、詳細仕様や過去の移行・調査記録を重複させない。
- 現行仕様は対象READMEか`docs/`の正本文書、過去の一回限りの記録は`docs/history/`へ分離する。文書を増やすこと自体を目的にしない。
