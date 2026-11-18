# T-Cloud Windows

Windows 11 x64向け同期クライアントの開発基盤。選択したNTFS保存先に全原本を順次取得し、取得済み本体を平文で保持する設計。Windows Cloud Files APIとネイティブShellの互換性を合成データで検証する。

**オンライン同期アプリとしては未完成。** 運用クライアントのログイン、ファイルの通信、ユーザーのHDDへの同期ルート登録、インストーラーはまだ接続していない。別の診断画面は本人の操作時だけ現行の認証APIに接続する。実ファイルの転送・削除は行わない。

HDD本体は一時キャッシュではなく、期限なしで保持する平文のバックアップとする。保存後はログイン・復号鍵・アプリの起動を要求せず、Windowsの通常のファイルとして読む。空き容量対策等で自動的に消さない。確認済みのWeb削除を反映する仕様は維持する。2026-11-18の追加指示に従い、自動同期は初回登録後の長期端末認可で継続する。通常のWebパスキー認証の期限や画面は変更しない。Windows専用の登録・認可更新API、DPAPI登録保存、CNGによる自動更新、認可済み本体Range取得まで実装した。未公開で、実HDDの同期処理との運用接続は継続中。

全原本の保持はpinと全体取得を組み合わせ、ALWAYS_FULLで取得後の脱水を拒否する。端末専用のCNG署名鍵・DPAPI保存とWindows専用の認可APIを合成データで検査する。実HDDの同期や製品の常駐機能が完成したという意味ではない。

## 実装済み

- NTFS・固定ディスク・ボリュームGUID／シリアル・他の同期フォルダとの重複の検査。検査だけでは保存先を作成しない。
- ボリューム未接続、認証期限切れ、不完全なオンライン状態では転送・削除を保留する同期判定。
- ローカル削除をオンラインへ伝えない判定と、旧仕様のオンライン削除記録の読み込み・保存の拒否。単なるファイル不在は削除とみなさない。
- 未閲覧のファイルも原本を取得する判定と、古いオンライン削除通知の拒否。
- 更新競合と、オンライン削除に競合する未送信編集の保全判定。
- アカウント・保存先に結び付けた転送記録の原子的保存と読み戻し。Cookie、PRF、鍵を記録するフィールドは設けない。
- Web版のTRC1／AES-GCM暗号化チャンクとの相互運用と、任意位置の読み取り範囲計算。
- 既存WebのRSAフォルダ鍵、親子フォルダ鍵、ファイル鍵、暗号化ファイル情報・フォルダ名の端末内処理。Web実装との双方向の合成試験。
- 固定したR2 ETag・暗号化サイズ・HTTP範囲を確認する原本取得部と、チャンク認証後だけ内容を返す読取部。破損・版の混在・認証拒否・終了時のキャンセルを検査する。運用クライアントには未接続。
- Windows Cloud Files APIの登録・接続・プレースホルダー生成・取得コールバックを、専用の一時フォルダ内だけで実証するfixture。
- 専用fixtureで削除要求を拒否し、別プロセスからの削除でファイルが残ることを検証する。
- CNGの非抽出・復号専用RSA取り込み、既存キーの置換防止、DPAPI CurrentUserによるsession binding付きCookie保護。
- 既存Webの管理者／member用PRF envelopeとの相互運用。PRFを送信用認証応答へ含めないWindows WebAuthn接続。

## 検証

Node.js 24、.NET SDK 10、Windows x64、NTFS、CMakeとMSVC C++環境が必要。開発時はartifacts内に別途配置した公式Zig配布物も利用できる。検証スクリプトはコンパイラーを自動ダウンロードしない。

```powershell
node tools/verify-tcloud-windows.mjs
```

暗号化互換性は既存`cloud-worker/public/crypto-vault.js`を実際に呼び、両方向で検証する。鍵は実行時生成し、プロセス間の標準入出力以外へ保存・表示しない。

nativeテストはOS一時領域にランダム名の専用フォルダを作り、Windowsへ一時登録する。独立した.NETの読取プロセスで取得コールバックを発生させ、後方・先頭・チャンク境界・全体の内容をハッシュで比較する。転送範囲は4 KiB境界と論理EOFの要件に合わせる。終了時に接続・登録・専用フォルダを解除する。任意の保存先を指定できるfixture APIは設けない。プロセスの強制終了時には一時登録が残り得るため、テストを強制終了しない。

### 削除禁止とOfficeの互換性検証

次は合成ファイルだけで、削除拒否を設定した場合と設定しない場合を比較する。

```powershell
dotnet run --project tcloud-windows/tests/TCloud.Sync.Tests --configuration Release -- --compatibility-probe
```

