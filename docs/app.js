/* 高配当株チェッカー フロントエンド */
(function () {
  "use strict";

  const GLOSSARY = {
    yield: {
      name: "① 配当利回り",
      rule: "税引前3.75%以上（3.5%以上で△）",
      plain: "株価に対して1年間にもらえる配当金の割合。100万円分買ったら年に何円もらえるかの目安です。高いほどうれしい一方、高すぎる場合は「株価が下がっている＝会社に問題がある」サインのこともあります。",
    },
    op_margin: {
      name: "② 営業利益率",
      rule: "10%以上",
      plain: "売上のうち、本業の儲けが何%残るか。この数字が高い会社は「商売がうまい・競争力がある」会社です。",
    },
    equity_ratio: {
      name: "③ 自己資本比率",
      rule: "50%以上",
      plain: "会社の財産のうち、借金ではなく自分のお金の割合。高いほど倒産しにくく、不況でも配当を維持しやすい「財務がカタい」会社です。",
    },
    current_ratio: {
      name: "④ 流動比率",
      rule: "200%以上",
      plain: "1年以内に払うお金に対して、1年以内に使えるお金が何倍あるか。200%あれば当面の資金繰りに余裕があります。",
    },
    revenue_trend: {
      name: "⑤ 売上高の推移",
      rule: "長期的に上昇トレンド",
      plain: "会社の商売の規模が伸びているか。学長は「緩やかで良いので売上が伸びてる会社」を好みます。",
    },
    eps_trend: {
      name: "⑥ EPS（1株あたり利益）の推移",
      rule: "上昇トレンド・赤字なし",
      plain: "1株あたりの儲けが増えているか。EPSが伸びる会社は増配の余力が育っていきます。赤字の年がある会社は要注意。",
    },
    dividend_trend: {
      name: "⑦ 1株配当の推移",
      rule: "非減配・増配傾向",
      plain: "配当金を減らさず、少しずつ増やしてきた実績があるか。学長がいちばん重視する「増配」のチェックです。",
    },
    payout: {
      name: "⑧ 配当性向",
      rule: "30〜50%が理想（80%超は✕）",
      plain: "儲けのうち何%を配当に回しているか。高すぎる（例：80%超）と、業績が少し悪化しただけで減配になるリスクが高まります。",
    },
    op_cf: {
      name: "⑨ 営業キャッシュフロー",
      rule: "黒字・増加傾向",
      plain: "本業で実際に現金を稼げているか。利益が出ていても現金が入ってこない会社は危険信号です。",
    },
    cash: {
      name: "⑩ 現金等",
      rule: "潤沢で増加傾向",
      plain: "手元のお金が増えているか。現金が積み上がっている会社は不況に強く、配当を守る力があります。",
    },
  };

  const STATUS_MARK = { ok: "◯", warn: "△", ng: "✕" };

  let DATA = null;
  let state = { filter: "all", search: "", sort: "score" };

  // 10項目中8項目以上を評価できた銘柄だけを「採点信頼できる」とみなす。
  // (データがほとんど取れない銘柄は、1項目◯なだけで満点になってしまうため)
  function dataOk(s) {
    return (s.na_count ?? 0) <= 2;
  }

  function scoreClass(s, stock) {
    if (s == null || (stock && !dataOk(stock))) return "score-na";
    if (s >= 8) return "score-good";
    if (s >= 6) return "score-mid";
    return "score-low";
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function chipHtml(critId, check) {
    const g = GLOSSARY[critId];
    const st = check?.status || "na";
    const mark = STATUS_MARK[st] || "−";
    const label = g ? g.name.replace(/^[①-⑩]\s?/, "").replace(/（.*?）/, "") : critId;
    return `<span class="chip ${st}" title="${esc(g?.rule || "")}">${mark} ${esc(label)}</span>`;
  }

  // ---- ミニチャート (SVG) ----
  function fmtNum(v) {
    if (v == null) return "−";
    const a = Math.abs(v);
    if (a >= 10000) return Math.round(v).toLocaleString();
    if (a >= 100) return String(Math.round(v));
    return String(Math.round(v * 10) / 10);
  }

  function svgChart(kind, values, labels, unit) {
    const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null);
    if (pts.length < 2) return "";
    const W = 260, H = 84, padT = 14, padB = 14, padL = 4, padR = 34;
    const n = values.length;
    const vs = pts.map((p) => p.v);
    let min = Math.min(...vs, 0 < Math.min(...vs) && kind === "line" ? Math.min(...vs) : 0);
    let max = Math.max(...vs);
    if (kind === "line") { min = Math.min(...vs); }
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const x = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    let body = "";
    if (kind === "bar") {
      const bw = Math.min(18, ((W - padL - padR) / n) * 0.7);
      const y0 = y(Math.max(min, 0));
      body = pts
        .map((p) => {
          const yy = y(p.v);
          const neg = p.v < 0;
          return `<rect x="${(x(p.i) - bw / 2).toFixed(1)}" y="${(neg ? y0 : yy).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.5, Math.abs(yy - y0)).toFixed(1)}" rx="1.5" fill="${neg ? "var(--red)" : "var(--green)"}" opacity="0.8"/>`;
        })
        .join("");
    } else {
      const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
      const lastP = pts[pts.length - 1];
      body = `<polyline points="${line}" fill="none" stroke="var(--green)" stroke-width="2"/>
        <circle cx="${x(lastP.i).toFixed(1)}" cy="${y(lastP.v).toFixed(1)}" r="3" fill="var(--green)"/>`;
    }
    const lastVal = pts[pts.length - 1].v;
    const firstLb = labels && labels.length ? labels[pts[0].i] : "";
    const lastLb = labels && labels.length ? labels[pts[pts.length - 1].i] : "";
    return `<svg viewBox="0 0 ${W} ${H}" class="mini-svg" role="img">
      ${body}
      <text x="${W - 2}" y="${(y(lastVal) + 3).toFixed(1)}" text-anchor="end" class="ch-val">${fmtNum(lastVal)}${unit || ""}</text>
      <text x="${padL}" y="${H - 2}" class="ch-lb">${firstLb}</text>
      <text x="${W - padR}" y="${H - 2}" text-anchor="end" class="ch-lb">${lastLb}</text>
    </svg>`;
  }

  function chartBox(title, svg) {
    if (!svg) return "";
    return `<div class="mini-chart"><h4>${title}</h4>${svg}</div>`;
  }

  function priceYearLabels(ph) {
    const [y0, m0] = ph.start.split("-").map(Number);
    return ph.closes.map((_, i) => {
      const m = m0 - 1 + i;
      return `${y0 + Math.floor(m / 12)}`;
    });
  }

  function chartsHtml(s) {
    const S = s.series || {};
    const E = s.edinet || null; // 金融庁EDINET由来の約10年データ (あれば優先)
    const yrs = (S.years || []).map(String);
    const eyrs = E ? E.years.map(String) : [];
    const pick = (ef, sf, kind, title, unit) => {
      if (E && E[ef] && E[ef].some((v) => v != null))
        return chartBox(title + " 🏛", svgChart(kind, E[ef], eyrs, unit));
      if (sf && sf.some((v) => v != null))
        return chartBox(title, svgChart(kind, sf, yrs, unit));
      return "";
    };
    const parts = [];
    if (s.price_history)
      parts.push(chartBox("株価の推移（10年・月次）",
        svgChart("line", s.price_history.closes, priceYearLabels(s.price_history), "円")));
    if (E && E.dividend && E.dividend.some((v) => v != null)) {
      parts.push(chartBox("1株あたり配当金の推移 🏛",
        svgChart("bar", E.dividend, eyrs, "円")));
    } else if (s.dividend_history && s.dividend_history.length >= 3) {
      parts.push(chartBox("1株あたり配当金の推移",
        svgChart("bar", s.dividend_history.map(h => h.value), s.dividend_history.map(h => String(h.year)), "円")));
    }
    if (s.yield_history && s.yield_history.length >= 3)
      parts.push(chartBox("配当利回りの推移（年平均株価ベース）",
        svgChart("line", s.yield_history.map(h => h.value), s.yield_history.map(h => String(h.year)), "%")));
    parts.push(pick("eps", S.eps, "bar", "EPS（1株あたり純利益）", "円"));
    parts.push(pick("payout", null, "line", "配当性向", "%"));
    parts.push(pick("revenue_oku", S.revenue_oku, "bar", "売上高（億円）", ""));
    if (S.op_margin && S.op_margin.some((v) => v != null))
      parts.push(chartBox("営業利益率", svgChart("line", S.op_margin, yrs, "%")));
    parts.push(pick("ordinary_income_oku", null, "bar", "経常利益（億円）", ""));
    parts.push(pick("equity_ratio", S.equity_ratio, "line", "自己資本比率", "%"));
    parts.push(pick("roe", S.roe, "line", "ROE（自己資本利益率）", "%"));
    parts.push(pick("op_cf_oku", S.op_cf_oku, "bar", "営業キャッシュフロー（億円）", ""));
    const body = parts.filter(Boolean);
    if (!body.length) return "";
    const note = E
      ? `※ 🏛マークのグラフは金融庁（EDINET）の有価証券報告書データで約${E.years.length}年分を表示しています。営業利益率のみ直近${yrs.length}年分です。`
      : `※ 売上高・EPS・営業利益率などの推移は、無料データの都合で直近${yrs.length}年分です。10年以上の長期推移は下の「IR BANK」ボタンで確認できます。`;
    return `<div class="chart-grid">${body.join("")}</div>
      <p class="chart-note">${note}</p>`;
  }

  function statsRowHtml(s) {
    // 営業CFの連続黒字年数: EDINETの長期データがあればそちらで数える
    let cfStreak = s.op_cf_streak;
    let cfYears = s.op_cf_years_available || 0;
    if (s.edinet && s.edinet.op_cf_oku) {
      const vals = s.edinet.op_cf_oku.filter((v) => v != null);
      if (vals.length > cfYears) {
        cfStreak = 0;
        for (let i = vals.length - 1; i >= 0; i--) {
          if (vals[i] > 0) cfStreak++;
          else break;
        }
        cfYears = vals.length;
      }
    }
    const items = [
      ["PER", s.per != null ? s.per + "倍" : "−"],
      ["PBR", s.pbr != null ? s.pbr + "倍" : "−"],
      ["ROE", s.roe != null ? s.roe + "%" : "−"],
      ["配当性向", s.payout != null ? s.payout + "%" : "−"],
      ["営業CF連続黒字", cfStreak != null
        ? `${cfStreak}年${cfStreak >= cfYears && cfStreak > 0 ? "以上" : ""}`
        : "−"],
    ];
    return `<div class="stats-row">${items
      .map(([k, v]) => `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${v}</span></div>`)
      .join("")}</div>`;
  }

  function detailHtml(s) {
    const checksOrder = DATA.criteria.map((c) => c.id);
    const detailRows = checksOrder
      .map((id) => {
        const c = s.checks[id] || {};
        const g = GLOSSARY[id];
        const st = c.status || "na";
        return `<tr>
          <td class="${st}" style="font-weight:800">${STATUS_MARK[st] || "−"}</td>
          <td><span class="crit-name">${esc(g.name)}</span>
              <span class="crit-desc">目安: ${esc(g.rule)}</span></td>
          <td class="crit-value">${esc(c.text || "−")}</td>
        </tr>`;
      })
      .join("");
    return `${statsRowHtml(s)}
      ${chartsHtml(s)}
      <table class="detail-table">${detailRows}</table>
      <div class="ext-links">
        <a class="btn-ext" href="https://irbank.net/${esc(s.code)}/results" target="_blank" rel="noopener">📊 IR BANKで10年分を見る</a>
        <a class="btn-ext" href="https://finance.yahoo.co.jp/quote/${esc(s.code)}.T" target="_blank" rel="noopener">💹 Yahoo!ファイナンス</a>
      </div>
      <details class="irbank-guide">
        <summary>❓ IR BANKページのどこを見ればいいの？</summary>
        <div class="irbank-guide-body">
          <p>上のボタンを押すと「決算まとめ」ページが開き、<strong>2008年ごろからの長期データの表</strong>が最初から表示されます。スマホでは表を横にスクロールできます。見る場所はこの4つ：</p>
          <ol>
            <li><strong>会社業績</strong>の表 → 「売上」「EPS」「営利率（＝営業利益率）」が毎年伸びているか。<br>目安：売上・EPSが右肩上がり、営利率10%以上</li>
            <li><strong>財務状況</strong>の表 → 「自己資本比率」が50%以上で安定しているか</li>
            <li><strong>キャッシュ・フローの推移</strong> → 「営業CF」がずっと黒字（プラス）か</li>
            <li><strong>配当推移</strong>の表 → 「配当」が減っていないか（コロナの2020〜2021年に減配していないかは特に注目）、「配当性向」が高すぎ（80%超）になっていないか</li>
          </ol>
          <p>つまり<strong>このアプリの10項目とまったく同じ観点</strong>を、より長い期間で確かめる作業です。アプリのグラフ（直近4〜5年）で気になった銘柄だけ、IR BANKで「昔からそうだったのか」を確認するのが効率的です。</p>
        </div>
      </details>`;
  }

  function cardHtml(s) {
    const checksOrder = DATA.criteria.map((c) => c.id);
    const chips = checksOrder.map((id) => chipHtml(id, s.checks[id])).join("");

    const etfNote = s.is_etf
      ? `<div class="etf-note">📦 この銘柄はETF（投資信託の一種）のため、会社の財務指標では評価できない項目があります。</div>`
      : "";

    return `<article class="card">
      <div class="card-top">
        <div>
          <h3 class="stock-name"><span class="stock-code">${esc(s.code)}</span>${esc(s.name)}</h3>
          <span class="sector-chip">${esc(s.sector || "—")}</span>
          ${DEFENSIVE.includes(normSector(s.sector)) ? '<span class="def-badge">🛡 ディフェンシブ</span>' : ""}
          ${s.in_model_pf ? '<span class="pf-badge">🦁 今月の学長PF</span>' : ""}
          ${s.pf_held ? '<span class="pf-badge pf-held">📦 学長PF（保持）</span>' : ""}
          ${s.pf_featured ? '<span class="pf-badge pf-featured">⭐ 学長注目株</span>' : ""}
        </div>
        <div class="score-circle ${scoreClass(s.score, s)}">
          ${s.score == null ? "−" : s.score}<small>${dataOk(s) ? "/ 10点" : "参考値"}</small>
        </div>
      </div>
      <div class="yield-line">配当利回り
        <span class="yield-value">${s.yield == null ? "−" : s.yield + "%"}</span>
        ${s.price ? `<span style="color:var(--gray); font-size:0.8rem">（株価 ${s.price.toLocaleString()}円）</span>` : ""}
      </div>
      ${etfNote}
      ${!s.is_etf && !dataOk(s) ? '<div class="etf-note">⚠️ この銘柄は財務データが十分に取得できないため、スコアは参考値です（発掘候補には含めていません）。IR BANKで直接確認してください。</div>' : ""}
      <div class="chips">${chips}</div>
      <details data-code="${esc(s.code)}">
        <summary>くわしく見る（グラフ・全指標）</summary>
        <div class="detail-body"></div>
      </details>
    </article>`;
  }

  function applyFilters() {
    let list = DATA.stocks.slice();
    if (state.filter === "pass")
      list = list.filter((s) => (s.score ?? 0) >= 8 && dataOk(s));
    if (state.filter === "discover")
      list = list.filter((s) => (s.score ?? 0) >= 8 && dataOk(s) && !s.in_model_pf && !s.pf_held);
    if (state.filter === "modelpf")
      list = list.filter((s) => s.in_model_pf || s.pf_held || s.pf_featured);
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) => s.code.includes(q) || (s.name || "").toLowerCase().includes(q)
      );
    }
    const sorters = {
      score: (a, b) => (dataOk(b) - dataOk(a)) ||
        (b.score ?? -1) - (a.score ?? -1) || (b.yield ?? 0) - (a.yield ?? 0),
      yield: (a, b) => (b.yield ?? -1) - (a.yield ?? -1),
      code: (a, b) => a.code.localeCompare(b.code),
    };
    list.sort(sorters[state.sort]);
    return list;
  }

  const PAGE_SIZE = 60;
  let shownCount = PAGE_SIZE;

  function render(keepShown) {
    updateSignalBanner();
    const isMy = state.filter === "mypf";
    document.getElementById("results").hidden = isMy;
    document.getElementById("mypf-view").hidden = !isMy;
    document.querySelector(".search-sort").style.display = isMy ? "none" : "";
    if (isMy) {
      renderMyPf();
      return;
    }
    if (!keepShown) shownCount = PAGE_SIZE;
    const list = applyFilters();
    const cards = document.getElementById("cards");
    const count = document.getElementById("count-line");
    const shown = list.slice(0, shownCount);
    count.textContent = `${list.length}銘柄が該当（全${DATA.stocks.length}銘柄中）`;
    cards.innerHTML = shown.length
      ? shown.map(cardHtml).join("")
      : `<div class="empty-msg">条件に合う銘柄がありません</div>`;
    const more = document.getElementById("more-btn");
    if (list.length > shownCount) {
      more.style.display = "block";
      more.textContent = `さらに表示（残り${list.length - shownCount}銘柄）`;
    } else {
      more.style.display = "none";
    }
  }

  function renderGlossary() {
    const el = document.getElementById("glossary-items");
    el.innerHTML = Object.values(GLOSSARY)
      .map(
        (g) => `<div class="glossary-item">
          <strong>${esc(g.name)}</strong>（目安: ${esc(g.rule)}）
          <p>${esc(g.plain)}</p>
        </div>`
      )
      .join("");
  }

  function setupEvents() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.filter = btn.dataset.filter;
        render();
      });
    });
    document.getElementById("search").addEventListener("input", (e) => {
      state.search = e.target.value;
      render();
    });
    document.getElementById("sort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      render();
    });
    document.getElementById("more-btn").addEventListener("click", () => {
      shownCount += PAGE_SIZE;
      render(true);
    });
    // 詳細（グラフ）は開いた時にはじめて描画する（1300銘柄でも軽快に動かすため)
    const lazyDetail = (e) => {
      const d = e.target;
      if (!d.matches("details[data-code]") || !d.open) return;
      const body = d.querySelector(".detail-body");
      if (body && !body.dataset.rendered) {
        const s = DATA.stocks.find((x) => x.code === d.dataset.code);
        if (s) {
          body.innerHTML = detailHtml(s);
          body.dataset.rendered = "1";
        }
      }
    };
    document.getElementById("cards").addEventListener("toggle", lazyDetail, true);
    document.getElementById("mypf-view").addEventListener("toggle", lazyDetail, true);
  }

  // ==== 💼 マイポートフォリオ ====
  // 保有データは localStorage（この端末の中）にのみ保存。ネット送信は一切しない。
  const PF_KEY = "khc_pf";
  const DEFENSIVE = ["食料品", "医薬品", "電気・ガス", "陸運", "情報・通信"];

  // 取得単価比の下落しきい値（学長ルール⑤の買い増し水準）。
  // 「現在株価 ≤ 取得単価 ×(1−しきい値)」になった保有銘柄を抽出する。
  // ここの数値だけ変えれば抽出条件を簡単に変更できる。
  const COST_DROP_1 = 0.20; // 1回目の買い増し水準（取得単価比 −20%）
  const COST_DROP_2 = 0.40; // 2回目の買い増し水準（取得単価比 −40%）

  function loadPf() {
    try { return JSON.parse(localStorage.getItem(PF_KEY)) || []; }
    catch { return []; }
  }
  function savePf(pf) { localStorage.setItem(PF_KEY, JSON.stringify(pf)); }

  function normSector(sec) {
    return (sec || "その他").replace(/業$/, "");
  }

  function stockByCode(code) {
    return DATA.stocks.find((s) => s.code === code) || null;
  }

  function high12(s) {
    const ph = s && s.price_history;
    if (!ph || !ph.closes || ph.closes.length < 3) return null;
    return Math.max(...ph.closes.slice(-13));
  }

  function pfCalc() {
    const pf = loadPf();
    const rows = pf.map((h) => {
      const s = stockByCode(h.code);
      const price = s ? s.price : null;
      const value = price != null ? price * h.shares : null;
      const gain = price != null && h.cost > 0 ? (price / h.cost - 1) * 100 : null;
      const dps = s && s.yield != null && s.price ? s.yield * s.price / 100 : null;
      const annualDiv = dps != null ? dps * h.shares : null;
      const hi = high12(s);
      // 学長ルール⑤: 取得単価-20%で1回目、-40%で2回目の買い増し水準
      // dropPct = 取得単価からの下落率（0.23 なら -23%）
      let signal = null;
      if (price != null && h.cost > 0) {
        const dropPct = 1 - price / h.cost;
        if (price <= h.cost * (1 - COST_DROP_2))
          signal = { level: 2, dropPct, why: `取得単価から${(dropPct * 100).toFixed(0)}%下落（2回目の買い増し水準）` };
        else if (price <= h.cost * (1 - COST_DROP_1))
          signal = { level: 1, dropPct, why: `取得単価から${(dropPct * 100).toFixed(0)}%下落（1回目の買い増し水準）` };
      }
      let hiSignal = null;
      if (price != null && hi && price <= hi * 0.8) {
        hiSignal = `直近1年高値(${Math.round(hi).toLocaleString()}円)から${((1 - price / hi) * 100).toFixed(0)}%下落`;
      }
      return { ...h, s, price, value, gain, annualDiv, signal, hiSignal,
        name: s ? s.name : h.code, sector: normSector(s ? s.sector : null) };
    });
    const total = rows.reduce((a, r) => a + (r.value || 0), 0);
    const totalDiv = rows.reduce((a, r) => a + (r.annualDiv || 0), 0);
    return { rows, total, totalDiv };
  }

  function modelSectorWeights() {
    const m = {};
    for (const s of DATA.model_pf.stocks) {
      const k = normSector(s.sector);
      m[k] = (m[k] || 0) + s.weight;
    }
    return m;
  }

  function mySectorWeights(rows, total) {
    const m = {};
    if (!total) return m;
    for (const r of rows) {
      if (r.value == null) continue;
      m[r.sector] = (m[r.sector] || 0) + r.value / total * 100;
    }
    return m;
  }

  function sectorCompareHtml(mine, model) {
    const keys = [...new Set([...Object.keys(model), ...Object.keys(mine)])]
      .sort((a, b) => (model[b] || 0) - (model[a] || 0));
    const rows = keys.map((k) => {
      const mv = mine[k] || 0, gv = model[k] || 0;
      const diff = mv - gv;
      const over20 = mv > 20;
      return `<tr${over20 ? ' class="sec-over"' : ""}>
        <td class="sec-name">${esc(k)}</td>
        <td class="sec-bars">
          <div class="bar-row"><span class="bar bar-me" style="width:${Math.min(100, mv * 3)}%"></span><span class="bar-val">${mv.toFixed(1)}%</span></div>
          <div class="bar-row"><span class="bar bar-model" style="width:${Math.min(100, gv * 3)}%"></span><span class="bar-val">${gv.toFixed(1)}%</span></div>
        </td>
        <td class="sec-diff ${diff > 3 ? "over" : diff < -3 ? "under" : ""}">${diff > 0 ? "+" : ""}${diff.toFixed(1)}</td>
      </tr>`;
    }).join("");
    return `<table class="sec-table">
      <thead><tr><th>セクター</th><th><span class="lg lg-me">■ わたし</span> <span class="lg lg-model">■ 学長モデルPF</span></th><th>差</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  // 買い増し・新規候補の銘柄に付ける「業績チェック」要約と詳細展開
  function bizCheckHtml(s) {
    if (!s) return `<div class="biz-check mut">この銘柄はアプリのデータベースに未収載のため、業績チェックを表示できません。IR BANK等で確認してください。</div>`;
    const keys = [
      ["revenue_trend", "売上"], ["eps_trend", "EPS"], ["dividend_trend", "配当"],
      ["payout", "配当性向"], ["op_cf", "営業CF"],
    ];
    const marks = keys.map(([k, label]) => {
      const st = s.checks?.[k]?.status || "na";
      return `<span class="chip ${st}">${STATUS_MARK[st] || "−"} ${label}</span>`;
    }).join("");
    const bad = keys.filter(([k]) => s.checks?.[k]?.status === "ng").map(([, l]) => l);
    const warn = keys.filter(([k]) => s.checks?.[k]?.status === "warn").map(([, l]) => l);
    let verdict;
    if (bad.length) verdict = `<span class="v-ng">⚠️ ${bad.join("・")}に✕あり。「下がっている理由」が業績かもしれません。買い増しは慎重に。</span>`;
    else if (warn.length) verdict = `<span class="v-warn">△が${warn.join("・")}にあります。詳細を確認してから判断を。</span>`;
    else verdict = `<span class="v-ok">✅ 学長基準で業績の崩れは見当たりません。</span>`;
    return `<div class="biz-check">
      <div>スコア <strong>${s.score ?? "−"}</strong>/10点｜業績: ${marks}</div>
      <div class="biz-verdict">${verdict}</div>
      <details class="lazy-detail" data-code="${esc(s.code)}">
        <summary>📋 くわしく見る（グラフ・全指標）</summary>
        <div class="detail-body"></div>
      </details>
    </div>`;
  }

  function guidanceHtml(calc) {
    const { rows, total, totalDiv } = calc;
    if (!total) return "";
    const mine = mySectorWeights(rows, total);
    const model = modelSectorWeights();
    const items = [];

    // ①取得単価比 −20% の抽出 (学長ルール⑤の買い増し水準・自分の買値が基準)
    //   ②の「直近高値からの下落」とは別指標。ここは "買値" を基準に判定する。
    const pct1 = (COST_DROP_1 * 100).toFixed(0);
    const costDrops = rows.filter((r) => r.signal);
    if (costDrops.length) {
      items.push(`<div class="guide guide-buy"><h4>📉 取得単価比 −${pct1}% の銘柄（買い増し検討）</h4>
        <p class="guide-note">あなたの平均取得単価より${pct1}%以上値下がりした保有銘柄です（学長ルール⑤の買い増し水準）。下の「直近高値からの下落」とは別に、<strong>自分の買値</strong>を基準に判定しています。</p>
        ${costDrops.map((r) =>
        `<div class="sig-item"><div><strong>${esc(r.name)}</strong>（${esc(r.code)}）
          <span class="cost-drop-badge lv${r.signal.level}">取得単価比 ${(r.signal.dropPct * -100).toFixed(0)}%</span>
          <span class="mut">${r.signal.level === 2 ? "2回目" : "1回目"}の買い増し水準</span></div>
         ${bizCheckHtml(r.s)}</div>`).join("")}
        <p class="guide-note">学長ルール：「取得単価から20%下がったら1回目、40%下がったら2回目の買い増し。ナンピンは2回まで」。業績チェックに✕がある銘柄は「安いから買う」ではなく「業績が崩れたから安い」の可能性があります。</p></div>`);
    } else {
      items.push(`<div class="guide"><h4>🔕 取得単価比 −${pct1}% の銘柄はなし</h4><p>保有銘柄はどれも取得単価から${pct1}%以上は下がっていません。学長ルールでは「ちょっと下がったぐらいでは買い増ししない」ので、次の候補探し（新規銘柄）が中心になります。</p></div>`);
    }

    // ②直近1年高値からの下落 (別指標・押し目の目安)
    const hiDrops = rows.filter((r) => r.hiSignal);
    if (hiDrops.length) {
      items.push(`<div class="guide"><h4>📉 直近1年高値から −20% の銘柄</h4>
        <p class="guide-note">こちらは取得単価ではなく「直近1年の高値」を基準にした下落です（押し目の目安）。買値が基準の上の指標とは別物なので、両方に出る銘柄もあります。</p>
        ${hiDrops.map((r) =>
        `<div class="sig-item"><div><strong>${esc(r.name)}</strong>（${esc(r.code)}）: ${esc(r.hiSignal)}</div>
         ${bizCheckHtml(r.s)}</div>`).join("")}</div>`);
    }

    // セクター20%ルール (ルール②)
    const over = Object.entries(mine).filter(([, v]) => v > 20).map(([k]) => k);
    if (over.length) {
      items.push(`<div class="guide guide-warn"><h4>⚠️ 20%を超えているセクター: ${over.map(esc).join("、")}</h4><p>学長ルール「特定セクターは最大でも20%まで」。このセクターの銘柄は、買い増し・新規とも控えるのが学長流です。</p></div>`);
    }

    // 不足セクター → 新規候補の提案
    const under = Object.keys(model)
      .filter((k) => k !== "J-REIT市場" && (model[k] - (mine[k] || 0)) > 3)
      .sort((a, b) => (model[b] - (mine[b] || 0)) - (model[a] - (mine[a] || 0)))
      .slice(0, 4);
    if (under.length) {
      const heldCodes = new Set(loadPf().map((h) => h.code));
      const cands = DATA.stocks
        .filter((s) => (s.in_model_pf || s.pf_featured || ((s.score ?? 0) >= 8 && dataOk(s))) && !heldCodes.has(s.code)
          && under.includes(normSector(s.sector)))
        .sort((a, b) => (b.in_model_pf - a.in_model_pf) || (!!b.pf_featured - !!a.pf_featured) || (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 6);
      items.push(`<div class="guide guide-new"><h4>🌱 手薄なセクター: ${under.map(esc).join("、")}</h4>
        <p>学長モデルPFと比べて割合が低いセクターです。分散を強化するなら、このセクターの新規銘柄が候補になります：</p>
        ${cands.map((s) => `<div class="sig-item"><div><strong>${esc(s.name)}</strong>（${esc(s.code)}・${esc(normSector(s.sector))}）利回り${s.yield}% ${s.in_model_pf ? "🦁今月の学長PF" : "🔍発掘候補"} ${DEFENSIVE.includes(normSector(s.sector)) ? "🛡" : ""}</div>
        ${bizCheckHtml(s)}</div>`).join("")}</div>`);
    }

    // 配当3%集中ルール (ルール③)
    if (totalDiv > 0) {
      const conc = rows.filter((r) => r.annualDiv != null && r.annualDiv / totalDiv > 0.03 * 3); // 9%超で強警告
      const concMild = rows.filter((r) => r.annualDiv != null && r.annualDiv / totalDiv > 0.03 && !conc.includes(r));
      if (conc.length || concMild.length) {
        const fmt = (r) => `<li><strong>${esc(r.name)}</strong>: 配当全体の${(r.annualDiv / totalDiv * 100).toFixed(1)}%</li>`;
        items.push(`<div class="guide guide-warn"><h4>⚠️ 配当が特定銘柄に集中しています</h4>
          <ul>${[...conc, ...concMild].map(fmt).join("")}</ul>
          <p class="guide-note">学長ルール「1銘柄からの配当はPF全体の3%まで」。銘柄数が少ないうちは超えるのが普通です。この銘柄の買い増しは控えて、他の銘柄を増やして薄めていくのが学長流です。</p></div>`);
      }
    }

    // ディフェンシブ50%ルール (ルール④)
    const defPct = DEFENSIVE.reduce((a, k) => a + (mine[k] || 0), 0);
    items.push(`<div class="guide ${defPct < 50 ? "guide-warn" : ""}"><h4>${defPct < 50 ? "⚠️" : "✅"} ディフェンシブ比率: ${defPct.toFixed(1)}%</h4>
      <p>ディフェンシブ（食料品・医薬品・電気ガス・陸運・通信）は「50%を切らないように」が学長ルール。${defPct < 50 ? "不景気に強い銘柄を優先して増やすのがおすすめです。" : "守備力は確保できています。"}</p></div>`);

    return items.join("");
  }

  // ==== 🧮 購入シミュレーション ====
  let SIM = []; // [{code, amount}] 画面を離れるとリセットされる仮の買い物カゴ

  function sectorValues(rows) {
    const v = {};
    for (const r of rows) {
      if (r.value == null) continue;
      v[r.sector] = (v[r.sector] || 0) + r.value;
    }
    return v;
  }

  function simulatorHtml(calc) {
    const { rows, total } = calc;
    if (!total) return "";
    const model = modelSectorWeights();
    const V = sectorValues(rows);
    // シミュレーション適用後
    const V2 = { ...V };
    let simTotal = 0;
    const simRows = SIM.map((it, i) => {
      const s = stockByCode(it.code);
      const sec = normSector(s ? s.sector : null);
      V2[sec] = (V2[sec] || 0) + it.amount;
      simTotal += it.amount;
      const shares = s && s.price ? Math.round(it.amount / s.price) : null;
      return `<li>${esc(s ? s.name : it.code)}（${esc(sec)}）に ${it.amount.toLocaleString()}円
        ${shares != null ? `<span class="mut">（約${shares}株分・実際は100株単位）</span>` : ""}
        <button class="sim-del" data-i="${i}">✕</button></li>`;
    }).join("");
    const T2 = total + simTotal;

    let tableHtml = "";
    if (SIM.length) {
      const keys = [...new Set([...Object.keys(model), ...Object.keys(V2)])]
        .sort((a, b) => (model[b] || 0) - (model[a] || 0));
      const trs = keys.map((k) => {
        const now = (V[k] || 0) / total * 100;
        const after = (V2[k] || 0) / T2 * 100;
        const gv = model[k] || 0;
        const dNow = Math.abs(now - gv), dAfter = Math.abs(after - gv);
        const better = dAfter < dNow - 0.05, worse = dAfter > dNow + 0.05;
        return `<tr${after > 20 ? ' class="sec-over"' : ""}>
          <td class="sec-name">${esc(k)}</td>
          <td class="num">${now.toFixed(1)}%</td>
          <td class="num"><strong>${after.toFixed(1)}%</strong></td>
          <td class="num mut">${gv.toFixed(1)}%</td>
          <td class="num ${better ? "pos" : worse ? "neg" : ""}">${better ? "✓ 近づく" : worse ? "離れる" : "−"}</td>
        </tr>`;
      }).join("");
      tableHtml = `<table class="sec-table sim-table">
        <thead><tr><th>セクター</th><th>現在</th><th>購入後</th><th>学長</th><th>判定</th></tr></thead>
        <tbody>${trs}</tbody></table>
        <p class="mut">購入合計: ${simTotal.toLocaleString()}円 → 評価額 ${Math.round(T2).toLocaleString()}円</p>`;
    }

    return `<h3>🧮 購入シミュレーション</h3>
      <p class="mut">「この銘柄を◯円分買ったら」のセクターバランス変化を、買う前に確認できます。</p>
      <div class="pf-form">
        <input id="sim-code" placeholder="コード (例: 4206)" inputmode="numeric" maxlength="4">
        <input id="sim-amount" placeholder="購入金額(円)" inputmode="numeric" type="number" step="10000">
        <button id="sim-add">追加</button>
        ${SIM.length ? '<button id="sim-clear" class="danger">クリア</button>' : ""}
      </div>
      ${SIM.length ? `<ul class="sim-list">${simRows}</ul>${tableHtml}` : ""}`;
  }

  function targetGuideHtml(calc) {
    const { rows, total } = calc;
    if (!total) return "";
    const model = modelSectorWeights();
    const V = sectorValues(rows);
    // 学長モデルに存在しないセクター(ETFなど)の保有は買い足しでは調整不能
    const excluded = Object.keys(V).filter((k) => !(model[k] > 0));
    const Vm = Object.fromEntries(Object.entries(V).filter(([k]) => model[k] > 0));
    const Tm = Object.values(Vm).reduce((a, b) => a + b, 0);
    if (!Tm) return "";
    // 売らずに買い足しだけで完全一致させるのに必要な最終評価額
    let Tfinal = Tm;
    for (const [k, v] of Object.entries(Vm)) {
      Tfinal = Math.max(Tfinal, v * 100 / model[k]);
    }
    const needs = Object.keys(model)
      .map((k) => ({ k, need: Math.max(0, model[k] / 100 * Tfinal - (Vm[k] || 0)) }))
      .filter((x) => x.need >= 1000)
      .sort((a, b) => b.need - a.need);
    const totalNeed = needs.reduce((a, x) => a + x.need, 0);

    const needRows = needs.map((x) =>
      `<tr><td class="sec-name">${esc(x.k)}</td><td class="num">${Math.round(x.need).toLocaleString()}円</td></tr>`).join("");

    return `<h3>🎯 学長バランスへの道しるべ</h3>
      <div class="guide">
        <p>いまの保有を<strong>売らずに、買い足しだけ</strong>で学長モデルPFと同じセクター割合にするには、
        合計 <strong>${Math.round(totalNeed).toLocaleString()}円</strong> の買い足しが必要です（内訳↓）。</p>
        <table class="sec-table need-table"><tbody>${needRows}</tbody></table>
        ${excluded.length ? `<p class="guide-note">※ ${excluded.map(esc).join("、")}の保有分は学長モデルPFに無い区分のため、この計算から除いています。</p>` : ""}
        <p class="guide-note">一度に揃える必要はありません。学長も「月に一度、候補を探して少しずつ買い増す」方式です。下の予算計算で「今月の予算ならどこに配分するか」を確認できます。</p>
        <div class="pf-form">
          <input id="budget-input" placeholder="今月の予算(円) 例: 100000" inputmode="numeric" type="number" step="10000">
          <button id="budget-calc">配分を計算</button>
        </div>
        <div id="budget-result"></div>
      </div>`;
  }

  function budgetAllocHtml(budget, calc) {
    const { rows, total } = calc;
    const model = modelSectorWeights();
    const V = sectorValues(rows);
    const Vm = Object.fromEntries(Object.entries(V).filter(([k]) => model[k] > 0));
    const Tm = Object.values(Vm).reduce((a, b) => a + b, 0);
    const T2 = Tm + budget;
    const d = Object.keys(model).map((k) => ({ k, gap: Math.max(0, model[k] / 100 * T2 - (Vm[k] || 0)) }));
    const gapSum = d.reduce((a, x) => a + x.gap, 0);
    if (!gapSum) return "<p>この予算では配分先がありません（すでにバランスが取れています）。</p>";
    const heldCodes = new Set(loadPf().map((h) => h.code));
    const allocs = d.filter((x) => x.gap / gapSum * budget >= budget * 0.03)
      .sort((a, b) => b.gap - a.gap)
      .map((x) => {
        const amt = x.gap / gapSum * budget;
        const cands = DATA.stocks
          .filter((s) => normSector(s.sector) === x.k && !heldCodes.has(s.code)
            && (s.in_model_pf || s.pf_featured || ((s.score ?? 0) >= 8 && dataOk(s))))
          .sort((a, b) => (b.in_model_pf - a.in_model_pf) || (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 2);
        return `<tr><td class="sec-name">${esc(x.k)}</td>
          <td class="num"><strong>${Math.round(amt / 1000) * 1000 >= 1000 ? (Math.round(amt / 1000) * 1000).toLocaleString() : Math.round(amt).toLocaleString()}円</strong></td>
          <td class="mut">${cands.map((s) => `${esc(s.name)}(${esc(s.code)})${s.in_model_pf ? "🦁" : s.pf_featured ? "⭐" : "🔍"}`).join("、") || "候補は🔍タブで"}</td></tr>`;
      }).join("");
    return `<p>予算 <strong>${budget.toLocaleString()}円</strong> を学長バランスに最も近づく形で配分すると：</p>
      <table class="sec-table"><thead><tr><th>セクター</th><th>金額</th><th>候補銘柄の例</th></tr></thead><tbody>${allocs}</tbody></table>
      <p class="guide-note">※日本株は基本100株単位なので、金額はあくまで目安です。候補銘柄は参考情報であり、購入判断はご自身で。</p>`;
  }

  function renderMyPf() {
    const view = document.getElementById("mypf-view");
    const calc = pfCalc();
    const { rows, total, totalDiv } = calc;
    const mine = mySectorWeights(rows, total);
    const model = modelSectorWeights();

    const holdingsRows = rows.map((r, i) => `<tr>
      <td><strong>${esc(r.name)}</strong><br><span class="mut">${esc(r.code)}・${esc(r.sector)}</span>
        ${r.s && r.s.in_model_pf ? "🦁" : ""}${r.s && r.s.pf_held ? "📦" : ""}</td>
      <td class="num">${r.shares.toLocaleString()}株<br><span class="mut">@${r.cost.toLocaleString()}円</span></td>
      <td class="num">${r.price != null ? Math.round(r.price).toLocaleString() + "円" : "<span class='mut'>未収載</span>"}</td>
      <td class="num ${r.gain > 0 ? "pos" : r.gain < 0 ? "neg" : ""}">${r.gain != null ? (r.gain > 0 ? "+" : "") + r.gain.toFixed(1) + "%" : "−"}</td>
      <td class="num">${r.annualDiv != null ? Math.round(r.annualDiv).toLocaleString() + "円" : "−"}</td>
      <td>${r.signal ? `<span class="sig sig${r.signal.level}">📉 取得単価比${(r.signal.dropPct * -100).toFixed(0)}%（買い増し${r.signal.level}回目）</span>` : ""}${r.hiSignal ? `<span class="sig sigHi">📉 高値-20%</span>` : ""}</td>
      <td><button class="del-btn" data-i="${i}">✕</button></td>
    </tr>`).join("");

    view.innerHTML = `
      <div class="privacy-note">🔒 ここに入力した保有データは<strong>この端末の中にだけ</strong>保存されます。インターネットには送信されません。</div>
      ${rows.length ? `
        <div class="pf-summary">
          <div class="stat"><span class="stat-k">評価額合計</span><span class="stat-v">${Math.round(total).toLocaleString()}円</span></div>
          <div class="stat"><span class="stat-k">年間配当(予想)</span><span class="stat-v">${Math.round(totalDiv).toLocaleString()}円</span></div>
          <div class="stat"><span class="stat-k">PF利回り</span><span class="stat-v">${total ? (totalDiv / total * 100).toFixed(2) : "−"}%</span></div>
          <div class="stat"><span class="stat-k">銘柄数</span><span class="stat-v">${rows.length}</span></div>
        </div>
        ${guidanceHtml(calc)}
        <h3>📊 セクター割合の比較（学長モデルPF vs わたし）</h3>
        ${sectorCompareHtml(mine, model)}
        ${simulatorHtml(calc)}
        ${targetGuideHtml(calc)}
        <h3>保有銘柄</h3>
        <div class="pf-table-wrap"><table class="pf-table">
          <thead><tr><th>銘柄</th><th>保有</th><th>現在値</th><th>損益</th><th>年間配当</th><th>シグナル</th><th></th></tr></thead>
          <tbody>${holdingsRows}</tbody>
        </table></div>
      ` : `<div class="empty-msg">保有銘柄がまだ登録されていません。<br>下のフォームで追加するか、楽天証券のCSVを読み込んでください。</div>`}

      <h3>➕ 銘柄を追加・更新</h3>
      <div class="pf-form">
        <input id="pf-code" placeholder="コード (例: 8130)" inputmode="numeric" maxlength="4">
        <input id="pf-shares" placeholder="株数" inputmode="numeric" type="number">
        <input id="pf-cost" placeholder="平均取得単価(円)" inputmode="decimal" type="number">
        <button id="pf-add">追加</button>
      </div>

      <h3>📄 楽天証券のCSVを読み込む</h3>
      <p class="mut">楽天証券にログイン →「マイメニュー」→「保有商品一覧（国内株式）」→「CSVで保存」でダウンロードしたファイルを選んでください。</p>
      <input type="file" id="pf-csv" accept=".csv,text/csv">
      <p id="pf-csv-msg" class="mut"></p>

      <details class="pf-tools"><summary>⚙️ データの引っ越し（別の端末で使う）・全削除</summary>
        <p class="mut">下の文字列をコピーして、別の端末のこの欄に貼り付けて「取り込み」を押すと保有データを移せます。</p>
        <textarea id="pf-export" rows="3">${esc(JSON.stringify(loadPf()))}</textarea>
        <div><button id="pf-import">この内容を取り込み</button> <button id="pf-clear" class="danger">全削除</button></div>
      </details>
      <p class="chart-note">※ 「買い増しシグナル」は学長ルール（買値-20%/-40%、直近1年高値-20%）の機械的な判定です。買い増し前に必ず業績（減配・赤字がないか）を確認してください。本アプリは投資助言ではありません。</p>
    `;
    setupPfEvents(view);
  }

  function setupPfEvents(view) {
    view.querySelectorAll(".del-btn").forEach((b) => b.addEventListener("click", () => {
      const pf = loadPf();
      pf.splice(+b.dataset.i, 1);
      savePf(pf);
      renderMyPf();
    }));
    view.querySelector("#pf-add").addEventListener("click", () => {
      const code = view.querySelector("#pf-code").value.trim();
      const shares = +view.querySelector("#pf-shares").value;
      const cost = +view.querySelector("#pf-cost").value;
      if (!/^\d{4}$/.test(code) || !(shares > 0) || !(cost > 0)) {
        alert("コード(4ケタ)・株数・取得単価をすべて入力してください");
        return;
      }
      const pf = loadPf().filter((h) => h.code !== code);
      pf.push({ code, shares, cost });
      savePf(pf);
      renderMyPf();
    });
    // 購入シミュレーション
    const simAdd = view.querySelector("#sim-add");
    if (simAdd) {
      simAdd.addEventListener("click", () => {
        const code = view.querySelector("#sim-code").value.trim();
        const amount = +view.querySelector("#sim-amount").value;
        if (!/^\d{4}$/.test(code) || !(amount > 0)) {
          alert("コード(4ケタ)と購入金額を入力してください");
          return;
        }
        if (!stockByCode(code)) {
          alert("この銘柄コードはアプリのデータに見つかりません。コードを確認してください。");
          return;
        }
        SIM.push({ code, amount });
        renderMyPf();
      });
      view.querySelectorAll(".sim-del").forEach((b) => b.addEventListener("click", () => {
        SIM.splice(+b.dataset.i, 1);
        renderMyPf();
      }));
      const simClear = view.querySelector("#sim-clear");
      if (simClear) simClear.addEventListener("click", () => { SIM = []; renderMyPf(); });
    }
    // 予算配分の計算
    const budgetBtn = view.querySelector("#budget-calc");
    if (budgetBtn) {
      budgetBtn.addEventListener("click", () => {
        const b = +view.querySelector("#budget-input").value;
        if (!(b > 0)) { alert("予算を入力してください"); return; }
        view.querySelector("#budget-result").innerHTML = budgetAllocHtml(b, pfCalc());
      });
    }
    view.querySelector("#pf-csv").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      let text;
      try { text = new TextDecoder("shift-jis").decode(buf); } catch { text = ""; }
      if (!text || text.includes("�")) text = new TextDecoder("utf-8").decode(buf);
      const res = parseBrokerCsv(text);
      const msg = view.querySelector("#pf-csv-msg");
      if (!res.length) {
        msg.textContent = "⚠️ 銘柄を読み取れませんでした。CSVの形式が想定と違う可能性があります。手入力するか、Claudeに形式を伝えてください。";
        return;
      }
      const pf = loadPf();
      for (const r of res) {
        const i = pf.findIndex((h) => h.code === r.code);
        if (i >= 0) pf[i] = r; else pf.push(r);
      }
      savePf(pf);
      renderMyPf();
      document.getElementById("mypf-view").querySelector("#pf-csv-msg").textContent =
        `✅ ${res.length}銘柄を読み込みました（データは端末内にのみ保存）`;
    });
    view.querySelector("#pf-import").addEventListener("click", () => {
      try {
        const arr = JSON.parse(view.querySelector("#pf-export").value);
        if (!Array.isArray(arr)) throw new Error();
        savePf(arr.filter((h) => /^\d{4}$/.test(h.code) && h.shares > 0));
        renderMyPf();
      } catch {
        alert("形式が正しくありません");
      }
    });
    view.querySelector("#pf-clear").addEventListener("click", () => {
      if (confirm("保有データをすべて削除しますか？")) {
        savePf([]);
        renderMyPf();
      }
    });
  }

  function parseBrokerCsv(text) {
    // 楽天証券などのCSVから 銘柄コード・保有数量・平均取得価額 を推定して読む
    const lines = text.split(/\r?\n/).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
    let cols = null;
    const out = [];
    for (const cells of lines) {
      // ヘッダー行はファイル途中にも現れうる（複数セクションのCSV対応）
      const ci = cells.findIndex((c) => /銘柄コード|証券コード|^コード$/.test(c));
      const si = cells.findIndex((c) => /保有数量|保有株数|^数量$|^株数$/.test(c));
      const pi = cells.findIndex((c) => /平均取得価額|平均取得単価|取得単価|参考単価/.test(c));
      if (ci >= 0 && si >= 0 && pi >= 0) {
        cols = { ci, si, pi };
        continue;
      }
      if (!cols) continue;
      const code = (cells[cols.ci] || "").replace(/\D/g, "").slice(0, 4);
      const shares = parseFloat((cells[cols.si] || "").replace(/[,株]/g, ""));
      const cost = parseFloat((cells[cols.pi] || "").replace(/[,円]/g, ""));
      if (/^\d{4}$/.test(code) && shares > 0 && cost > 0) out.push({ code, shares, cost });
    }
    return out;
  }

  // 買い増しシグナルのアラートバナー（どのタブにいても表示）
  function updateSignalBanner() {
    const banner = document.getElementById("signal-banner");
    if (!DATA || !loadPf().length) { banner.hidden = true; return; }
    const sigs = pfCalc().rows.filter((r) => r.signal || r.hiSignal);
    if (!sigs.length) {
      banner.hidden = true;
      if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
      return;
    }
    banner.hidden = false;
    banner.innerHTML = `🔔 <strong>買い増しタイミングの銘柄が${sigs.length}件</strong>あります：
      ${sigs.slice(0, 3).map((r) => esc(r.name)).join("、")}${sigs.length > 3 ? " ほか" : ""}
      <span class="banner-go">タップして確認 ▶</span>`;
    banner.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) =>
        b.classList.toggle("active", b.dataset.filter === "mypf"));
      state.filter = "mypf";
      render();
      window.scrollTo(0, 0);
    };
    if (navigator.setAppBadge) navigator.setAppBadge(sigs.length).catch(() => {});
  }

  let lastFetch = 0;

  function loadData() {
    return fetch("data.json?" + Date.now())
      .then((r) => {
        if (!r.ok) throw new Error("data.json not found");
        return r.json();
      })
      .then((data) => {
        DATA = data;
        lastFetch = Date.now();
        document.getElementById("updated-at").textContent =
          `株価更新: ${data.prices_updated_at || data.generated_at}｜採点: ${data.generated_at}｜学長PF: ${data.model_pf.as_of}`;
        updateSignalBanner();
      });
  }

  function boot() {
    loadData()
      .then(() => {
        setupEvents();
        renderGlossary();
        render();
      })
      .catch((err) => {
        document.getElementById("updated-at").textContent =
          "データがまだありません。screener/screen.py を実行してください。";
        console.error(err);
      });
    // アプリに戻ってきた時、データが10分以上古ければ自動で取り直す
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetch > 10 * 60 * 1000) {
        loadData().then(() => render(true)).catch(() => {});
      }
    });
  }

  // ---- PINロック (個人利用のための簡易ロック) ----
  const PIN_SALT = "kouhaitou:";
  const PIN_HASH = "5dd97d244c3d9cd62d5f8d526eff75cf4f03b8a7d8399a694edf96db1df76100";

  async function sha256hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function showLock() {
    const ov = document.createElement("div");
    ov.className = "lock-overlay";
    ov.innerHTML = `
      <div class="lock-box">
        <div class="lock-icon">🔒</div>
        <h2>このアプリは個人用です</h2>
        <p>暗証番号（6ケタ）を入力してください</p>
        <input type="password" inputmode="numeric" maxlength="6" id="pin-input" autocomplete="off">
        <button id="pin-btn">開く</button>
        <p id="pin-error" class="pin-error"></p>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector("#pin-input");
    const tryUnlock = async () => {
      const h = await sha256hex(PIN_SALT + input.value.trim());
      if (h === PIN_HASH) {
        localStorage.setItem("khc_unlocked", PIN_HASH);
        ov.remove();
        boot();
      } else {
        ov.querySelector("#pin-error").textContent = "番号がちがいます";
        input.value = "";
      }
    };
    ov.querySelector("#pin-btn").addEventListener("click", tryUnlock);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    input.focus();
  }

  if (localStorage.getItem("khc_unlocked") === PIN_HASH) {
    boot();
  } else {
    showLock();
  }
})();
