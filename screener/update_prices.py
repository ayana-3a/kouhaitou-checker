# -*- coding: utf-8 -*-
"""
docs/data.json の全銘柄の株価だけを軽量に一括更新する。
(財務10項目の再取得はしない。それは週次の screen.py が担当)

- yfinanceの一括ダウンロードを使うため、1700銘柄でも数分で終わる
- 株価更新に合わせて配当利回りも再計算する(1株配当額は据え置き)
- 利回りが変われば「①配当利回り」の◯△✕判定とスコアも作り直す
  (以前は利回りの数字だけ更新して判定を放置していたため、表示利回りと
   判定がズレたまま順位が古い値で固定される不具合があった)
"""
import datetime
import json
import sys
import warnings
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from screen import compute_score, na_count, yield_check  # noqa: E402

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data.json"
BATCH = 200


def main():
    d = json.loads(DATA.read_text())
    stocks = d["stocks"]
    codes = [s["code"] for s in stocks]
    print(f"{len(codes)}銘柄の株価を更新します...")

    prices = {}
    for i in range(0, len(codes), BATCH):
        batch = codes[i:i + BATCH]
        tickers = " ".join(c + ".T" for c in batch)
        try:
            df = yf.download(tickers, period="5d", interval="1d",
                             group_by="ticker", threads=True,
                             progress=False, auto_adjust=False)
        except Exception as e:
            print(f"  バッチ{i // BATCH + 1}: 取得失敗 {e}", file=sys.stderr)
            continue
        for c in batch:
            try:
                closes = df[c + ".T"]["Close"].dropna()
                if len(closes):
                    prices[c] = float(closes.iloc[-1])
            except Exception:
                pass
        print(f"  {min(i + BATCH, len(codes))}/{len(codes)} 済 (取得 {len(prices)})")

    updated = 0
    rescored = 0
    for s in stocks:
        p = prices.get(s["code"])
        if p is None or p <= 0:
            continue
        old_price = s.get("price")
        old_yield = s.get("yield")
        # 1株配当額を据え置いて利回りを再計算
        if old_price and old_yield is not None:
            dps = old_yield * old_price / 100
            s["yield"] = round(dps / p * 100, 2)
            # 利回りが動いたら①の判定とスコアも作り直す
            checks = s.get("checks")
            if checks:
                before = checks.get("yield", {}).get("status")
                checks["yield"] = yield_check(s["yield"])
                s["score"] = compute_score(checks)
                s["na_count"] = na_count(checks)
                if checks["yield"]["status"] != before:
                    rescored += 1
        s["price"] = round(p, 1)
        updated += 1

    # スコアが変わるので並び順も作り直す（screen.py と同じ基準）
    stocks.sort(key=lambda r: (r.get("score") or 0, r.get("yield") or 0), reverse=True)
    d["stocks"] = stocks

    # GitHub ActionsランナーはUTCのため、日本時間を明示して記録する
    jst = datetime.timezone(datetime.timedelta(hours=9), "JST")
    now = datetime.datetime.now(jst).strftime("%Y-%m-%d %H:%M")
    d["prices_updated_at"] = now
    DATA.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    print(f"完了: {updated}/{len(stocks)}銘柄の株価を更新 ({now})")
    print(f"  うち{rescored}銘柄は配当利回りの判定(◯△✕)が変わりました")
    if updated < len(stocks) * 0.5:
        print("⚠️ 更新できた銘柄が半分未満です。市場休場日やアクセス制限の可能性。")
        sys.exit(1)


if __name__ == "__main__":
    main()