Shellの属性と従来のコンテキストメニューをAPIで読み取り、別プロセスから削除・改名・直接書込・バックアップ先を指定したファイル置換を実行する。プロバイダー自身のI/Oは通知の対象と異なるため、別プロセスで検証する。結果はJSONで表示する。Shell拡張やユーザーのレジストリ設定は変更しない。

ローカルPCにExcelがある場合は`--office`を追加できる。専用の非表示Excelインスタンスで合成ブックを作り、CFAPIファイルを編集・保存・閉じて再度開き、値を確認する。既存ブックは開かない。CIにはOffice依存を加えない。

```powershell
dotnet run --project tcloud-windows/tests/TCloud.Sync.Tests --configuration Release -- --compatibility-probe --office
```

実機1環境では、削除拒否中も改名・直接書込・ファイル置換・Excel保存が成功した。ただしExcel保存直後には通常ファイルへ置き換わり、削除が通ることも確認した。再管理への変換で内容を保持したまま削除拒否を復旧できる。保存成功だけを削除保護の保証としない。Word・PowerPoint、常駐停止中の削除防止は未検証。

### 実パスのShellフォルダ試作

標準verifyはC++の試験用DLLをビルドし、親プロセスが一時CLSID登録と合成フォルダを管理する。通常はユーザー別登録を使い、既に管理者権限で動いているCI等では、COMがユーザー別登録を無視するため一時的にマシン別登録を使う。昇格は要求せず、両方の登録先を検査して既存CLSIDを上書きしない。独立した子プロセスが通常パス、新規通常ファイル、深い階層の削除属性・メニューを検査する。異常終了しても親が登録とフォルダを解除する。通常verifyはExplorerを開かない。

手動で実画面を検証する場合は、通常のExplorerへ影響を広げない独立した試験ウィンドウを使う。

```powershell
dotnet run --project tcloud-windows/tests/TCloud.Sync.Tests --configuration Release -- --folder-view-probe --host-view
```

このウィンドウを閉じると登録を解除する。初期試作にはExplorerを異常終了させた履歴があり、製品用Shell拡張としては未完成。修正版では実際の通常パスからWindows 11の新旧メニュー・複数選択の削除非表示と改名を確認した。上部ツールバーの削除は非活性で残る。試作の制約・未検証事項は[設計書](../docs/tcloud-windows-design.md#削除禁止とエクスプローラーの表示)を参照する。

接続済みHDDの候補パスは、次のコマンドで読み取り確認できる。

```powershell
dotnet run --project tcloud-windows/src/TCloud.Sync.Host -- inspect 'D:\T-Cloud'
```

このコマンドはフォルダ作成・マウント・フォーマットを行わない。

差分verifyは`tcloud-windows`を選び、CIは専用Windowsジョブで同じ検証を実行する。このクライアントの変更だけではWorkerを本番公開しない。

Windows Server 2025のGitHub Windows runnerでは、部分取得済み領域の非同期読み直しが`0x8007017B`で失敗する。Windowsのイベント方式のReadFileでも確認でき、実機の.NETをCIの版へ揃えただけでは再現しなかった。取得通知はネイティブポインターをコピーしてから別処理へ渡し、8MiBの復号単位を分割せず保存する。終了時は取得処理の終了を待ち、使用中のバッファを消去しない。FULL policyの3MiB／24MiB・任意位置読み取りは実機とCIで通過した。利用者の「HDD側は保存完了後に開く」という了承を受け、初期版はFULLを採用する。T-Cloud Webの表示・再生は変更しない。標準CIは運用方式を検査し、採用しないPROGRESSIVEは`--progressive-probe`による明示的な比較診断として残す。その問題を修正済みとするものではない。native試験が失敗した場合も独立したShell試験を実行し、最終結果は失敗として残す。

## 残る工程

### 本人によるパスキー互換性確認

```powershell
dotnet run --project tcloud-windows/tests/TCloud.Sync.AuthProbe --configuration Release
```

診断専用画面。起動だけでは通信せず、「パスキーで確認」で本人がWindowsの認証を行う。既存のSecurity→Cloud認証・handoffでenvelopeを端末内解除し、合成データを復号して非抽出性を確認する。検証キーを削除し、ツール自身の検証sessionをログアウトする。既存ブラウザのCookieを利用せず、ファイルの一覧・本体取得・変更は行わない。

結果はignore済み`artifacts/auth-probe-result.json`へ確認項目の成否だけを記録する。2026-11-18の実機では管理者モードで認証・端末内の既存鍵解除・非抽出性・検証sessionの終了を確認した。通常利用モードと別端末は未確認。CIはこの画面を起動・操作せず、合成fixtureとビルドだけを実行する。

認証・鍵保護と同期APIの設計は[Windows同期設計](../docs/tcloud-windows-design.md)を参照する。通常利用モードの実パスキー確認、専用APIの公開と実端末登録、実HDDへの同期統合、旧版のオンラインゴミ箱保存、常駐・インストーラーが残る。
