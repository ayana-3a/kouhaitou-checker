# -*- coding: utf-8 -*-
"""
EDINET API (金融庁公式) から有価証券報告書の「主要な経営指標等の推移」を取得し、
docs/data.json の銘柄に10年分の長期データ (edinetフィールド) を付加する。

有報1通には直近5期分のサマリーが入っているので、
「最新の有報」+「約5年前の有報」の2通で約10年分をカバーする。

使い方:
  export EDINET_API_KEY=xxxx  (または screener/edinet_key.txt に保存)
  .venv/bin/python screener/edinet_enrich.py            # 発掘候補+モデルPFのみ
  .venv/bin/python screener/edinet_enrich.py --all      # data.json の全銘柄
"""
import argparse
import csv
import datetime
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
CACHE = ROOT / "screener" / "cache" / "edinet"
(CACHE / "list").mkdir(parents=True, exist_ok=True)
(CACHE / "doc").mkdir(parents=True, exist_ok=True)

API = "https://api.edinet-fsa.go.jp/api/v2"
SLEEP = 0.4  # 金融庁のサーバーに優しく

# 「主要な経営指標等の推移」の要素ID (会計基準ごとの揺れに対応するフォールバック)
ELEMENTS = {
    "revenue": [
        "jpcrp_cor:NetSalesSummaryOfBusinessResults",
        "jpcrp_cor:RevenueIFRSSummaryOfBusinessResults",
        "jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults",
        "jpcrp_cor:OperatingRevenue1SummaryOfBusinessResults",
        "jpcrp_cor:OperatingRevenue2SummaryOfBusinessResults",
        "jpcrp_cor:GrossOperatingRevenueSummaryOfBusinessResults",
        "jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResultsIns",
    ],
    "ordinary_income": [
        "jpcrp_cor:OrdinaryIncomeLossSummaryOfBusinessResults",
        "jpcrp_cor:ProfitLossBeforeTaxIFRSSummaryOfBusinessResults",
    ],
    "net_income": [
        "jpcrp_cor:NetIncomeLossSummaryOfBusinessResults",
        "jpcrp_cor:ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults",
        "jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults",
    ],
    "eps": [
        "jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults",
        "jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults",
    ],
    "equity_ratio": [
        "jpcrp_cor:EquityToAssetRatioSummaryOfBusinessResults",
        "jpcrp_cor:RatioOfOwnersEquityToGrossAssetsSummaryOfBusinessResults",
        "jpcrp_cor:EquityToAssetRatioIFRSSummaryOfBusinessResults",
    ],
    "roe": [
        "jpcrp_cor:RateOfReturnOnEquitySummaryOfBusinessResults",
        "jpcrp_cor:RateOfReturnOnEquityIFRSSummaryOfBusinessResults",
    ],
    "op_cf": [
        "jpcrp_cor:NetCashProvidedByUsedInOperatingActivitiesSummaryOfBusinessResults",
        "jpcrp_cor:CashFlowsFromUsedInOperatingActivitiesIFRSSummaryOfBusinessResults",
    ],
    "dividend": [
        "jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults",
    ],
    "payout": [
        "jpcrp_cor:PayoutRatioSummaryOfBusinessResults",
        "jpcrp_cor:PayoutRatioIFRSSummaryOfBusinessResults",
    ],
}
RATIO_FIELDS = {"equity_ratio", "roe", "payout"}  # 0.5 → 50% に変換
YEN_OKU_FIELDS = {"revenue", "ordinary_income", "net_income", "op_cf"}  # 円 → 億円

CONTEXT_YEARS = {
    "CurrentYear": 0,
    "Prior1Year": 1,
    "Prior2Year": 2,
    "Prior3Year": 3,
    "Prior4Year": 4,
}


