# U-NEXT Ratings

U-NEXTの作品詳細ページにFilmarksのレビュースコアを表示するChrome拡張機能。

## 構成

- `manifest.json` — Manifest V3 拡張機能定義
- `content.js` — U-NEXTページにバッジを注入するコンテンツスクリプト
- `background.js` — Filmarks検索・スクレイピング用Service Worker
- `styles.css` — バッジのスタイル

## アーキテクチャ

1. `content.js` がU-NEXTのページタイトルから作品名を抽出
2. `chrome.runtime.sendMessage` でbackgroundにFilmarks検索を依頼
3. `background.js` が `filmarks.com/search/movies` をfetchしHTMLパース
4. 結果をコンテンツスクリプトに返し、タイトル要素の直後にバッジ表示

SPAナビゲーション対応: MutationObserver + pushState/replaceState フック + popstate

## 開発

ビルドツール不要。`chrome://extensions` でディレクトリを読み込むだけ。

## 注意点

- FilmarksのHTML構造に依存（スクレイピング）。サイト変更で壊れる可能性あり
- U-NEXTのSPAルーティングに合わせたデバウンス処理（500ms）
- リンククリックはU-NEXTのイベントハンドラを回避するためbackground経由で開く
