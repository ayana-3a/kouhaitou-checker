# -*- coding: utf-8 -*-
"""
学長流・日本高配当株スクリーナー

東証銘柄の財務データを取得し、knowledge/学長基準.md の10項目で採点して
docs/data.json に出力する。フロントエンド (docs/) がこのJSONを表示する。

使い方:
  .venv/bin/python screener/screen.py --model-pf          # 学長モデルPF銘柄のみ(動作確認用)
  .venv/bin/python screener/screen.py --tickers 8130 2914  # 指定銘柄
  .venv/bin/python screener/screen.py --prime              # 東証プライム全銘柄(時間がかかる)
  .venv/bin/python screener/screen.py --prime --min-yield 3.0  # 利回りで足切り
"""
import argparse
import datetime
import io
import json
import math
import os
import sys
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
CACHE = ROOT / "screener" / "cache"
CACHE.mkdir(parents=True, exist_ok=True)

JPX_LIST_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"

# ---- 判定基準 (knowledge/学長基準.md 参照) ----
THRESHOLDS = {
    "yield_ok": 3.75,      # 配当利回り(%) これ以上で◯
    "yield_warn": 3.5,     # これ以上で△
    "op_margin": 10.0,     # 営業利益率(%)
    "equity_ratio": 50.0,  # 自己資本比率(%)
    "current_ratio": 200.0,  # 流動比率(%)
    "payout_low": 30.0,    # 配当性向の理想レンジ
    "payout_high": 50.0,
    "payout_max": 80.0,    # これ超は✕
}

CRITERIA_DEFS = [
    {"id": "yield", "name": "配当利回り", "desc": "税引前3.75%以上（3.5%以上で△）"},
    {"id": "op_margin", "name": "営業利益率", "desc": "10%以上（ビジネスの競争力）"},
    {"id": "equity_ratio", "name": "自己資本比率", "desc": "50%以上（財務の安定性）"},
    {"id": "current_ratio", "name": "流動比率", "desc": "200%以上（短期の資金繰り）"},
    {"id": "revenue_trend", "name": "売上高の推移", "desc": "長期的に上昇トレンド"},
    {"id": "eps_trend", "name": "EPSの推移", "desc": "上昇トレンド・赤字なし"},
    {"id": "dividend_trend", "name": "1株配当の推移", "desc": "非減配・増配傾向"},
    {"id": "payout", "name": "配当性向", "desc": "30〜50%が理想（80%超は✕）"},
    {"id": "op_cf", "name": "営業キャッシュフロー", "desc": "黒字・増加傾向"},
    {"id": "cash", "name": "現金等", "desc": "潤沢で増加傾向"},
]


def load_model_pf():
    with open(ROOT / "screener" / "model_portfolio.json", encoding="utf-8") as f:
        return json.load(f)


