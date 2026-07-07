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

  function scoreClass(s) {
    if (s == null) return "score-na";
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

  function divChartHtml(hist) {
    if (!hist || hist.length < 3) return "";
    const max = Math.max(...hist.map((h) => h.value));
    if (!(max > 0)) return "";
    const bars = hist
      .map((h) => `<div class="div-bar" style="height:${Math.max(4, (h.value / max) * 100)}%" title="${h.year}年: ${h.value}円"></div>`)
      .join("");
    const first = hist[0].year, last = hist[hist.length - 1].year;
    return `<div class="div-chart">${bars}</div>
      <div class="div-chart-label">1株配当の推移（${first}〜${last}年）</div>`;
  }

  function cardHtml(s) {
    const checksOrder = DATA.criteria.map((c) => c.id);
    const chips = checksOrder.map((id) => chipHtml(id, s.checks[id])).join("");
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
        <div class="score-circle ${scoreClass(s.score)}">
          ${s.score == null ? "−" : s.score}<small>/ 10点</small>
        </div>
      </div>
      <div class="yield-line">配当利回り
        <span class="yield-value">${s.yield == null ? "−" : s.yield + "%"}</span>
        ${s.price ? `<span style="color:var(--gray); font-size:0.8rem">（株価 ${s.price.toLocaleString()}円）</span>` : ""}
      </div>
      ${etfNote}
      <div class="chips">${chips}</div>
      <details>
        <summary>くわしく見る</summary>
        <table class="detail-table">${detailRows}</table>
        ${divChartHtml(s.dividend_history)}
        <div class="ext-links">
          <a href="https://irbank.net/${esc(s.code)}" target="_blank" rel="noopener">IR BANKで10年分を確認</a>
          <a href="https://finance.yahoo.co.jp/quote/${esc(s.code)}.T" target="_blank" rel="noopener">Yahoo!ファイナンス</a>
        </div>
      </details>
    </article>`;
  }

  function applyFilters() {
    let list = DATA.stocks.slice();
    if (state.filter === "pass") list = list.filter((s) => (s.score ?? 0) >= 8);
    if (state.filter === "discover")
      list = list.filter((s) => (s.score ?? 0) >= 8 && !s.in_model_pf);
    if (state.filter === "modelpf") list = list.filter((s) => s.in_model_pf);
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) => s.code.includes(q) || (s.name || "").toLowerCase().includes(q)
      );
    }
    const sorters = {
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.yield ?? 0) - (a.yield ?? 0),
      yield: (a, b) => (b.yield ?? -1) - (a.yield ?? -1),
      code: (a, b) => a.code.localeCompare(b.code),
    };
    list.sort(sorters[state.sort]);
    return list;
  }

  function render() {
    const list = applyFilters();
    const cards = document.getElementById("cards");
    const count = document.getElementById("count-line");
    count.textContent = `${list.length}銘柄を表示中（全${DATA.stocks.length}銘柄）`;
    cards.innerHTML = list.length
      ? list.map(cardHtml).join("")
      : `<div class="empty-msg">条件に合う銘柄がありません</div>`;
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
  }

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
})();
