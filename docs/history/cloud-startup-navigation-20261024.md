# T-Cloudの起動・フォルダ復帰の改善（2026-10-24）

PR #106で戻した版を基準に、同じ起動内の重複通信とフォルダ復元の通信往復を減らす。認証・暗号方式・鍵保存・本番データの変更はない。

- キャッシュで再開するとき、`initialize()` が検証に使った鍵設定を同じsession objectに結び付け、`prepareCryptoSession()` へ渡す。対象sessionと一致する検証済み鍵キャッシュがある場合だけ再利用し、別session・設定未渡し・新規ログインでは従来どおり設定APIを取得する。cache bindingとセッションの再確認は維持する。
- 通常フォルダの保存済み範囲は500件ずつ再取得する。初回32件・背景64件・検索250件・起点が移動／削除された場合の1回250件の追加探索は維持する。読み込み済み件数・sort・表示位置の復元を省略しない。
- 新しい読み込み世代の一覧は、カードをDocumentFragmentでまとめて挿入する。同じ世代の並べ替えでは既存カードを維持し、世代が変わった場合は古いイベントハンドラーを引き継がない。

## Android Chromeの戻る操作

ユーザー報告は、左端から戻ると前のフォルダが一瞬映り、右端から戻る場合は映らない、というもの。希望は右端と同じ動きで、アニメーションは不要。

[Chromiumの実装](https://raw.githubusercontent.com/chromium/chromium/main/content/public/browser/back_forward_transition_animation_manager.cc)には、通常の左から右へ読むUIで、左端からの戻るはアニメーション対象、右端からの戻るは対象外にする分岐がある。Chromeは[履歴画像を使うネイティブの描画](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/navigation_transitions/back_forward_transition_animator.cc)を行う。T-Cloudにはフォルダ移動の横スライド処理はない。

Chromeのプレビューとアプリの非同期描画のずれが映り込みに関係する可能性はあるが、端末の直接再現は未完了。今回の変更を「Chromeの左端アニメーション停止」や「スワイプの映り込み解消」とは扱わない。サイトから左端だけ無効化する正式な制御も確認できていない。画面全体を隠すCSSや、戻る・履歴を止める処理は追加しない。

## 比較試作の結果と検証方針

変更前の調査用fixtureでは、APIごと300ms待ちの条件で起動が1,279.4ms→960.6ms、1,056件へのBackが2,596.5ms→1,958.6msとなった。前者は通信4回→3回、後者は6回→4回。WindowsのChromium／スマホ幅、各3回の中央値で、Android実機の測定ではない。永続鍵cache I/O等をstubした起動試作の結果を本番の保証値とはしない。

新しい検査は以下を既存のCloud回帰経路へ追加する。

- admin/memberの同一session設定再利用、別session・binding不一致・設定変更・失効・途中のsession切替での鍵採用拒否。
- 実WebCrypto／IndexedDBを使ったadmin/member再開で鍵設定API1回、キャッシュ不一致・未保存でPRF経路へ戻り、非認証sessionでは鍵設定も一覧も取得しないこと。
- 通常フォルダの取得回数削減と、検索・追加探索の250件上限、移動・削除後の起点・位置・権限拒否の維持。
- 新しい世代の1,056カードを1回の接続で挿入し、順序・世代間のハンドラー分離・同世代のカード再利用を維持すること。

Android実機の左右スワイプ、途中キャンセル、連続した戻るの確認は引き続き必要。プログラムのBack/Forward試験だけでネイティブジェスチャー確認済みとはしない。

## ローカル検証結果

- Cloud標準Node回帰・構文検査、設定再利用の追加10ケース、旧起動契約テスト：成功。
- ChromiumのPC／touchでfolder-scroll-position（範囲・検索・階層・連続移動・権限拒否・navigation reviewを含む）：成功。startup securityは各deviceで125 cache/transport・22復元・1 root fallback条件が成功。
- 実WebCrypto／IndexedDBを使う追加の起動10ケース、一覧の分離・世代境界・1,056カード一括挿入のブラウザ試験：成功。
- Cloud build freshness、Wrangler dry-run、差分検査：成功。buildは `cloud-7960067ed15c`。

実機Android、本番データでの計測、マージ、本番公開は未実施。
