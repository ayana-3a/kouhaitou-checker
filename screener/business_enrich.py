# -*- coding: utf-8 -*-
"""
EDINET の有価証券報告書「事業の内容」テキストブロックから、
各銘柄の「代表的な事業」を表す短い一文（全角60〜90字程度）を機械生成し、
docs/data.json の各銘柄に business フィールドとして付加する。

- 通常銘柄: 有報の DescriptionOfBusinessTextBlock を整形（冒頭の事業説明文を抽出）
- ETF / J-REIT: 有報が無いため、銘柄名・セクターから種別説明を機械生成
- キャッシュ優先・差分のみ取得（biz/{docID}.json）。edinet_enrich.py の
  書類一覧キャッシュ・API連携をそのまま流用し、新しい外部依存は増やさない。

使い方:
  export EDINET_API_KEY=xxxx  (または screener/edinet_key.txt に保存)
  .venv/bin/python screener/business_enrich.py            # 全銘柄
  .venv/bin/python screener/business_enrich.py --limit 50 # 動作確認用
"""
import argparse
import csv
import datetime
import html
import io
import json
import re
import sys
import time
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import edinet_enrich as ee  # api_key / build_docid_map / 書類一覧キャッシュを流用

ROOT = ee.ROOT
DOCS = ee.DOCS
BIZ_CACHE = ee.CACHE / "biz"
BIZ_CACHE.mkdir(parents=True, exist_ok=True)
FOUNDING_CACHE = ee.CACHE / "founding"
FOUNDING_CACHE.mkdir(parents=True, exist_ok=True)

API = ee.API
SLEEP = ee.SLEEP

MAX_CHARS = 85  # 説明文の最大長（data.json 肥大化防止）

# ---------------------------------------------------------------------------
# 有報「事業の内容」テキストの取得（docID 単位でキャッシュ）
# ---------------------------------------------------------------------------
BIZ_ELEM = "jpcrp_cor:DescriptionOfBusinessTextBlock"


def fetch_business_text(docid, key):
    """有報の「事業の内容」テキストブロックを返す（キャッシュつき）。"""
    cache_file = BIZ_CACHE / f"{docid}.json"
    if cache_file.exists():
        v = json.loads(cache_file.read_text())
        return v if v else None
    r = requests.get(
        f"{API}/documents/{docid}",
        params={"type": 5, "Subscription-Key": key},
        timeout=60,
    )
    time.sleep(SLEEP)
    if r.status_code != 200:
        cache_file.write_text("null")
        return None
    text = None
    try:
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = [n for n in z.namelist()
                     if "jpcrp030000-asr" in n and n.endswith(".csv")]
            if not names:
                cache_file.write_text("null")
                return None
            with z.open(names[0]) as f:
                body = f.read().decode("utf-16", errors="replace")
            reader = csv.reader(io.StringIO(body), delimiter="\t")
            next(reader, None)
            for row in reader:
                if len(row) >= 9 and row[0] == BIZ_ELEM:
                    text = row[8]
                    break
    except Exception:
        cache_file.write_text("null")
        return None
    cache_file.write_text(json.dumps(text, ensure_ascii=False))
    return text


# ---------------------------------------------------------------------------
# 有報「沿革」テキストブロックから設立/創業年を抽出（docID 単位でキャッシュ）
#
# 学長流の「おじいちゃん企業（長寿企業＝安定の参考情報）」判定用の参考データ。
# スコア・バッジ・シグナルには一切影響させない純粋な参考情報。
# ---------------------------------------------------------------------------
HIST_ELEM = "jpcrp_cor:CompanyHistoryTextBlock"

_Z2H = str.maketrans("０１２３４５６７８９", "0123456789")
_ERA = {"明治": 1868, "大正": 1912, "昭和": 1926, "平成": 1989, "令和": 2019}
_ERA_RE = re.compile(r"(明治|大正|昭和|平成|令和)(元|\d{1,2})年")
# 「1948年」のほか表形式で使われる「1948．9」（全角ピリオド区切り）にも対応
_YEAR_RE = re.compile(r"(\d{4})[年．]")