def fetch_jpx_list():
    """JPX公式の東証上場銘柄一覧(Excel)を取得。コード→和名/市場/33業種。"""
    cache_file = CACHE / "data_j.xls"
    if not cache_file.exists() or (
        time.time() - cache_file.stat().st_mtime > 7 * 86400
    ):
        r = requests.get(JPX_LIST_URL, timeout=60)
        r.raise_for_status()
        cache_file.write_bytes(r.content)
    df = pd.read_excel(cache_file, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def jpx_meta():
    """{code: {name, market, sector}}"""
    try:
        df = fetch_jpx_list()
    except Exception as e:
        print(f"[warn] JPX銘柄一覧の取得に失敗: {e}", file=sys.stderr)
        return {}
    meta = {}
    for _, row in df.iterrows():
        code = str(row.get("コード", "")).strip()
        if not code:
            continue
        meta[code] = {
            "name": str(row.get("銘柄名", "")).strip(),
            "market": str(row.get("市場・商品区分", "")).strip(),
            "sector": str(row.get("33業種区分", "")).strip(),
        }
    return meta


def _num(v):
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _row(df, names):
    """financial statementのDataFrameから該当行を series (古→新) で返す"""
    if df is None or df.empty:
        return None
    for n in names:
        if n in df.index:
            s = df.loc[n].dropna()
            if len(s) == 0:
                continue
            # yfinanceは新しい年が左。古→新に並べ替え
            s = s[::-1]
            return [_num(x) for x in s.values]
    return None


def _row_by_year(df, names):
    """_rowと同じだが {決算年: 値} (古→新) で返す"""
    if df is None or df.empty:
        return {}
    for n in names:
        if n in df.index:
            s = df.loc[n].dropna()
            if len(s) == 0:
                continue
            s = s[::-1]
            return {int(ts.year): _num(v) for ts, v in s.items() if _num(v) is not None}
    return {}


def _round_opt(v, nd=1):
    return round(v, nd) if v is not None else None


def price_history_monthly(t):
    """月次終値の10年推移 {start: 'YYYY-MM', closes: [...]}"""
    try:
        h = t.history(period="10y", interval="1mo", auto_adjust=False)
    except Exception:
        return None
    if h is None or h.empty or "Close" not in h:
        return None
    closes = h["Close"].dropna()
    if len(closes) < 6:
        return None
    return {
        "start": closes.index[0].strftime("%Y-%m"),
        "closes": [int(round(v)) for v in closes.values],
    }


def yield_history(divs, ph):
    """暦年ごとの配当利回り推移(%) = 年間配当 ÷ その年の平均株価"""
    if not divs or not ph:
        return []
    y0, m0 = map(int, ph["start"].split("-"))
    by_year = {}
    for i, c in enumerate(ph["closes"]):
        y = y0 + (m0 - 1 + i) // 12
        by_year.setdefault(y, []).append(c)
    out = []
    for year, dps in divs:
        closes = by_year.get(year)
        if closes and dps:
            avg = sum(closes) / len(closes)
            if avg > 0:
                out.append({"year": year, "value": round(dps / avg * 100, 2)})
    return out


def trend_status(values, allow_flat=0.95):
    """値の並び(古→新)が上昇トレンドか。ok/warn/ng"""
    if not values:
        return None, None
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return None, vals[-1] if vals else None
    first, last = vals[0], vals[-1]
    ups = sum(1 for a, b in zip(vals, vals[1:]) if b >= a * allow_flat)
    ratio = ups / (len(vals) - 1)
    if last >= first and ratio >= 0.6:
        return "ok", last
    if last >= first * allow_flat or ratio >= 0.5:
        return "warn", last
    return "ng", last


def get_dividends(t):
    try:
        div = t.dividends
    except Exception:
        return None
    if div is None or len(div) == 0:
        return None
    return div


def fix_split_glitch(div, info):
    """株式分割の直後は、Yahooのデータで最新の配当だけ分割調整されて
    いないことがある（例: 4641 アルプス技研 2026/06の3:1分割）。
    「分割から90日以内の配当」が「直前の配当の2.2倍超」なら分割係数で割って補正する。"""
    if div is None or len(div) < 2:
        return div
    try:
        split_ts = info.get("lastSplitDate")
        factor_str = str(info.get("lastSplitFactor") or "")
        if not split_ts or ":" not in factor_str:
            return div
        a, b = factor_str.split(":")
        factor = float(a) / float(b)
        if factor <= 1:
            return div
        split_date = pd.Timestamp(split_ts, unit="s", tz=div.index.tz)
        div = div.copy()
        last_idx = div.index[-1]
        if abs((last_idx - split_date).days) <= 90:
            prev = float(div.iloc[-2])
            if prev > 0 and float(div.iloc[-1]) > prev * 2.2:
                div.iloc[-1] = float(div.iloc[-1]) / factor
    except Exception:
        pass
    return div


def trailing_dps(div):
    """直近365日の1株配当合計（株式分割調整済み）"""
    if div is None or len(div) == 0:
        return None
    cutoff = pd.Timestamp.now(tz=div.index.tz) - pd.Timedelta(days=365)
    recent = div[div.index >= cutoff]
    return float(recent.sum()) if len(recent) else None


def yearly_dividends(div):
    """暦年ごとの1株配当合計 (古→新)。直近12年まで。"""
    if div is None or len(div) == 0:
        return []
    by_year = div.groupby(div.index.year).sum()
    years = sorted(by_year.index)
    cur_year = datetime.date.today().year
    # 進行中の年は配当が出揃っていないので除外
    years = [y for y in years if y < cur_year]
    return [(int(y), float(by_year[y])) for y in years][-12:]


def quick_yield_estimate(code):
    """一次スクリーニング用: infoだけ取得して概算利回り(%)を返す。
    戻り値: (status, yield, info)
      status: "ok"=取得成功 / "error"=通信失敗(レート制限等・次回再試行)"""
    info = None
    for attempt in range(2):
        try:
            info = yf.Ticker(f"{code}.T").info
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    if not info or "regularMarketPrice" not in info and "currentPrice" not in info:
        return "error", None, {}
    price = _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice"))
    dps = _num(info.get("dividendRate")) or _num(info.get("trailingAnnualDividendRate"))
    if not price or not dps:
        return "ok", None, info
    y = dps / price * 100
    return "ok", (y if 0 < y <= 25 else None), info


def eval_stock(code, meta, model_codes, info=None, held_codes=frozenset(),
               featured_codes=frozenset()):
    ticker = f"{code}.T"
    t = yf.Ticker(ticker)
    if info is None:
        try:
            info = t.info or {}
        except Exception:
            info = {}

    price = _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice"))
    m = meta.get(code, {})
    name = m.get("name") or info.get("longName") or info.get("shortName") or code
    sector = m.get("sector") or ""
    market = m.get("market") or ""
    is_etf = "ETF" in market or "REIT" in market or code in ("1343",)
    # REIT/ETFは33業種が「-」なので、わかりやすいセクター名を与える。
    # REIT指数に連動するETF(1343など)は「J-REIT市場」として扱う
    # (学長モデルPFのJ-REIT枠と同じ意味を持つため)
    if "REIT" in market:
        sector = "J-REIT市場"
    elif "ETF" in market:
        if any(k in name for k in ("ＲＥＩＴ", "REIT", "リート")):
            sector = "J-REIT市場"
        else:
            sector = "ETF"

    # 財務諸表
    try:
        inc = t.income_stmt
    except Exception:
        inc = None
    try:
        bs = t.balance_sheet
    except Exception:
        bs = None
    try:
        cf = t.cashflow
    except Exception:
        cf = None

    revenue = _row(inc, ["Total Revenue", "Operating Revenue"])
    op_income = _row(inc, ["Operating Income", "Total Operating Income As Reported"])
    eps = _row(inc, ["Diluted EPS", "Basic EPS"])
    net_income = _row(inc, ["Net Income", "Net Income Common Stockholders"])
    total_assets = _row(bs, ["Total Assets"])
    equity = _row(bs, ["Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"])
    cur_assets = _row(bs, ["Current Assets"])
    cur_liab = _row(bs, ["Current Liabilities"])
    cash = _row(bs, ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"])
    op_cf = _row(cf, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])

    # 年次の時系列 (第112回スタイルの銘柄分析グラフ用)
    rev_y = _row_by_year(inc, ["Total Revenue", "Operating Revenue"])
    opin_y = _row_by_year(inc, ["Operating Income", "Total Operating Income As Reported"])
    eps_y = _row_by_year(inc, ["Diluted EPS", "Basic EPS"])
    ni_y = _row_by_year(inc, ["Net Income", "Net Income Common Stockholders"])
    ta_y = _row_by_year(bs, ["Total Assets"])
    eq_y = _row_by_year(bs, ["Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"])
    opcf_y = _row_by_year(cf, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])
    fy_years = sorted(set(rev_y) | set(eps_y) | set(eq_y) | set(opcf_y))
    series = {
        "years": fy_years,
        "revenue_oku": [_round_opt(rev_y.get(y) / 1e8) if rev_y.get(y) is not None else None for y in fy_years],
        "op_margin": [_round_opt(opin_y[y] / rev_y[y] * 100)
                      if opin_y.get(y) is not None and rev_y.get(y) else None for y in fy_years],
        "eps": [_round_opt(eps_y.get(y)) for y in fy_years],
        "equity_ratio": [_round_opt(eq_y[y] / ta_y[y] * 100)
                         if eq_y.get(y) is not None and ta_y.get(y) else None for y in fy_years],
        "roe": [_round_opt(ni_y[y] / eq_y[y] * 100)
                if ni_y.get(y) is not None and eq_y.get(y) else None for y in fy_years],
        "op_cf_oku": [_round_opt(opcf_y.get(y) / 1e8) if opcf_y.get(y) is not None else None for y in fy_years],
    }

    # 営業CFの連続黒字年数 (取得できる範囲内)
    op_cf_streak = 0
    for v in reversed([opcf_y[y] for y in sorted(opcf_y)]):
        if v is not None and v > 0:
            op_cf_streak += 1
        else:
            break
    op_cf_years_available = len(opcf_y)

    ph = price_history_monthly(t)

    div_series = fix_split_glitch(get_dividends(t), info)
    divs = yearly_dividends(div_series)
    div_values = [v for _, v in divs]

    # --- 指標計算 ---
    # 利回りは「年間配当額(円) ÷ 株価」で計算する。
    # Yahooの予想配当(dividendRate)は株式分割後に古い値が残ることがあるため、
    # 分割調整済みの「直近1年の実績配当」とクロスチェックして異常なら実績側を使う。
    div_yield = None
    fwd = _num(info.get("dividendRate")) or _num(info.get("trailingAnnualDividendRate"))
    ttm = trailing_dps(div_series)
    dps = None
    if fwd and ttm and price:
        dps = fwd if 0.6 <= fwd / ttm <= 1.8 else ttm
    else:
        dps = fwd or ttm
    if dps and price:
        div_yield = dps / price * 100
    elif price and div_values:
        div_yield = div_values[-1] / price * 100
    else:
        dy = _num(info.get("dividendYield"))
        if dy is not None:
            div_yield = dy * 100 if dy < 1 else dy
    if div_yield is not None and not (0 <= div_yield <= 20):
        div_yield = None  # 明らかに異常な値は「データなし」扱い

    op_margin = None
    if op_income and revenue and op_income[-1] is not None and revenue[-1]:
        op_margin = op_income[-1] / revenue[-1] * 100

    equity_ratio = None
    if equity and total_assets and equity[-1] is not None and total_assets[-1]:
        equity_ratio = equity[-1] / total_assets[-1] * 100

    current_ratio = None
    if cur_assets and cur_liab and cur_assets[-1] is not None and cur_liab[-1]:
        current_ratio = cur_assets[-1] / cur_liab[-1] * 100

    payout = None
    pr = _num(info.get("payoutRatio"))
    if pr is not None:
        payout = pr * 100 if pr < 5 else pr

    pbr = _num(info.get("priceToBook"))
    per = _num(info.get("trailingPE"))
    roe = None
    if ni_y and eq_y:
        last_y = max(eq_y)
        if ni_y.get(last_y) is not None and eq_y.get(last_y):
            roe = ni_y[last_y] / eq_y[last_y] * 100
    if roe is None:
        r = _num(info.get("returnOnEquity"))
        if r is not None:
            roe = r * 100 if abs(r) < 3 else r

    # --- 判定 ---
    TH = THRESHOLDS
    checks = {}

    def put(cid, status, value, text):
        checks[cid] = {"status": status, "value": value, "text": text}

    # 1 配当利回り
    if div_yield is None:
        put("yield", None, None, "データなし")
    elif div_yield >= TH["yield_ok"]:
        put("yield", "ok", round(div_yield, 2), f"{div_yield:.2f}%")
    elif div_yield >= TH["yield_warn"]:
        put("yield", "warn", round(div_yield, 2), f"{div_yield:.2f}%")
    else:
        put("yield", "ng", round(div_yield, 2), f"{div_yield:.2f}%")

    # 2 営業利益率
    if op_margin is None:
        put("op_margin", None, None, "データなし")
    elif op_margin >= TH["op_margin"]:
        put("op_margin", "ok", round(op_margin, 1), f"{op_margin:.1f}%")
    elif op_margin >= TH["op_margin"] * 0.7:
        put("op_margin", "warn", round(op_margin, 1), f"{op_margin:.1f}%")
    else:
        put("op_margin", "ng", round(op_margin, 1), f"{op_margin:.1f}%")

    # 3 自己資本比率
    if equity_ratio is None:
        put("equity_ratio", None, None, "データなし")
    elif equity_ratio >= TH["equity_ratio"]:
        put("equity_ratio", "ok", round(equity_ratio, 1), f"{equity_ratio:.1f}%")
    elif equity_ratio >= 40:
        put("equity_ratio", "warn", round(equity_ratio, 1), f"{equity_ratio:.1f}%")
    else:
        put("equity_ratio", "ng", round(equity_ratio, 1), f"{equity_ratio:.1f}%")

    # 4 流動比率
    if current_ratio is None:
        put("current_ratio", None, None, "データなし")
    elif current_ratio >= TH["current_ratio"]:
        put("current_ratio", "ok", round(current_ratio, 0), f"{current_ratio:.0f}%")
    elif current_ratio >= 150:
        put("current_ratio", "warn", round(current_ratio, 0), f"{current_ratio:.0f}%")
    else:
        put("current_ratio", "ng", round(current_ratio, 0), f"{current_ratio:.0f}%")

    # 5 売上トレンド
    st, last = trend_status(revenue)
    put("revenue_trend", st, None, {"ok": "増加傾向", "warn": "横ばい", "ng": "減少傾向"}.get(st, "データなし"))

    # 6 EPSトレンド (赤字は問答無用でNG)
    if eps and any(v is not None and v < 0 for v in eps):
        put("eps_trend", "ng", None, "赤字あり")
    else:
        st, _ = trend_status(eps)
        put("eps_trend", st, None, {"ok": "増加傾向", "warn": "横ばい", "ng": "減少傾向"}.get(st, "データなし"))

    # 7 配当トレンド (非減配・増配)
    if len(div_values) >= 3:
        cuts = sum(1 for a, b in zip(div_values, div_values[1:]) if b < a * 0.999)
        raises = sum(1 for a, b in zip(div_values, div_values[1:]) if b > a * 1.001)
        if cuts == 0 and raises >= 1:
            put("dividend_trend", "ok", None, f"{len(div_values)}年減配なし・増配{raises}回")
        elif cuts == 0:
            put("dividend_trend", "warn", None, f"{len(div_values)}年減配なし(横ばい)")
        elif cuts == 1 and div_values[-1] >= max(div_values) * 0.9:
            put("dividend_trend", "warn", None, f"減配{cuts}回あり・現在は回復")
        else:
            put("dividend_trend", "ng", None, f"減配{cuts}回あり")
    else:
        put("dividend_trend", None, None, "配当履歴が短い")

    # 8 配当性向
    if payout is None or payout <= 0:
        put("payout", None, None, "データなし")
    elif TH["payout_low"] <= payout <= TH["payout_high"]:
        put("payout", "ok", round(payout, 1), f"{payout:.1f}%")
    elif payout <= TH["payout_max"]:
        put("payout", "warn", round(payout, 1), f"{payout:.1f}%")
    else:
        put("payout", "ng", round(payout, 1), f"{payout:.1f}%")

    # 9 営業CF
    if op_cf and any(v is not None for v in op_cf):
        if any(v is not None and v < 0 for v in op_cf):
            put("op_cf", "ng", None, "赤字の年あり")
        else:
            st, _ = trend_status(op_cf, allow_flat=0.8)
            put("op_cf", "ok" if st == "ok" else "warn", None,
                "黒字・増加傾向" if st == "ok" else "黒字")
    else:
        put("op_cf", None, None, "データなし")

    # 10 現金等
    st, _ = trend_status(cash, allow_flat=0.85)
    put("cash", st, None, {"ok": "増加傾向", "warn": "横ばい", "ng": "減少傾向"}.get(st, "データなし"))

    # スコア: ◯=1点 △=0.5点、評価不能は分母から除外して10点満点に換算
    evaluable = [c for c in checks.values() if c["status"] is not None]
    raw = sum(1.0 if c["status"] == "ok" else 0.5 if c["status"] == "warn" else 0.0 for c in evaluable)
    score = round(raw / len(evaluable) * 10, 1) if evaluable else None

    div_history = [{"year": y, "value": round(v, 2)} for y, v in divs]

    return {
        "code": code,
        "v": 2,
        "checked_at": datetime.date.today().isoformat(),
        "name": name,
        "sector": sector,
        "market": market,
        "is_etf": is_etf,
        "price": price,
        "yield": round(div_yield, 2) if div_yield is not None else None,
        "pbr": round(pbr, 2) if pbr is not None else None,
        "per": round(per, 1) if per is not None else None,
        "roe": round(roe, 1) if roe is not None else None,
        "payout": round(payout, 1) if payout is not None else None,
        "score": score,
        "in_model_pf": code in model_codes,
        "pf_held": code in held_codes,
        "pf_featured": code in featured_codes,
        "checks": checks,
        "dividend_history": div_history,
        "price_history": ph,
        "yield_history": yield_history(divs, ph),
        "series": series,
        "op_cf_streak": op_cf_streak,
        "op_cf_years_available": op_cf_years_available,
        "na_count": len(checks) - len(evaluable),
    }


