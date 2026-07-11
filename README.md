# T-ROOM

## 学習ログ検索インデックス

学習ログ検索は Pagefind で生成しています。

記事を追加・更新したあとに、次のコマンドを実行すると `/pagefind/` の検索インデックスが更新されます。

```sh
pnpm run build
```

Cloudflare Pages で自動生成する場合は、ビルドコマンドを `pnpm run build`、公開ディレクトリを `.` にします。

検索対象は次の本文ページです。テンプレートや一覧ページは検索対象に含めません。

- `learning/sharoushi/logs/[0-9]*.html`：社労士学習ログ
- `diary/entries/[0-9]*.html`：日記

日記を追加するときは、本文を `diary/entries/` に追加し、一覧表示用の情報を `diary/diary-data.js` に追記します。日付の新しい順で自動表示され、`pnpm run build` で日記検索にも反映されます。
