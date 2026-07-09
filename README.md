# T-ROOM

## 学習ログ検索インデックス

学習ログ検索は Pagefind で生成しています。

記事を追加・更新したあとに、次のコマンドを実行すると `/pagefind/` の検索インデックスが更新されます。

```sh
pnpm run build
```

Cloudflare Pages で自動生成する場合は、ビルドコマンドを `pnpm run build`、公開ディレクトリを `.` にします。

検索対象は `learning/sharoushi/logs/[0-9]*.html` の学習ログ記事です。テンプレートや一覧ページは検索対象に含めません。
