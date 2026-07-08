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
    const yrs = (S.years || []).map(String);
    const parts = [];
    if (s.price_history)
      parts.push(chartBox("株価の推移（10年・月次）",
        svgChart("line", s.price_history.closes, priceYearLabels(s.price_history), "円")));
    if (s.dividend_history && s.dividend_history.length >= 3)
      parts.push(chartBox("1株あたり配当金の推移",
        svgChart("bar", s.dividend_history.map(h => h.value), s.dividend_history.map(h => String(h.year)), "円")));
    if (s.yield_history && s.yield_history.length >= 3)
      parts.push(chartBox("配当利回りの推移（年平均株価ベース）",
        svgChart("line", s.yield_history.map(h => h.value), s.yield_history.map(h => String(h.year)), "%")));
    if (S.eps) parts.push(chartBox("EPS（1株あたり純利益）",
      svgChart("bar", S.eps, yrs, "円")));
    if (S.revenue_oku) parts.push(chartBox("売上高（億円）",
      svgChart("bar", S.revenue_oku, yrs, "")));
    if (S.op_margin) parts.push(chartBox("営業利益率",
      svgChart("line", S.op_margin, yrs, "%")));
    if (S.equity_ratio) parts.push(chartBox("自己資本比率",
      svgChart("line", S.equity_ratio, yrs, "%")));
    if (S.roe) parts.push(chartBox("ROE（自己資本利益率）",
      svgChart("line", S.roe, yrs, "%")));
    if (S.op_cf_oku) parts.push(chartBox("営業キャッシュフロー（億円）",
      svgChart("bar", S.op_cf_oku, yrs, "")));
    if (!parts.length) return "";
    return `<div class="chart-grid">${parts.join("")}</div>
      <p class="chart-note">※ 売上高・EPS・営業利益率などの推移は、無料データの都合で直近${yrs.length}年分です。
      10年以上の長期推移は下の「IR BANK」ボタンで確認できます。</p>`;
  }

  function statsRowHtml(s) {
    const items = [
      ["PER", s.per != null ? s.per + "倍" : "−"],
      ["PBR", s.pbr != null ? s.pbr + "倍" : "−"],
      ["ROE", s.roe != null ? s.roe + "%" : "−"],
      ["配当性向", s.payout != null ? s.payout + "%" : "−"],
      ["営業CF連続黒字", s.op_cf_streak != null
        ? `${s.op_cf_streak}年${s.op_cf_streak >= (s.op_cf_years_available || 0) && s.op_cf_streak > 0 ? "以上" : ""}`
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
        <a class="btn-ext" href="https://irbank.net/${esc(s.code)}" target="_blank" rel="noopener">📊 IR BANKで10年分を確認</a>
        <a class="btn-ext" href="https://finance.yahoo.co.jp/quote/${esc(s.code)}.T" target="_blank" rel="noopener">💹 Yahoo!ファイナンス</a>
      </div>`;
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
          ${s.in_model_pf ? '<span class="pf-badge">🦁 学長モデルPF</span>' : ""}
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
      list = list.filter((s) => (s.score ?? 0) >= 8 && dataOk(s) && !s.in_model_pf);
    if (state.filter === "modelpf") list = list.filter((s) => s.in_model_pf);
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
    document.getElementById("cards").addEventListener("toggle", (e) => {
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
    }, true);
  }

  function boot() {
    fetch("data.json?" + Date.now())
      .then((r) => {
        if (!r.ok) throw new Error("data.json not found");
        return r.json();
      })
      .then((data) => {
        DATA = data;
        document.getElementById("updated-at").textContent =
          `データ更新: ${data.generated_at}｜学長モデルPF: ${data.model_pf.as_of}`;
        setupEvents();
        renderGlossary();
        render();
      })
      .catch((err) => {
        document.getElementById("updated-at").textContent =
          "データがまだありません。screener/screen.py を実行してください。";
        console.error(err);
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
