# 🦁 高配当株チェッカー（学長基準）

リベシティ「学長高配当株マガジン」の考え方をもとに、日本の高配当株を
10項目の基準で自動採点するアプリです。PCのブラウザでも、スマホ（ホーム画面に
追加してアプリとして）でも使えます。

> ⚠️ 本アプリは情報整理ツールであり、投資助言ではありません。
> 投資の最終判断はご自身で行ってください。

## しくみ（ぜんぶ無料）

```
[スクリーニング] screener/screen.py（Python）
   ↓ 東証銘柄の株価・財務データを取得して10項目で採点
[データ] docs/data.json
   ↓
[画面] docs/ フォルダのWebアプリ（PWA）が data.json を表示
```

- 判定基準の詳細: [knowledge/学長基準.md](knowledge/学長基準.md)
- 学長モデルポートフォリオ: [screener/model_portfolio.json](screener/model_portfolio.json)

## PCで使う

```bash
# 1. データを更新する（学長モデルPFの36銘柄）
.venv/bin/python screener/screen.py --model-pf

# 東証プライム全銘柄から探す場合（1〜2時間かかります）
.venv/bin/python screener/screen.py --prime --min-yield 3.0

# 2. アプリを表示する
python3 -m http.server 8765 --directory docs
# → ブラウザで http://localhost:8765 を開く
```

## スマホで使う（GitHub Pagesに公開）

1. GitHub（無料）にリポジトリを作り、このフォルダをプッシュ
2. リポジトリの Settings → Pages → Branch: `main` / フォルダ: `/docs` を選択
3. 表示されたURL（`https://ユーザー名.github.io/リポジトリ名/`）をスマホで開く
4. **iPhone**: Safariで共有ボタン→「ホーム画面に追加」
   **Android**: Chromeのメニュー→「アプリをインストール」

`.github/workflows/screen.yml` を有効にすると、毎週自動でデータが更新されます。

## データについて

- 株価・財務データ: Yahoo! Finance（yfinanceライブラリ経由）
- 銘柄一覧・業種: JPX（日本取引所グループ）公式の上場銘柄一覧
- 財務諸表は直近約4年分。10年以上の長期推移は各カードの「IR BANKで確認」リンクから