def api_key():
    k = os.environ.get("EDINET_API_KEY")
    if k:
        return k.strip()
    f = ROOT / "screener" / "edinet_key.txt"
    if f.exists():
        return f.read_text().strip()
    print("EDINET_API_KEY が見つかりません。環境変数か screener/edinet_key.txt に設定してください。")
    sys.exit(1)


def get_doc_list(date_str, key):
    """指定日の提出書類一覧 (キャッシュつき)"""
    cache_file = CACHE / "list" / f"{date_str}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())
    r = requests.get(
        f"{API}/documents.json",
        params={"date": date_str, "type": 2, "Subscription-Key": key},
        timeout=30,
    )
    time.sleep(SLEEP)
    if r.status_code != 200:
        return None
    data = r.json()
    results = [
        {
            "docID": d.get("docID"),
            "secCode": d.get("secCode"),
            "docTypeCode": d.get("docTypeCode"),
            "periodEnd": d.get("periodEnd"),
        }
        for d in (data.get("results") or [])
        if d.get("docTypeCode") == "120" and d.get("secCode")  # 有価証券報告書のみ
    ]
    cache_file.write_text(json.dumps(results, ensure_ascii=False))
    return results


def build_docid_map(start, end, key, label=""):
    """期間内の有報を {証券コード4桁: (提出日, docID, periodEnd)} で返す (最新優先)"""
    m = {}
    day = start
    n_days = (end - start).days + 1
    done = 0
    while day <= end:
        ds = day.strftime("%Y-%m-%d")
        lst = get_doc_list(ds, key)
        done += 1
        if done % 60 == 0:
            print(f"  ...{label} 書類一覧 {done}/{n_days}日分")
        if lst:
            for d in lst:
                code = str(d["secCode"])[:4]
                m[code] = (ds, d["docID"], d.get("periodEnd"))
        day += datetime.timedelta(days=1)
    return m


def fetch_doc_csv(docid, key):
    """書類のCSV版(type=5)を取得してサマリー行を返す (キャッシュつき)"""
    cache_file = CACHE / "doc" / f"{docid}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())
    r = requests.get(
        f"{API}/documents/{docid}",
        params={"type": 5, "Subscription-Key": key},
        timeout=60,
    )
    time.sleep(SLEEP)
    # 正常時のcontent-typeは application/octet-stream。
    # エラー時はJSONが返るので、ZIPとして開けるかどうかで判定する。
    if r.status_code != 200:
        cache_file.write_text("null")
        return None
    rows = []
    try:
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = [n for n in z.namelist()
                     if "jpcrp030000-asr" in n and n.endswith(".csv")]
            if not names:
                cache_file.write_text("null")
                return None
            with z.open(names[0]) as f:
                text = f.read().decode("utf-16", errors="replace")
            reader = csv.reader(io.StringIO(text), delimiter="\t")
            header = next(reader, None)
            for row in reader:
                if len(row) < 9:
                    continue
                elem, _name, ctx, _rel, consol, _pi, _unit_id, _unit, value = row[:9]
                if "SummaryOfBusinessResults" not in elem and "DEI" not in elem:
                    continue
                rows.append({"e": elem, "c": ctx, "v": value})
    except Exception:
        cache_file.write_text("null")
        return None
    cache_file.write_text(json.dumps(rows, ensure_ascii=False))
    return rows


def _num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_summary(rows, fy_end_year):
    """サマリー行 → {会計年度: {指標: 値}}。連結優先、なければ個別。"""
    if not rows:
        return {}
    out = {}
    for field, elems in ELEMENTS.items():
        for elem in elems:
            # 連結(コンテキストにMemberなし)を先に、個別(NonConsolidatedMember)を後に
            for want_nc in (False, True):
                found = {}
                for r in rows:
                    if r["e"] != elem:
                        continue
                    ctx = r["c"]
                    is_nc = "NonConsolidatedMember" in ctx
                    if is_nc != want_nc:
                        continue
                    for prefix, back in CONTEXT_YEARS.items():
                        if ctx.startswith(prefix):
                            val = _num(r["v"])
                            if val is not None:
                                found[fy_end_year - back] = val
                            break
                if found:
                    for y, v in found.items():
                        out.setdefault(y, {})[field] = v
                    break
            if any(field in d for d in out.values()):
                break
    return out


