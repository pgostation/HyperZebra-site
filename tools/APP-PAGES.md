# アプリ紹介ページの更新

公開先: https://pgostation.github.io/HyperZebra-site/

`catalog/apps.json` が掲載データです。編集後、リポジトリのルートで次を実行します（Python 3.9以降、追加ライブラリ不要）。

```sh
python3 tools/build-app-pages.py
```

生成された `apps/index.html`、`apps/<slug>/index.html`、`sitemap.xml` も一緒にコミットしてください。ビルドなしのGitHub Pagesでも、本文・全件リンク・構造化データがそのまま配信されます。生成HTMLは直接編集せず、JSONと生成スクリプトを編集します。

## アプリを追加する

1. 実際にHyperZebraでアプリを操作し、画面をキャプチャして `images/` に配置します。
2. JSONの既存レコードを複製し、安定した英数字の `slug`、正式名・別名、説明、実際に操作・確認した範囲、キャプチャへのパス・寸法・説明を設定します。
3. `app_version`、`checked_on`（YYYY-MM-DD）、`hyperzebra_version`、`host_os`、`machine` にその確認時の情報を記録します。`machine` には機種、CPU、メモリなどを記入します。詳細が不明な値は `null` にし、`record_note` に理由を記載してください。画像やファイルの更新日を確認日として扱わないでください。
4. `updated_on` はページの更新日です。確認日と区別します。`observed` は実際に確認した機能と問題点を記述し、起動・表示のみで「完全動作」とはしません。
5. 生成スクリプトを実行し、リンク・画像・表示を確認します。アプリを削除した場合、不要になった `apps/<slug>/` も削除してから再生成します。

初期2件は既存サイトのキャプチャを再利用しています。OSがmacOSであることは既存サイトのフッターに記載されていますが、その詳細版、マシン、アプリの版、確認日、HyperZebraの版は記録がないため未記録です。初期コミットの名前「3.0.0」は撮影時のバージョンの証拠として使用していません。

## 検索への導線

- トップページ → 一覧 → 個別ページの通常の `a href` リンク。全件をHTMLに出力し、JavaScript・検索操作・スクロール追加読み込みを必要としません。
- 個別ページごとに固定URL、固有のタイトルと説明、canonical、OGP、パンくずの構造化データ、画面のaltを出力します。未確認の版や評価は構造化データにも追加しません。
- XMLサイトマップにはすべての公開HTMLを含めます（Google所有権確認ファイルを除く）。確認日が不明なレコードを最新の動作確認と誤認させないよう、sitemapにも推測のlastmodを付けません。
- 公開URLを変更する場合は生成スクリプトの `BASE` とトップページのcanonicalを更新します。
- 公開後にGoogle Search Consoleで `https://pgostation.github.io/HyperZebra-site/sitemap.xml` を送信してください。この作業では公開・Search Consoleへの送信は行っていません。サイトマップや内部リンクは発見を助けますが、掲載や順位を保証するものではありません。

参考: https://developers.google.com/search/docs/crawling-indexing/links-crawlable