def _to_seireki(m):
    """和暦（明治35年 等）を西暦に変換。"""
    base = _ERA[m.group(1)]
    n = 1 if m.group(2) == "元" else int(m.group(2))
    return f"{base + n - 1}年"


def extract_founding(text):
    """沿革テキスト → ("設立"|"創業", 西暦年) or None。

    沿革は年代順に並ぶため、各「YYYY年」の直後の説明文（次の年号まで、最大60字）を
    見て「設立/創立」「創業」を含む最古の年を採る。「会社設立」を基本としつつ、
    より古い「創業」があればそちらを優先表示する（事業の歴史の長さが本質のため）。
    他社設立の記述（例:「◯◯株式会社を設立」）は通常より新しい年に現れるため、
    最古を採ることで自社の設立年が選ばれやすい。
    """
    if not text:
        return None
    t = text.translate(_Z2H)
    t = _ERA_RE.sub(_to_seireki, t)  # 和暦→西暦に正規化
    ms = [m for m in _YEAR_RE.finditer(t) if 1800 <= int(m.group(1)) <= 2100]
    if not ms:
        return None
    # 表形式の沿革がHTML→テキスト化で「年月列→概要列」の順に潰れる場合がある
    # （年号が連続で並び、説明文が最後にまとまる）。この場合は年と説明文の対応が
    # 取れないため、「最古の年」を採用し、説明文冒頭のキーワードで種別を決める。
    if len(ms) >= 5:
        gaps = [ms[i + 1].start() - ms[i].end() for i in range(len(ms) - 1)]
        if sum(1 for g in gaps if g <= 4) > len(gaps) * 0.6:
            # 概要列の先頭（＝最初の行の説明＝設立/創業の記述）に最初に現れる
            # キーワードで種別を決め、年は最古の年を採用する
            oldest = min(int(m.group(1)) for m in ms)
            _sous = [p for p in (t.find("創業"), t.find("創設")) if p >= 0]
            p_sou = min(_sous) if _sous else -1
            _ests = [p for p in (t.find("設立"), t.find("創立")) if p >= 0]
            p_est = min(_ests) if _ests else -1
            if p_sou < 0 and p_est < 0:
                return None
            kind = "創業" if (p_sou >= 0 and (p_est < 0 or p_sou <= p_est)) else "設立"
            return (kind, oldest)
    estab = None    # 設立/創立 の最古年
    sougyou = None   # 創業 の最古年
    for i, m in enumerate(ms):
        y = int(m.group(1))
        if i + 1 < len(ms):
            # 内側の年は「次の年号まで」を1イベントとみなす（設立文が長い会社に対応）
            seg = t[m.end():ms[i + 1].start()]
        else:
            # 最終イベントは後続の長文を巻き込まないよう120字で打ち切り
            seg = t[m.end():m.end() + 120]
        if ("設立" in seg or "創立" in seg) and (estab is None or y < estab):
            estab = y
        if ("創業" in seg or "創設" in seg) and (sougyou is None or y < sougyou):
            sougyou = y
    if estab is None and sougyou is None:
        return None
    # 創業がより古ければ創業を優先（学長的には事業の歴史の長さが本質）
    if sougyou is not None and (estab is None or sougyou < estab):
        return ("創業", sougyou)
    if estab is not None:
        return ("設立", estab)
    return ("創業", sougyou)


def fetch_founding(docid, key):
    """有報「沿革」から設立/創業を抽出して返す（キャッシュつき）。

    返り値: {"kind": "設立"|"創業", "year": int} または None。
    """
    cache_file = FOUNDING_CACHE / f"{docid}.json"
    if cache_file.exists():
        v = json.loads(cache_file.read_text())
        return v if v else None
    r = requests.get(
        f"{API}/documents/{docid}",
        params={"type": 5, "Subscription-Key": key},
        timeout=60,
    )
    time.sleep(SLEEP)
    if r.status_code != 200:
        cache_file.write_text("null")
        return None
    hist = None
    try:
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = [n for n in z.namelist()
                     if "jpcrp030000-asr" in n and n.endswith(".csv")]
            if not names:
                cache_file.write_text("null")
                return None
            with z.open(names[0]) as f:
                body = f.read().decode("utf-16", errors="replace")
            reader = csv.reader(io.StringIO(body), delimiter="\t")
            next(reader, None)
            for row in reader:
                if len(row) >= 9 and row[0] == HIST_ELEM:
                    hist = row[8]
                    break
    except Exception:
        cache_file.write_text("null")
        return None
    res = extract_founding(hist)
    out = {"kind": res[0], "year": res[1]} if res else None
    cache_file.write_text(json.dumps(out, ensure_ascii=False))
    return out