def fy_end_year(rows, fallback_period_end):
    for r in rows or []:
        if r["e"].endswith("CurrentFiscalYearEndDateDEI"):
            try:
                return int(str(r["v"])[:4])
            except ValueError:
                pass
    if fallback_period_end:
        try:
            return int(str(fallback_period_end)[:4])
        except ValueError:
            pass
    return None


def enrich_stock(code, docmaps, key):
    """銘柄コード → edinetフィールド (年次時系列)"""
    merged = {}
    for m in docmaps:
        ent = m.get(code)
        if not ent:
            continue
        _date, docid, period_end = ent
        rows = fetch_doc_csv(docid, key)
        fy = fy_end_year(rows, period_end)
        if not rows or not fy:
            continue
        for y, vals in parse_summary(rows, fy).items():
            merged.setdefault(y, {}).update(
                {k: v for k, v in vals.items() if k not in merged.get(y, {})})
    if not merged:
        return None
    years = sorted(merged)
    def col(f, conv=None):
        vals = []
        for y in years:
            v = merged[y].get(f)
            if v is not None and conv:
                v = conv(v)
            vals.append(round(v, 2) if v is not None else None)
        return vals
    return {
        "years": years,
        "revenue_oku": col("revenue", lambda v: v / 1e8),
        "ordinary_income_oku": col("ordinary_income", lambda v: v / 1e8),
        "net_income_oku": col("net_income", lambda v: v / 1e8),
        "eps": col("eps"),
        "equity_ratio": col("equity_ratio", lambda v: v * 100 if v <= 1.5 else v),
        "roe": col("roe", lambda v: v * 100 if abs(v) <= 1.5 else v),
        "op_cf_oku": col("op_cf", lambda v: v / 1e8),
        "dividend": col("dividend"),
        "payout": col("payout", lambda v: v * 100 if v <= 3 else v),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="全銘柄 (デフォルトは発掘候補+モデルPF)")
    ap.add_argument("--data", default=str(DOCS / "data.json"))
    args = ap.parse_args()
    key = api_key()

    data = json.loads(Path(args.data).read_text())
    stocks = data["stocks"]
    if args.all:
        targets = stocks
    else:
        targets = [s for s in stocks
                   if s.get("in_model_pf")
                   or ((s.get("score") or 0) >= 8 and (s.get("na_count") or 0) <= 2)]
    print(f"対象: {len(targets)}銘柄 (全{len(stocks)}銘柄中)")

    today = datetime.date.today()
    print("書類一覧を取得中 (直近13ヶ月)...")
    recent = build_docid_map(today - datetime.timedelta(days=395), today, key, "直近")
    print(f"  有報が見つかった会社: {len(recent)}社")
    print("書類一覧を取得中 (約5年前の13ヶ月)...")
    old_end = today - datetime.timedelta(days=365 * 5)
    old = build_docid_map(old_end - datetime.timedelta(days=395), old_end, key, "5年前")
    print(f"  有報が見つかった会社: {len(old)}社")

    ok = 0
    for i, s in enumerate(targets, 1):
        try:
            ed = enrich_stock(s["code"], [recent, old], key)
            if ed:
                s["edinet"] = ed
                ok += 1
            if i % 25 == 0:
                print(f"  [{i}/{len(targets)}] 取得済 {ok}")
        except Exception as e:
            print(f"  {s['code']}: エラー {e}", file=sys.stderr)

    Path(args.data).write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(f"\n完了: {ok}/{len(targets)}銘柄にEDINET10年データを付加 → {args.data}")


if __name__ == "__main__":
    main()
