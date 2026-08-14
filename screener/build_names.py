#!/usr/bin/env python3
"""東証全銘柄の「コード→銘柄名・33業種」だけの軽量マスタ docs/names.json を作る。

data.json には採点対象になった銘柄しか入らない（利回り足切り・データ取得失敗で
落ちる銘柄がある）。そのためマイPFに取り込んだ保有銘柄が「コードだけ・セクター
その他」で表示されてしまう。このマスタがあれば、採点が無い銘柄でも
最低限「銘柄名・セクター」は出せる。

    .venv/bin/python screener/build_names.py

出力は数百KBの小さなJSON。株価・財務は一切含まない（更新頻度が低くてよい）。
"""
import datetime
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "screener" / "cache"
DOCS = ROOT / "docs"


def sector_of(name: str, market: str, sector: str, code: str) -> str:
    """screen.py の eval_stock と同じセクター付けをする（表示を揃えるため）"""
    if "REIT" in market:
        return "J-REIT市場"
    if "ETF" in market:
        if any(k in name for k in ("ＲＥＩＴ", "REIT", "リート")) or code == "1343":
            return "J-REIT市場"
        return "ETF"
    if not sector or sector == "-":
        return "その他"
    return sector


def main():
    # screen.py の fetch_jpx_list() が置くキャッシュを再利用する。
    # 無ければ screen.py を一度動かすか、JPXの一覧を手で置く。
    xls = CACHE / "data_j.xls"
    if not xls.exists():
        print(f"[error] {xls} がありません。先に screener/screen.py を実行してください。",
              file=sys.stderr)
        sys.exit(1)

    df = pd.read_excel(xls, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]

    names = {}
    for _, row in df.iterrows():
        code = str(row.get("コード", "")).strip()
        if not (code.isdigit() and len(code) == 4):
            continue
        name = str(row.get("銘柄名", "")).strip()
        market = str(row.get("市場・商品区分", "")).strip()
        sector = str(row.get("33業種区分", "")).strip()
        if not name:
            continue
        names[code] = [name, sector_of(name, market, sector, code)]

    out = {
        "generated_at": datetime.date.today().isoformat(),
        "source": "JPX 東証上場銘柄一覧 (data_j.xls)",
        "names": dict(sorted(names.items())),
    }
    path = DOCS / "names.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"{len(names)}銘柄を {path} に書き出しました "
          f"({path.stat().st_size / 1024:.0f}KB)")


if __name__ == "__main__":
    main()