# ---------------------------------------------------------------------------
# 「事業の内容」長文 → 60〜90字程度の平易な一文
# ---------------------------------------------------------------------------
HEADER_RE = re.compile(r'^[\s　]*[0-9０-９]+[\s　]*【事業の内容】[\s　]*')
POINTER = ('参照', '同様です', '同様であり', '記載のとおり', 'とおりです', 'とおりであり',
           'をご覧', '掲げるセグメント', '区分と同様', '変更はありません', '変更ありません')
COMP_ONLY_RE = re.compile(r'構成され(?:ています|ております|ている|た)。?\s*$')
TABLE_MARK = ('会社名', '主要な連結子会社', '主要な持分法', 'セグメントの名称',
              '報告セグメント', '事業系統図', '（注）', 'セグメント情報')
BIZ = ('行って', '行なって', '営んで', '展開', '従事', '手掛け', '手がけ', '提供',
       '製造', '販売', 'サービス', '開発', '運営', '内容として', 'としています',
       'としており', 'を主たる', 'を主な', '事業とし')
COMP_RE = re.compile(
    r'^[^。]{0,80}?(?:構成|から成る|から構成|によって(?:構成|形成)|により推進)[^、。]{0,20}?、')
COMP_RE2 = re.compile(
    r'^[^。]{0,80}?(?:子会社|関係会社|関連会社)[^。]{0,30}?(?:においては|において)、')


DEF_PAREN_RE = re.compile(r'[（(]以下[^（）()]*?[）)]')      # （以下、「○○」といいます。）
DATE_PAREN_RE = re.compile(r'[（(][^（）()]*?現在[）)]')       # （2025年３月31日現在）


def _normalize(t):
    t = html.unescape(t)
    # 文中に「。」を持ち込む定義括弧・日付括弧を除去（誤った文分割を防ぐ）
    t = DEF_PAREN_RE.sub('', t)
    t = DATE_PAREN_RE.sub('', t)
    t = t.replace('　', ' ').replace('\r', ' ').replace('\n', ' ')
    t = re.sub(r'[ \t]+', ' ', t).strip()
    return t


def _split_sentences(t):
    return [s.strip() for s in re.split(r'(?<=。)', t) if s.strip()]


def _is_table(s):
    core = s.rstrip('。').strip()
    if any(h in s for h in TABLE_MARK):
        return True
    if len(core) >= 50 and core.count('、') == 0:
        return True
    if re.search(r'[A-Za-z0-9]{25,}', core.replace(' ', '')):
        return True
    return False


def _strip_comp(s):
    for rgx in (COMP_RE, COMP_RE2):
        m = rgx.match(s)
        if m:
            rest = s[m.end():].strip('、 ')
            if len(rest) >= 12:
                s = rest
    return s


def summarize(raw, max_chars=MAX_CHARS):
    """有報「事業の内容」テキスト → 代表的な事業を表す一文（取れなければ None）。"""
    if not raw:
        return None
    t = _normalize(HEADER_RE.sub('', raw))
    if not t:
        return None
    cands = []
    for s in _split_sentences(t):
        s = s.lstrip('）)」』】、, ')  # 括弧内「。」で割れた断片の先頭の閉じ括弧を除去
        if not s:
            continue
        if any(p in s for p in POINTER):
            continue
        if 'IFRS' in s or '連結財務諸表を作成' in s:
            continue
        if _is_table(s):
            continue
        if s.count('株式会社') + s.count('㈱') >= 3:  # 子会社名の羅列文
            continue
        if COMP_ONLY_RE.search(s) and '事業' not in s and '業務' not in s:
            continue  # 「○社により構成されています。」だけの構成説明文
        cands.append(s)
    chosen = next((s for s in cands if any(b in s for b in BIZ)), None)
    if chosen is None:
        return None
    chosen = _strip_comp(chosen).strip('、 ')
    if len(chosen) < 10:
        return None
    if len(chosen) > max_chars:
        cut = chosen[:max_chars]
        m = max(cut.rfind('、'), cut.rfind('・'), cut.rfind('）'))
        if m >= max_chars - 30:
            cut = cut[:m]
        chosen = cut.rstrip('、・（(「 ') + '…'
    return chosen