def prime_universe(meta):
    return [c for c, m in meta.items()
            if "プライム" in m.get("market", "") and c.isdigit() and len(c) == 4]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-pf", action="store_true", help="学長モデルPF銘柄のみ")
    ap.add_argument("--tickers", nargs="*", default=[], help="証券コード指定")
    ap.add_argument("--prime", action="store_true", help="東証プライム全銘柄")
    ap.add_argument("--standard", action="store_true", help="スタンダードも含める")
    ap.add_argument("--funds", action="store_true", help="J-REITとETFも含める(利回り足切りなし)")
    ap.add_argument("--min-yield", type=float, default=None, help="この利回り未満は詳細分析を省略(%)")
    ap.add_argument("--limit", type=int, default=None, help="銘柄数上限(テスト用)")
    ap.add_argument("--refresh", action="store_true", help="キャッシュを使わず全銘柄を再分析")
    ap.add_argument("--out", default=str(DOCS / "data.json"))
    args = ap.parse_args()

    meta = jpx_meta()
    model = load_model_pf()
    model_codes = {s["code"] for s in model["stocks"]}
    # 「保持」銘柄 = 2025年1月以降に一度PF入りしたが現在の新規リストから外れた銘柄
    # (学長の方針: 除外≠売却。買った分はホールド)
    held_codes = frozenset(s["code"] for s in model.get("held", []))
    # 「注目株」= 直近の月次PF以降に紹介コラムで紹介された銘柄(次のPFで未採用なら外す)
    featured_codes = frozenset(s["code"] for s in model.get("featured", []))

    codes = []
    if args.tickers:
        codes += [c.strip() for c in args.tickers]
    if args.model_pf:
        codes += [s["code"] for s in model["stocks"]]
        codes += sorted(held_codes)
        codes += sorted(featured_codes)
    if args.prime:
        codes += prime_universe(meta)
    if args.standard:
        codes += [c for c, m in meta.items()
                  if "スタンダード" in m.get("market", "") and c.isdigit() and len(c) == 4]
    fund_codes = set()
    if args.funds:
        fund_codes = {c for c, m in meta.items()
                      if c.isdigit() and len(c) == 4
                      and ("ETF" in m.get("market", "") or "REIT" in m.get("market", ""))}
        codes += sorted(fund_codes)
    codes = list(dict.fromkeys(codes))  # 重複除去・順序維持
    if args.limit:
        codes = codes[: args.limit]
    if not codes:
        print("銘柄が指定されていません。--model-pf / --tickers / --prime を使ってください。")
        sys.exit(1)

    always_keep = set(args.tickers) | ((model_codes | held_codes | featured_codes) if args.model_pf else set()) | fund_codes
    infos = {}

    # --- 一次スクリーニング: 概算利回りで足切り (並列・キャッシュつき) ---
    # レート制限で失敗した銘柄は "error" としてキャッシュに残し、次回の実行で
    # 再試行する。これにより、何度か実行すれば全銘柄をカバーできる。
    if args.min_yield is not None and len(codes) > 50:
        cache_file = CACHE / "phase1_cache.json"
        p1cache = {}
        if cache_file.exists():
            try:
                p1cache = json.loads(cache_file.read_text())
            except Exception:
                p1cache = {}
        fresh_limit = time.time() - 3 * 86400  # 3日以内のキャッシュは再利用

        todo = []
        for c in codes:
            ent = p1cache.get(c)
            if ent and ent.get("status") == "ok" and ent.get("ts", 0) > fresh_limit:
                continue  # キャッシュ利用
            todo.append(c)

        print(f"一次スクリーニング: {len(codes)}銘柄中 {len(todo)}銘柄を取得"
              f"（{len(codes) - len(todo)}銘柄はキャッシュ利用）...")
        done = [0]
        errors_p1 = [0]
        lock = threading.Lock()

        def phase1(code):
            status, y, info = quick_yield_estimate(code)
            time.sleep(0.2)
            with lock:
                done[0] += 1
                p1cache[code] = {"status": status, "y": y, "ts": time.time()}
                if status == "error":
                    errors_p1[0] += 1
                if done[0] % 100 == 0:
                    print(f"  ... {done[0]}/{len(todo)} 済 (取得失敗 {errors_p1[0]})",
                          flush=True)
                    cache_file.write_text(json.dumps(p1cache))
            if status == "ok" and y is not None and y >= args.min_yield:
                return code, info
            return None

        with ThreadPoolExecutor(max_workers=4) as ex:
            for fut in as_completed([ex.submit(phase1, c) for c in todo]):
                r = fut.result()
                if r:
                    infos[r[0]] = r[1]
        cache_file.write_text(json.dumps(p1cache))

        kept_set = set()
        unresolved = 0
        for c in codes:
            ent = p1cache.get(c, {})
            if c in always_keep:
                kept_set.add(c)
            elif ent.get("status") == "ok":
                if ent.get("y") is not None and ent["y"] >= args.min_yield:
                    kept_set.add(c)
            else:
                unresolved += 1  # 取得失敗→今回は見送り(次回再試行)
        codes = [c for c in codes if c in kept_set]
        print(f"一次通過: {len(codes)}銘柄（利回り{args.min_yield}%以上）")
        if unresolved:
            print(f"⚠️ {unresolved}銘柄はレート制限等で未取得。もう一度実行すると"
                  f"続きから取得します。")
        print()

    # --- 差分更新: 3日以内に分析済みの銘柄は前回の結果を再利用 ---
    results = []
    prev_path = Path(args.out)
    if prev_path.exists() and not args.refresh:
        try:
            prev = {s["code"]: s for s in json.loads(prev_path.read_text())["stocks"]}
        except Exception:
            prev = {}
        cutoff = (datetime.date.today() - datetime.timedelta(days=3)).isoformat()
        reused = []
        rest = []
        for c in codes:
            p = prev.get(c)
            # v2形式(グラフ用時系列つき)で3日以内に分析済みのものだけ再利用
            if p and p.get("v") == 2 and p.get("checked_at", "") >= cutoff:
                p["in_model_pf"] = c in model_codes
                p["pf_held"] = c in held_codes
                p["pf_featured"] = c in featured_codes
                reused.append(p)
            else:
                rest.append(c)
        if reused:
            print(f"{len(reused)}銘柄は3日以内に分析済みのため前回結果を再利用")
            results.extend(reused)
        codes = rest

    print(f"{len(codes)}銘柄を詳細分析します...")
    errors = []
    lock = threading.Lock()
    done = [0]

    p2_workers = int(os.environ.get("SCREEN_WORKERS", "4"))
    p2_sleep = float(os.environ.get("SCREEN_SLEEP", "0.3"))

    def phase2(code):
        r = eval_stock(code, meta, model_codes, info=infos.get(code),
                       held_codes=held_codes, featured_codes=featured_codes)
        time.sleep(p2_sleep)
        return code, r

    with ThreadPoolExecutor(max_workers=p2_workers) as ex:
        futs = [ex.submit(phase2, c) for c in codes]
        for fut in as_completed(futs):
            try:
                code, r = fut.result()
                with lock:
                    done[0] += 1
                    # レート制限等でほぼ何も取れていない場合は「未分析」扱い
                    # (結果に含めず、次回の実行で再試行される)
                    if r["price"] is None and r["yield"] is None:
                        errors.append({"code": code, "error": "データ取得失敗"})
                        print(f"  [{done[0]}/{len(codes)}] {code}: 取得失敗(次回再試行)")
                        continue
                    # 詳細分析後の正確な利回りで最終足切り
                    if (args.min_yield is not None and code not in always_keep
                            and (r["yield"] is None or r["yield"] < args.min_yield)):
                        pass
                    else:
                        results.append(r)
                    print(f"  [{done[0]}/{len(codes)}] {code} {r['name']}: "
                          f"利回り{r['yield']}% スコア{r['score']}")
            except Exception as e:
                with lock:
                    done[0] += 1
                    errors.append({"error": str(e)})
                    print(f"  [{done[0]}/{len(codes)}] エラー {e}", file=sys.stderr)

    results.sort(key=lambda r: (r["score"] or 0, r["yield"] or 0), reverse=True)

    out = {
        # GitHub ActionsランナーはUTCのため、日本時間を明示して記録する
        "generated_at": datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=9), "JST")
        ).strftime("%Y-%m-%d %H:%M"),
        "criteria": CRITERIA_DEFS,
        "thresholds": THRESHOLDS,
        "model_pf": model,
        "stocks": results,
        "errors": errors,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n完了: {len(results)}銘柄 → {out_path}")


if __name__ == "__main__":
    main()
