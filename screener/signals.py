# -*- coding: utf-8 -*-
"""
docs/data.json から、Googleスプレッドシート(IMPORTDATA)やモーニングブリーフで
「買い増しシグナル」を計算するための軽量CSV docs/signals.csv を生成する。

- 株価更新(update_prices.py / 平日3回)と週次スクリーニング(screen.py)の
  どちらからも、data.json を書き出した直後に build_signals_csv() を呼ぶ。
- 単体でも実行できる:  python3 screener/signals.py [data.json] [signals.csv]

列:
  code,name,sector,price,high12m,yield,score,ng_count,ng_items,in_model_pf,prices_updated_at

  high12m … 「直近1年高値」。docs/app.js の high12() と同じ定義。
            price_history.closes が3件以上あるとき max(closes[-13:])。
            （月次終値の直近13か月ぶん＝12か月前〜当月。現在値は含めない）
            条件を満たさなければ空欄。
  ng_count/ng_items … checks のうち status=="ng"(✕) の個数と、その日本語名を「／」連結。
  in_model_pf … 1/0
"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data.json"
OUT = ROOT / "docs" / "signals.csv"

HEADER = ["code", "name", "sector", "price", "high12m", "yield", "score",
          "ng_count", "ng_items", "in_model_pf", "prices_updated_at"]

# data.json の "criteria" が無い場合の予備（screen.py の CRITERIA_DEFS と同じ日本語名）
FALLBACK_CHECK_NAMES = {
    "yield": "配当利回り",
    "op_margin": "営業利益率",
    "equity_ratio": "自己資本比率",
    "current_ratio": "流動比率",
    "revenue_trend": "売上高の推移",
    "eps_trend": "EPSの推移",
    "dividend_trend": "1株配当の推移",
    "payout": "配当性向",
    "op_cf": "営業キャッシュフロー",
    "cash": "現金等",
}


def high12(stock):
    """docs/app.js の high12() と同じ計算。直近1年高値（月次終値ベース）。

      function high12(s) {
        const ph = s && s.price_history;
        if (!ph || !ph.closes || ph.closes.length < 3) return null;
        return Math.max(...ph.closes.slice(-13));
      }
    """
    ph = (stock or {}).get("price_history") or {}
    closes = ph.get("closes")
    if not closes or len(closes) < 3:
        return None
    vals = [c for c in closes[-13:] if isinstance(c, (int, float))]
    if not vals:
        return None
    return max(vals)


def check_names(data):
    """checks の id → 日本語名 の対応表を data.json の criteria から作る。"""
    names = dict(FALLBACK_CHECK_NAMES)
    for c in data.get("criteria") or []:
        cid, nm = c.get("id"), c.get("name")
        if cid and nm:
            names[cid] = nm
    return names


def _num(v):
    """数値はそのまま、Noneは空文字に。"""
    return "" if v is None else v


def build_rows(data):
    names = check_names(data)
    # data.json の criteria 順で ng_items を並べる（画面の①〜⑩の順）
    order = {c["id"]: i for i, c in enumerate(data.get("criteria") or [])
             if c.get("id")}
    updated_at = data.get("prices_updated_at") or data.get("generated_at") or ""
    rows = []
    for s in data.get("stocks") or []:
        checks = s.get("checks") or {}
        ng_ids = [cid for cid, c in checks.items()
                  if isinstance(c, dict) and c.get("status") == "ng"]
        ng_ids.sort(key=lambda cid: (order.get(cid, 99), cid))
        ng_items = "／".join(names.get(cid, cid) for cid in ng_ids)
        rows.append([
            s.get("code") or "",
            s.get("name") or "",
            s.get("sector") or "",
            _num(s.get("price")),
            _num(high12(s)),
            _num(s.get("yield")),
            _num(s.get("score")),
            len(ng_ids),
            ng_items,
            1 if s.get("in_model_pf") else 0,
            updated_at,
        ])
    rows.sort(key=lambda r: str(r[0]))
    return rows


def build_signals_csv(data_path=DATA, out_path=None, quiet=False):
    """data.json から signals.csv を生成し、簡単な検証結果をログ出力する。"""
    data_path = Path(data_path)
    if out_path is None:
        out_path = data_path.parent / "signals.csv"
    out_path = Path(out_path)
    data = json.loads(data_path.read_text(encoding="utf-8"))
    rows = build_rows(data)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8(BOMなし)・LF・カンマを含む文字列だけダブルクォート
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
        w.writerow(HEADER)
        w.writerows(rows)

    # ---- 検証 ----
    n_stocks = len(data.get("stocks") or [])
    lines = out_path.read_text(encoding="utf-8").split("\n")
    body = [ln for ln in lines if ln != ""]
    ok = True
    if not quiet:
        print(f"signals.csv: {len(rows)}行 → {out_path}")
    if len(rows) != n_stocks:
        print(f"⚠️ 行数が stocks 数と一致しません（csv={len(rows)} / stocks={n_stocks}）",
              file=sys.stderr)
        ok = False
    if body[0] != ",".join(HEADER):
        print(f"⚠️ ヘッダーが想定と違います: {body[0]}", file=sys.stderr)
        ok = False
    for col, idx in (("code", 0), ("name", 1), ("price", 3),
                     ("prices_updated_at", 10)):
        blank = sum(1 for r in rows if r[idx] == "" or r[idx] is None)
        if blank:
            print(f"⚠️ {col} が空の行が{blank}件あります", file=sys.stderr)
            ok = False
    if not quiet:
        if ok:
            with_hi = sum(1 for r in rows if r[4] != "")
            in_pf = sum(1 for r in rows if r[9] == 1)
            print(f"  検証OK: 行数={len(rows)}（stocks={n_stocks}）/ ヘッダー一致 / "
                  f"high12m あり {with_hi}件 / モデルPF {in_pf}件 / "
                  f"更新時刻 {rows[0][10] if rows else '-'}")
        else:
            print("  検証: 上の警告を確認してください")
    return out_path


def main():
    data_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DATA
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    build_signals_csv(data_path, out_path)


if __name__ == "__main__":
    main()