# ---------------------------------------------------------------------------
# ETF / J-REIT: 銘柄名・セクターから種別説明を機械生成
# ---------------------------------------------------------------------------
def _norm_name(name):
    """全角英数を半角化して判定しやすくする。"""
    return (name or "").translate(str.maketrans(
        "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
        "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ"
        "０１２３４５６７８９＆",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz"
        "0123456789&")).upper()


def etf_description(stock):
    name = stock.get("name") or ""
    n = _norm_name(name)
    sector = stock.get("sector") or ""

    # --- J-REIT ---
    if sector == "J-REIT市場" or "投資法人" in name:
        if "投資法人" in name:  # 個別REIT銘柄
            for kw, desc in (
                (("レジデンシャル", "住宅", "レジデンス"), "賃貸住宅（レジデンス）を中心に投資する上場REIT（不動産投資信託）。"),
                (("物流", "ロジ", "ロジスティ"), "物流施設を中心に投資する上場REIT（不動産投資信託）。"),
                (("ホテル", "ホスピタリティ"), "ホテル・宿泊施設を中心に投資する上場REIT（不動産投資信託）。"),
                (("ヘルスケア", "メディカル"), "ヘルスケア施設を中心に投資する上場REIT（不動産投資信託）。"),
                (("インフラ", "エネルギー", "リニューアブル"), "太陽光発電などインフラ施設に投資する上場インフラファンド。"),
                (("オフィス",), "オフィスビルを中心に投資する上場REIT（不動産投資信託）。"),
                (("商業", "リテール"), "商業施設を中心に投資する上場REIT（不動産投資信託）。"),
            ):
                if any(k in name for k in kw):
                    return desc
            return "オフィスや商業施設など不動産に投資する上場REIT（不動産投資信託）。"
        # J-REIT指数連動型のETF
        return "不動産投信（REIT）の指数に連動する上場投資信託（ETF）。"

    # --- ETF / ETN ---
    is_etn = "ETN" in n or "NOTES" in n
    kind = "上場投資証券（ETN）" if is_etn else "上場投資信託（ETF）"

    # 資産クラス／対象の判定（上から優先）
    asset = None
    if any(k in name for k in ("純金", "金上場", "ゴールド")) or "GOLD" in n:
        asset = "金（ゴールド）の価格"
    elif any(k in name for k in ("銀上場", "プラチナ", "パラジウム")):
        asset = "貴金属の価格"
    elif "原油" in name or "WTI" in n or "天然ガス" in name:
        asset = "エネルギー商品の価格"
    elif any(k in name for k in ("銅", "農産物", "小麦", "コーン", "商品指数")) or "BROAD" in n:
        asset = "商品（コモディティ）指数"
    elif any(k in name for k in ("国債", "社債", "債券", "ハイイールド")) or "BOND" in n:
        asset = "債券の指数"
    elif "REIT" in n or "リート" in name or "不動産" in name:
        asset = "不動産投信（REIT）の指数"
    elif any(k in name for k in ("高配当", "配当フォーカス", "配当貴族", "好配当")):
        asset = "高配当株の指数"
    elif "半導体" in name:
        asset = "半導体関連株の指数"
    elif "日本株" in name or "国内株" in name or "日本高配当" in name:
        # 「グローバルＸ　○○－日本株式」等のブランド名より優先して日本株と判定
        asset = "日本株の指数"
    elif any(k in name for k in ("米国", "ダウ", "ナスダック", "Ｓ＆Ｐ", "ＮＹ")) or any(k in n for k in ("S&P", "SP500", "NASDAQ", "NYSE")):
        asset = "米国株の指数"
    elif "中国" in name or "上海" in name or "H株" in name or "HUAAN" in n or "CHINA" in n:
        asset = "中国株の指数"
    elif any(k in name for k in ("先進国", "全世界", "海外", "グローバル", "MSCI")) or any(k in n for k in ("KOKUSAI", "WORLD", "ACWI")):
        asset = "海外株の指数"
    elif any(k in name for k in ("インド", "ベトナム", "アセアン", "ブラジル", "新興国", "韓国", "ドイツ", "欧州", "ユーロ")):
        asset = "海外の株価・債券指数"
    elif any(k in name for k in ("TOPIX", "日経", "JPX", "225", "400", "東証")) or "TOPIX" in n:
        asset = "日本株の指数"

    if any(k in name for k in ("レバレッジ", "ブル", "ダブル", "２倍", "2倍", "３倍", "3倍")):
        lev = "（値動きを増幅するレバレッジ型）"
    elif any(k in name for k in ("ベア", "インバース", "ショート")):
        lev = "（下落で利益が出るインバース型）"
    else:
        lev = ""

    if asset:
        return f"{asset}に連動する{kind}{lev}。"
    return f"特定の指数などに連動する{kind}{lev}。"


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DOCS / "data.json"))
    ap.add_argument("--limit", type=int, default=0, help="通常銘柄の処理上限（動作確認用）")
    args = ap.parse_args()
    key = ee.api_key()

    data = json.loads(Path(args.data).read_text())
    stocks = data["stocks"]

    # ETF / J-REIT は名称・セクターから即生成（設立年は表示しないので付けない）
    etf_ok = 0
    for s in stocks:
        if s.get("is_etf"):
            s.pop("founded_year", None)
            s.pop("founded_kind", None)
            d = etf_description(s)
            if d:
                s["business"] = d
                etf_ok += 1
    print(f"ETF/J-REIT: {etf_ok}銘柄に種別説明を付与")

    # 通常銘柄は最新の有報から生成
    targets = [s for s in stocks if not s.get("is_etf")]
    if args.limit:
        targets = targets[:args.limit]
    print(f"通常銘柄: {len(targets)}銘柄の「事業の内容」を取得・整形")

    today = datetime.date.today()
    print("書類一覧を取得中（直近14ヶ月・キャッシュ優先）...")
    recent = ee.build_docid_map(
        today - datetime.timedelta(days=430), today, key, "直近")
    print(f"  有報が見つかった会社: {len(recent)}社")

    ok = miss = 0
    found_ok = 0  # 設立/創業年が取れた通常銘柄数
    for i, s in enumerate(targets, 1):
        ent = recent.get(s["code"])
        if not ent:
            s.pop("business", None)
            s.pop("founded_year", None)
            s.pop("founded_kind", None)
            miss += 1
        else:
            _date, docid, _pe = ent
            try:
                summ = summarize(fetch_business_text(docid, key))
            except Exception as e:
                print(f"  {s['code']}: エラー {e}", file=sys.stderr)
                summ = None
            if summ:
                s["business"] = summ
                ok += 1
            else:
                s.pop("business", None)
                miss += 1
            # 設立/創業年（参考情報・採点には影響しない）
            try:
                fnd = fetch_founding(docid, key)
            except Exception as e:
                print(f"  {s['code']}: 設立年エラー {e}", file=sys.stderr)
                fnd = None
            if fnd and fnd.get("year"):
                s["founded_year"] = fnd["year"]
                s["founded_kind"] = fnd["kind"]
                found_ok += 1
            else:
                s.pop("founded_year", None)
                s.pop("founded_kind", None)
        if i % 50 == 0:
            print(f"  [{i}/{len(targets)}] 生成 {ok} / 説明なし {miss} / 設立年 {found_ok}")

    Path(args.data).write_text(json.dumps(data, ensure_ascii=False, indent=1))
    total = etf_ok + ok
    print(f"\n完了: 事業説明を {total}銘柄に付与 "
          f"(通常 {ok}/{len(targets)}・ETF/REIT {etf_ok})、説明なし {miss}\n"
          f"設立/創業年を {found_ok}/{len(targets)}銘柄に付与 → {args.data}")


if __name__ == "__main__":
    main()
