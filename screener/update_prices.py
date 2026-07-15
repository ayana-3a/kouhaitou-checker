# -*- coding: utf-8 -*-
"""
docs/data.json の全銘柄の株価だけを軽量に一括更新する。
(10項目の再採点はしない。それは週次の screen.py が担当)

- yfinanceの一括ダウンロードを使うため、1700銘柄でも数分で終わる
- 株価更新に合わせて配当利回りも再計算する(1株配当額は据え置き)
"""
import datetime
import json
import sys
import warnings
from pathlib import Path

import yfinance as yf

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
        s["price"] = round(p, 1)
        updated += 1

    # GitHub ActionsランナーはUTCのため、日本時間を明示して記録する
    jst = datetime.timezone(datetime.timedelta(hours=9), "JST")
    now = datetime.datetime.now(jst).strftime("%Y-%m-%d %H:%M")
    d["prices_updated_at"] = now
    DATA.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    print(f"完了: {updated}/{len(stocks)}銘柄の株価を更新 ({now})")
    if updated < len(stocks) * 0.5:
        print("⚠️ 更新できた銘柄が半分未満です。市場休場日やアクセス制限の可能性。")
        sys.exit(1)


if __name__ == "__main__":
    main()
