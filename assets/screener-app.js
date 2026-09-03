"use strict";
/* ===== screener-app.js：筛选、渲染（桌面表格 + 手机卡片）、事件、初始化 =====
   依赖 screener-core.js / screener-metrics.js 先加载。 */

let sortKey = "f8", sortDir = -1, indSortKey = "avgT", indSortDir = -1;
let shown = LOAD_STEP, lastRows = [];
let hasRun = false;
let directMode = false;   // 个股直达：搜索框为 6 位代码时,只取单只快照,不做全市场翻页
let boardSet = null;      // 所属板块筛选：所选板块成分股的并集（null = 不按板块筛）
let selectedBoards = new Set();   // 已选板块代码（板块多选组件状态,见文件末尾）
let boardNameMap = {};            // 板块代码 → 名称

// 基础排序项（手机端排序 chips；自定义指标会动态追加）
const SORT_LABELS = { f8: "换手率", f3: "涨跌幅", f6: "成交额", f20: "总市值", f9: "市盈率" };

// ===== 筛选条件摘要（手机折叠面板显示）/ 本地记忆 =====
function filterSummary() {
  const [tMin, tMax] = range("tMin", "tMax");
  const [cMin, cMax] = range("cMin", "cMax");
  const parts = [];
  if (!isNaN(tMin) || !isNaN(tMax)) parts.push("换手 " + (isNaN(tMin) ? "" : tMin) + "~" + (isNaN(tMax) ? "∞" : tMax) + "%");
  if (!isNaN(cMin) || !isNaN(cMax)) parts.push("涨跌 " + (isNaN(cMin) ? "" : cMin) + "~" + (isNaN(cMax) ? "∞" : cMax) + "%");
  const ind = document.getElementById("industrySel").value;
  if (ind) parts.push(ind);
  if (selectedBoards.size) parts.push("板块:" + boardLabel());
  const skw = document.getElementById("scopeKw").value.trim();
  if (skw) parts.push("范围含:" + skw);
  const mPart = metricsSummaryPart();
  if (mPart) parts.push(mPart);
  parts.push(document.querySelectorAll(".mkt:checked").length + " 市场");
  return parts.join(" · ");
}
function refreshSummary() { document.getElementById("filterSum").textContent = filterSummary(); }

function saveFilters() {
  try {
    localStorage.setItem("tsm-filters", JSON.stringify({
      tMin: document.getElementById("tMin").value, tMax: document.getElementById("tMax").value,
      cMin: document.getElementById("cMin").value, cMax: document.getElementById("cMax").value,
      kw: document.getElementById("kw").value,
      mkts: [...document.querySelectorAll(".mkt")].filter(c => c.checked).map(c => c.value),
      noST: document.getElementById("noST").checked,
      noSuspend: document.getElementById("noSuspend").checked,
      board: [...selectedBoards],   // 兼容读取：旧版单选存的是字符串
      scopeKw: document.getElementById("scopeKw").value,
      metrics: getMetricsState(),
    }));
  } catch (e) {}
}
// 返回保存的筛选对象（无则 null），自定义指标由调用方交给 setMetricsState
function restoreFilters() {
  let f = null;
  try { f = JSON.parse(localStorage.getItem("tsm-filters") || "null"); } catch (e) {}
  if (!f) return null;
  // 空串也要恢复：用户主动清空的条件（如删掉默认 -5）刷新后必须保持清空
  const set = (id, v) => { if (v !== undefined && v !== null) document.getElementById(id).value = v; };
  set("tMin", f.tMin); set("tMax", f.tMax); set("cMin", f.cMin); set("cMax", f.cMax); set("kw", f.kw);
  set("scopeKw", f.scopeKw);   // board 在板块列表异步加载完成后恢复（见板块多选组件）
  if (Array.isArray(f.mkts)) {
    const boxes = document.querySelectorAll(".mkt");
    if (typeof f.mkts[0] === "boolean")  // 兼容旧版布尔数组存档（按下标）
      boxes.forEach((c, i) => { c.checked = !!f.mkts[i]; });
    else                                 // 新版按 value 匹配，不受 checkbox 顺序影响
      boxes.forEach(c => { c.checked = f.mkts.includes(c.value); });
  }
  if (f.noST !== undefined) document.getElementById("noST").checked = !!f.noST;
  if (f.noSuspend !== undefined) document.getElementById("noSuspend").checked = !!f.noSuspend;
  return f;
}

// ===== 折叠面板（仅手机端可见）=====
const panel = document.getElementById("filterPanel");
document.getElementById("filtersToggle").onclick = () => panel.classList.toggle("open");
function collapsePanel() {
  if (!IS_MOBILE()) return;
  panel.classList.remove("open");
  refreshSummary();
}

// chips 视觉态（手机端胶囊高亮;桌面端复选框本身可见,类名无视觉效果）
function syncChips() {
  document.querySelectorAll(".mkts label, .chk").forEach(l => {
    l.classList.toggle("on", l.querySelector("input").checked);
  });
}
document.querySelectorAll(".mkts input, .chk input").forEach(inp =>
  inp.addEventListener("change", () => { syncChips(); refreshSummary(); if (hasRun && !inp.classList.contains("mkt")) render(); }));

// ===== 市场情绪徽标（数据来自已拉取的全量快照,本地计算零新增请求;量能分量复用 analysis.js 的指数日K缓存）=====
function updateSentiBadge(idx) {
  const el = document.getElementById("sentiBadge");
  const s = computeSentiment(allRows, idx || null);
  if (!s) { el.style.display = "none"; return; }
  el.style.display = "";
  // lv 阈值与 computeSentiment level 同步：1冰点/2低迷/3中性/4活跃/5亢奋
  el.className = "sentiBadge lv" + (s.temp < 20 ? 1 : s.temp < 40 ? 2 : s.temp < 60 ? 3 : s.temp < 80 ? 4 : 5);
  el.textContent = "情绪 " + s.temp + " · " + s.level;
  const upPct = (s.upRatio * 100).toFixed(0);
  // 统计范围：市场勾选 + 股票数
  const mktLabels = [...document.querySelectorAll(".mkt:checked")].map(c => c.parentElement.textContent.trim());
  const scope = mktLabels.length ? mktLabels.join("、") : "全市场";
  el.title = `市场情绪 ${s.temp}/100 · ${s.level}\n` +
    `· 范围：${scope}（共 ${s.valid} 只有效股）\n` +
    `· 上涨 ${s.up} 家（${upPct}%） · 下跌 ${s.down} 家\n` +
    `· 涨停 ${s.limitUp} / 跌停 ${s.limitDown}\n` +
    `· 大跌(>5%) ${s.bigDown} 家\n` +
    (s.volRatio !== null
      ? `· 指数量能 ${s.volRatio.toFixed(2)}×5日均额 [${s.volSrc}]${s.volNote ? " " + s.volNote : ""}`
      : `· 指数量能：缺失（按中性计）`);
}

// ===== 一键查询：首页探测 → 并发分批 → 全量拉取（情绪/板块统计需完整数据）=====
// 换手率下限在渲染层过滤，不影响 allRows 的完整性和情绪指标准确度
async function run() {
  const kw0 = document.getElementById("kw").value.trim();
  const mkts = document.querySelectorAll(".mkt:checked");
  if (!kw0 && !mkts.length) { toast("请至少勾选一个市场"); return; }
  const btn = document.getElementById("goBtn");
  btn.disabled = true; btn.textContent = "查询中…";
  abortFlag = false;
  usedHost = "";              // 每次查询重新优先尝试实时源,避免一次降级后永远停在延迟源
  allRows = [];
  saveFilters();
  const t0 = performance.now();
  document.getElementById("progressWrap").style.display = "block";
  const bar = document.querySelector("#progressBar i"), st = document.getElementById("statusTxt");
  bar.style.width = "0";
  st.textContent = "连接行情接口…";
  let failedPages = 0;
  try {
    // 个股直达：6 位代码直接用;名称先经联想搜索解析成代码,解析不出再退回全市场筛选
    let directCode = /^\d{6}$/.test(kw0) ? kw0 : null;
    if (!directCode && kw0) {
      st.textContent = "正在匹配股票名称…";
      directCode = await resolveStockCode(kw0);
      if (!directCode) toast("名称未唯一匹配，按全市场筛选");
    }
    directMode = !!directCode;
    if (!directMode && !mkts.length) { st.textContent = "请至少勾选一个市场"; return; }
    // 个股直达：单点接口一次取回,跳过翻页/情绪统计（单只无市场口径）
    if (directMode) {
      st.textContent = "个股直达：获取单只快照…";
      const row = await fetchSingleStock(directCode);
      allRows = [row];
      bar.style.width = "100%";
      const txt0 = usedHost.includes("delay") ? "延迟行情 · 15min" : "实时行情";
      const hd1 = document.getElementById("srcBadge"), hd2 = document.getElementById("srcBadgeM");
      hd1.textContent = txt0; hd1.className = "srcBadge" + (txt0 === "实时行情" ? " rt" : "");
      hd2.textContent = txt0; hd2.className = "srcBadge" + (txt0 === "实时行情" ? " rt" : "");
      st.textContent = "个股直达 · " + row.f14 + "（" + row.f12 + "）· 不受筛选条件限制，清空搜索框恢复全市场查询";
      hasRun = true;
      fillIndustrySelect();
      render();
      document.getElementById("sentiBadge").style.display = "none";
      collapsePanel();
      if (IS_MOBILE()) setTimeout(() => { document.getElementById("progressWrap").style.display = "none"; }, 2500);
      return;
    }
    // 第 1 页：探测总数与可用 host
    const first = await fetchPage(1);
    const total = first.total || 0;
    if (first.diff) allRows.push(...first.diff);
    const totalPages = Math.ceil(total / PAGE_SIZE);
    st.textContent = "共 " + total + " 条 · " + totalPages + " 页，并发获取中…";

    // 其余页：CONCURRENCY 路并发分批；全量拉取确保 allRows 完整，供情绪/板块统计使用
    let nextPn = 2;
    while (nextPn <= totalPages) {
      if (abortFlag) break;
      const batch = [];
      for (let i = 0; i < CONCURRENCY && nextPn <= totalPages; i++, nextPn++) {
        batch.push(fetchPage(nextPn).catch(() => { failedPages++; return null; }));
      }
      const results = await Promise.all(batch);
      for (const data of results) {
        if (!data || !data.diff) continue;
        allRows.push(...data.diff);
      }
      bar.style.width = Math.min(100, allRows.length / total * 100) + "%";
      st.textContent = "已获取 " + allRows.length + " / " + total + " 条…";
      if (nextPn <= totalPages) await new Promise(r => setTimeout(r, BATCH_GAP_MS));
    }
    bar.style.width = "100%";

    // 板块/业务范围筛选的附加数据（会话内缓存,二次查询秒出）
    boardSet = null;
    if (selectedBoards.size && !abortFlag) {
      st.textContent = "获取板块成分股…";
      await refreshBoardSet();
    }
    if (document.getElementById("scopeKw").value.trim() && !abortFlag) {
      await fetchScopeMap((p, t) => { st.textContent = `首次加载全市场业务范围 ${p}/${t}…`; })
        .catch(() => toast("业务范围数据获取失败，本次未按业务范围筛选"));
    }

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const txt = usedHost.includes("delay") ? "延迟行情 · 15min" : "实时行情";
    const b1 = document.getElementById("srcBadge"), b2 = document.getElementById("srcBadgeM");
    b1.textContent = txt; b1.className = "srcBadge" + (txt === "实时行情" ? " rt" : "");
    b2.textContent = txt; b2.className = "srcBadge" + (txt === "实时行情" ? " rt" : "");
    let msg = (abortFlag ? "已取消 · " : "完成 · ") + "拉取 " + allRows.length + " 条 · 耗时 " + secs + "s";
    if (failedPages) msg += " · " + failedPages + " 页失败（结果可能不全，可重试）";
    st.textContent = msg;
    hasRun = true;
    fillIndustrySelect();
    render();
    updateSentiBadge(null);                              // 先出纯价格统计的温度（本地计算,不发请求）
    fetchIndexKline().then(i => updateSentiBadge(i));    // 再补量能分量（复用指数日K缓存,仅首次1次请求）
    collapsePanel();               // 手机端查完自动收起面板，把屏幕留给结果
    if (IS_MOBILE()) setTimeout(() => { document.getElementById("progressWrap").style.display = "none"; }, 2500);
  } catch (e) {
    st.textContent = "查询失败：" + e.message + "（可能接口限流，请稍后重试）";
    toast("查询失败，请稍后重试");
  } finally {
    btn.disabled = false; btn.textContent = "一键查询";
  }
}
document.getElementById("cancelBtn").onclick = () => { abortFlag = true; };
document.getElementById("goBtn").onclick = run;

// ===== 筛选 =====
function filtered() {
  if (directMode) return allRows;   // 个股直达：展示目标股本身,不受区间/行业/ST 条件影响
  const [tMin, tMax] = range("tMin", "tMax");
  const [cMin, cMax] = range("cMin", "cMax");
  const ind = document.getElementById("industrySel").value;
  const kw = document.getElementById("kw").value.trim();
  const skw = document.getElementById("scopeKw").value.trim();
  const noST = document.getElementById("noST").checked;
  const noSus = document.getElementById("noSuspend").checked;
  return allRows.filter(r => {
    if (typeof r.f2 !== "number") return false;                 // 无报价(停牌等)
    if (noST && /ST|退/.test(r.f14)) return false;
    if (noSus && !(r.f8 > 0)) return false;
    if (!isNaN(tMin) && r.f8 < tMin) return false;
    if (!isNaN(tMax) && r.f8 > tMax) return false;
    if (!isNaN(cMin) && r.f3 < cMin) return false;
    if (!isNaN(cMax) && r.f3 > cMax) return false;
    if (ind && r.f100 !== ind) return false;
    if (boardSet && !boardSet.has(r.f12)) return false;         // 所属板块
    if (skw) {                                                  // 业务范围关键词
      const sc = _scopeMap && _scopeMap[r.f12];
      if (!sc || !sc.includes(skw)) return false;
    }
    if (kw && !(r.f12.includes(kw) || r.f14.includes(kw))) return false;
    if (!metricPass(r)) return false;                           // 自定义指标
    return true;
  });
}

// ===== 渲染 =====
function fillIndustrySelect() {
  const cnt = {};
  allRows.forEach(r => { if (r.f100) cnt[r.f100] = (cnt[r.f100] || 0) + 1; });
  const sel = document.getElementById("industrySel");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部行业</option>' +
    Object.entries(cnt).sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `<option value="${esc(n)}">${esc(n)} (${c})</option>`).join("");
  // 查询完成后开放选择（查询前为空态置灰，见 html 中的 disabled/title）
  sel.disabled = false;
  sel.title = "";
  // 门户页跳转带来的预设行业优先
  if (window._presetIndustry) { sel.value = window._presetIndustry; window._presetIndustry = null; }
  else sel.value = cur;
}

function markSorted(tbl, key, dir) {
  document.querySelectorAll("#" + tbl + " th").forEach(th => {
    const on = th.dataset.k === key;
    th.classList.toggle("sorted", on);
    th.classList.toggle("asc", on && dir === 1);
    th.classList.toggle("desc", on && dir === -1);
  });
}

// 手机端排序 chips：基础项 + 动态追加的自定义指标
function buildSortChips() {
  const extra = activeMetrics.map(m => metricDef(m.k)).filter(d => !SORT_LABELS[d.k]);
  document.getElementById("sortBar").innerHTML =
    Object.entries(SORT_LABELS).map(([k, n]) => `<button class="sortChip" data-k="${k}">${n}</button>`).join("") +
    extra.map(d => `<button class="sortChip" data-k="${d.k}">${d.name}</button>`).join("");
  updateSortChips();
}
function updateSortChips() {
  document.querySelectorAll(".sortChip").forEach(c => {
    const on = c.dataset.k === sortKey;
    c.classList.toggle("on", on);
    const label = SORT_LABELS[c.dataset.k] || (metricDef(c.dataset.k) || {}).name || c.dataset.k;
    c.textContent = label + (on ? (sortDir === -1 ? " ↓" : " ↑") : "");
  });
}

// 手机端个股卡片 / 行业卡片
function stockCard(r) {
  const tac = lastRows.length > 0 && lastRows.length <= 35;
  return `<a class="card" href="${quoteUrl(r.f12)}" target="_blank" rel="noopener">
    <div class="c1">
      <div class="nm"><b>${esc(r.f14)}</b><span class="cd">${esc(r.f12)}</span></div>
      <div class="pr"><b>${fmtN(r.f2)}</b><span class="chg ${cls(r.f3)}">${typeof r.f3 === "number" ? (r.f3 > 0 ? "+" : "") + r.f3.toFixed(2) + "%" : "—"}</span></div>
    </div>
    <div class="c2">
      <span class="tov">换手 ${fmtN(r.f8)}%</span>
      <span class="tag" data-ind="${esc(r.f100 || "")}">${esc(r.f100 || "—")}</span>
      <span class="sub">额 ${fmtYiC(r.f6)} · 市值 ${fmtYiC(r.f20)} · PE ${fmtN(r.f9, 1)}${metricCardExtras(r)}</span>
      ${tac ? `<span class="tac" data-tac="${esc(r.f12)}"><span class="tacLoad">···</span></span>` : ""}
      <button class="anaBtn" data-code="${esc(r.f12)}">分析</button>
    </div>
  </a>`;
}

function renderStockCards() {
  document.getElementById("list").innerHTML = lastRows.slice(0, shown).map(stockCard).join("");
  document.body.classList.toggle("hasmore", lastRows.length > shown);
}

function indAgg(rows) {
  const g = {};
  rows.forEach(r => {
    const k = r.f100 || "未分类";
    (g[k] = g[k] || { name: k, n: 0, t: 0, c: 0, up: 0, amt: 0 });
    g[k].n++; g[k].t += r.f8 || 0; g[k].c += r.f3 || 0; g[k].amt += r.f6 || 0;
    if (r.f3 > 0) g[k].up++;
  });
  return Object.values(g).map(x => ({ name: x.name, n: x.n, avgT: x.t / x.n, avgC: x.c / x.n, upN: x.up, amount: x.amt }));
}

function renderIndCards(inds) {
  const cards = [...inds].sort((a, b) => b.avgT - a.avgT);
  document.getElementById("indList").innerHTML = cards.map(x => `<div class="icard" data-ind="${esc(x.name)}">
    <div class="c1"><b>${esc(x.name)}</b><span style="color:var(--dim);font-size:12.5px">${x.n} 只 · 涨 ${x.upN} 家</span></div>
    <div class="nums">
      <span>平均换手 <b style="color:var(--accent)">${x.avgT.toFixed(2)}%</b></span>
      <span>平均涨跌 <b class="${cls(x.avgC)}">${x.avgC.toFixed(2)}%</b></span>
      <span>成交额 <b>${fmtYiC(x.amount)}</b></span>
    </div>
  </div>`).join("");
}

// 桌面个股表头：基础列 + 自定义指标列
function buildStockHead() {
  const tacCol = lastRows.length > 0 && lastRows.length <= 35;
  document.querySelector("#stockTbl thead tr").innerHTML =
    `<th class="l" data-k="f12">代码</th><th class="l" data-k="f14">名称</th>
     <th data-k="f2">最新价</th><th data-k="f3">涨跌幅 %</th>
     <th data-k="f8">换手率 %</th><th class="l" data-k="f100">行业</th>
     <th data-k="f6">成交额</th><th data-k="f20">总市值</th><th data-k="f9">市盈率</th>` +
    metricExtraCols().map(d => `<th data-k="${d.k}">${d.name}${d.unit ? "(" + d.unit + ")" : ""}</th>`).join("") +
    (tacCol ? `<th style="cursor:default" title="趋势波段·趋势启动·超跌反弹">战法</th>` : "") +
    `<th style="cursor:default">分析</th>`;
}

function render() {
  const rows = filtered();
  lastRows = rows;
  shown = LOAD_STEP;
  document.getElementById("count").textContent = rows.length;
  document.getElementById("capNote").style.display = rows.length > RENDER_CAP ? "" : "none";
  document.getElementById("csvBtn").style.display = rows.length ? "" : "none";
  // 桌面表格（仅渲染前 RENDER_CAP 行保证流畅,数据本身完整）
  rows.sort(cmpRows(sortKey, sortDir));
  const mCols = metricExtraCols();
  buildStockHead();
  const tacCol = rows.length > 0 && rows.length <= 35;
  document.querySelector("#stockTbl tbody").innerHTML = rows.slice(0, RENDER_CAP).map(r => `<tr>
    <td class="l">${esc(r.f12)}</td><td class="l name"><a class="nameLink" href="${quoteUrl(r.f12)}" target="_blank" rel="noopener">${esc(r.f14)}</a></td>
    <td>${fmtN(r.f2)}</td>
    <td class="${cls(r.f3)}">${fmtN(r.f3)}</td>
    <td><b>${fmtN(r.f8)}</b></td>
    <td class="l"><span class="tag" data-ind="${esc(r.f100 || "")}">${esc(r.f100 || "—")}</span></td>
    <td>${fmtYiT(r.f6)}</td><td>${fmtYiT(r.f20)}</td><td>${fmtN(r.f9, 1)}</td>
    ${mCols.map(d => `<td>${fmtMetric(d, r[d.k])}</td>`).join("")}
    ${tacCol ? `<td class="tacCell" data-tac="${esc(r.f12)}"><span class="tacLoad">···</span></td>` : ""}
    <td><button class="anaBtn" data-code="${esc(r.f12)}">分析</button></td>
  </tr>`).join("");
  markSorted("stockTbl", sortKey, sortDir);
  buildSortChips();
  // 行业汇总（表格 + 卡片）
  const inds = indAgg(rows);
  inds.sort(cmpRows(indSortKey, indSortDir));
  document.querySelector("#indTbl tbody").innerHTML = inds.map(x => `<tr>
    <td class="l"><span class="tag" data-ind="${esc(x.name)}">${esc(x.name)}</span></td>
    <td>${x.n}</td><td><b>${x.avgT.toFixed(2)}</b></td>
    <td class="${cls(x.avgC)}">${x.avgC.toFixed(2)}</td>
    <td class="up">${x.upN}</td><td>${fmtYiT(x.amount)}</td>
  </tr>`).join("");
  markSorted("indTbl", indSortKey, indSortDir);
  // 手机卡片
  renderStockCards();
  renderIndCards(inds);
  // 空结果提示（手机端）
  const empty = !hasRun || rows.length === 0;
  document.body.dataset.empty = empty ? "1" : "0";
  if (hasRun && !rows.length)
    document.getElementById("emptyHint").innerHTML = "没有符合条件的股票<br>试试放宽筛选条件";
  // 战法内联评估（筛选 ≤ 35 只时）
  if (hasRun && rows.length > 0 && rows.length <= 35 && typeof batchEvalTactics === "function") {
    batchEvalTactics(rows);
  }
}

// 无限滚动：接近底部自动加载（仅手机端可见）
const moreBtn = document.getElementById("moreBtn");
moreBtn.onclick = () => { shown += LOAD_STEP; renderStockCards(); };
if ("IntersectionObserver" in window) {
  new IntersectionObserver(es => {
    if (es[0].isIntersecting && IS_MOBILE() && document.body.classList.contains("hasmore")
        && document.body.dataset.tab === "stock") {
      shown += LOAD_STEP; renderStockCards();
    }
  }, { rootMargin: "300px" }).observe(moreBtn);
}

// 分析按钮（表格行 / 手机卡片）→ 打开个股分析弹窗（screener-analysis.js）
// 行业标签 / 行业卡片点击（事件委托）→ 按行业筛选并切回个股页
document.getElementById("resultsPanel").addEventListener("click", e => {
  const ana = e.target.closest(".anaBtn");
  if (ana) { e.preventDefault(); e.stopPropagation(); openAnalysis(ana.dataset.code); return; }
  const tag = e.target.closest(".tag, .icard");
  if (!tag || !tag.dataset.ind) return;
  e.preventDefault();
  const name = tag.dataset.ind;
  document.getElementById("industrySel").value = name === "未分类" ? "" : name;
  switchTab(true);
  render();
  if (IS_MOBILE()) window.scrollTo({ top: 0, behavior: "smooth" });
});

// ===== 导出 CSV（含全部筛选结果与自定义指标列,BOM 头保证 Excel 中文不乱码）=====
// 字段含逗号/引号/换行时按 RFC4180 加引号包裹，防列错位
const csvCell = v => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function exportCSV() {
  const mCols = metricExtraCols();
  const head = "代码,名称,最新价,涨跌幅%,换手率%,行业,成交额(亿),总市值(亿),市盈率"
    + (mCols.length ? "," + mCols.map(d => csvCell(d.name + (d.unit ? "(" + d.unit + ")" : ""))).join(",") : "") + "\n";
  const body = lastRows.map(r => {
    const base = [
      r.f12, r.f14, fmtN(r.f2), fmtN(r.f3), fmtN(r.f8), r.f100 || "",
      typeof r.f6 === "number" ? (r.f6 / 1e8).toFixed(2) : "",
      typeof r.f20 === "number" ? (r.f20 / 1e8).toFixed(2) : "",
      fmtN(r.f9, 1)
    ];
    const extra = mCols.map(d => { const v = d.disp(r[d.k]); return v === null ? "" : v.toFixed(2); });
    return base.concat(extra).map(csvCell).join(",");
  }).join("\n");
  const blob = new Blob(["\uFEFF" + head + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "换手率筛选_" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById("csvBtn").onclick = exportCSV;

// ===== 页签 =====
function switchTab(stock) {
  document.getElementById("tabStock").className = stock ? "on" : "";
  document.getElementById("tabInd").className = stock ? "" : "on";
  document.body.dataset.tab = stock ? "stock" : "ind";
}
document.getElementById("tabStock").onclick = () => switchTab(true);
document.getElementById("tabInd").onclick = () => switchTab(false);

// ===== 排序（表头/排序 chips 均含动态列,用事件委托）=====
function setSort(k, strDefaultDir) {
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = strDefaultDir; }
  render();
}
document.querySelector("#stockTbl thead").addEventListener("click", e => {
  const th = e.target.closest("th");
  if (!th || !th.dataset.k) return;
  const k = th.dataset.k;
  setSort(k, k === "f12" || k === "f14" || k === "f100" ? 1 : -1);
});
document.querySelector("#indTbl thead").addEventListener("click", e => {
  const th = e.target.closest("th");
  if (!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if (indSortKey === k) indSortDir *= -1; else { indSortKey = k; indSortDir = k === "name" ? 1 : -1; }
  render();
});
document.getElementById("sortBar").addEventListener("click", e => {
  const ch = e.target.closest(".sortChip");
  if (ch) setSort(ch.dataset.k, -1);
});

// ===== 事件 =====
let kwTimer, numTimer;
document.getElementById("kw").oninput = () => { clearTimeout(kwTimer); kwTimer = setTimeout(() => { refreshSummary(); if (hasRun) render(); }, 200); };
// 数字区间输入防抖：避免每按一键就全量 filter+sort+重建 500 行 DOM
["tMin", "tMax", "cMin", "cMax"].forEach(id => {
  document.getElementById(id).oninput = () => {
    refreshSummary();
    clearTimeout(numTimer);
    numTimer = setTimeout(() => { if (hasRun) render(); }, 250);
  };
});
["industrySel", "noST", "noSuspend"].forEach(id =>
  document.getElementById(id).addEventListener("change", () => { refreshSummary(); if (hasRun) render(); }));
// 业务范围：首次使用时触发全量加载（约13页）,之后本地过滤秒出
let scopeTimer;
document.getElementById("scopeKw").oninput = () => {
  clearTimeout(scopeTimer);
  scopeTimer = setTimeout(async () => {
    refreshSummary(); saveFilters();
    const skw = document.getElementById("scopeKw").value.trim();
    if (skw && !_scopeMap) {
      toast("首次使用业务范围筛选，正在加载全市场公司概况…");
      await fetchScopeMap().catch(() => toast("业务范围数据获取失败，请重试"));
    }
    if (hasRun) render();
  }, 400);
};
// 回车直接查询（分析弹窗/板块下拉内不触发,避免误发起全量拉取）
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || document.getElementById("goBtn").disabled) return;
  if (document.getElementById("anaModal").classList.contains("open")) return;
  if (e.target.closest && e.target.closest(".msel")) return;
  run();
});

// ===== 初始化：恢复上次条件（含自定义指标）→ URL 参数覆盖 → 可选自动查询 =====
// 例: ?tmin=8&cmin=-8&cmax=-5&industry=半导体&auto=1
const saved = restoreFilters();
setMetricsState(saved && saved.metrics);
syncChips();
refreshSummary();
render();                            // 建表头/排序 chips/空态
// ===== 板块多选组件：页面加载即拉取列表（约500个/6页,会话内缓存）；搜索 + 多选(并集) + 一键清空 =====
let boardListData = [];           // [{code,name}]
let boardListLoading = null;
let boardSetReq = 0;              // 成分股拉取令牌：选择快速变化时只认最后一次
let boardSetErr = false;          // 成分股拉取失败警示态
const msel = document.getElementById("boardSel");
const mselBtn = msel.querySelector(".mselBtn");
const mselPanelEl = msel.querySelector(".mselPanel");
const mselSearch = msel.querySelector(".mselSearch");
const mselList = msel.querySelector(".mselList");
const mselCount = msel.querySelector(".mselCount");

// 按钮文案：≤2 个显示名称,更多显示"xx、yy 等N个"
function boardLabel() {
  if (!selectedBoards.size) return "全部板块";
  const names = [...selectedBoards].map(c => boardNameMap[c] || c);
  return names.length <= 2 ? names.join("、") : names.slice(0, 2).join("、") + " 等" + names.length + "个";
}
function syncBoardBtn() {
  mselBtn.textContent = boardLabel();
  mselBtn.title = boardSetErr
    ? "板块成分股获取失败，本次未按板块筛选（重新勾选可重试）"
    : (selectedBoards.size ? [...selectedBoards].map(c => boardNameMap[c] || c).join("、") : "");
  mselCount.textContent = "已选 " + selectedBoards.size;
  msel.classList.toggle("boardErr", boardSetErr);
}
// 按搜索词渲染选项列表（名称/代码模糊匹配）
function renderBoardOptions() {
  const kw = mselSearch.value.trim().toLowerCase();
  const items = boardListData.filter(b => !kw || b.name.toLowerCase().includes(kw) || b.code.toLowerCase().includes(kw));
  mselList.innerHTML = items.length
    ? items.map(b => `<label class="mselOpt"><input type="checkbox" value="${b.code}"${selectedBoards.has(b.code) ? " checked" : ""}><span>${esc(b.name)}</span></label>`).join("")
    : '<div class="mselEmpty">无匹配板块</div>';
}
// 拉取所有已选板块成分股并取并集（板块间独立缓存,切来切去不重复请求）
async function refreshBoardSet() {
  if (!selectedBoards.size) { boardSet = null; boardSetErr = false; syncBoardBtn(); return; }
  const req = ++boardSetReq;
  boardSetErr = false; syncBoardBtn();               // 面板内展示加载态（不弹全局 toast,避免与一键查询进度条重复）
  mselCount.textContent = "成分股加载中…";
  const sets = await Promise.all([...selectedBoards].map(bk => fetchBoardMembers(bk).catch(() => null)));
  if (req !== boardSetReq) return;                   // 等待期间选择又变了,以最后一次为准
  if (sets.includes(null)) { boardSet = null; boardSetErr = true; syncBoardBtn(); return; }
  boardSet = new Set();
  sets.forEach(s => s.forEach(c => boardSet.add(c)));
  syncBoardBtn();                                    // 恢复"已选 N"
}
// 开关下拉面板：fixed 定位贴着按钮,下方放不下则向上弹
function setBoardPanel(open) {
  msel.classList.toggle("open", open);
  if (!open) {                                       // 关闭时清空搜索词,恢复完整列表（避免残留过滤造成"板块变少"的困惑）
    mselSearch.value = "";
    if (boardListData.length) renderBoardOptions();
    return;
  }
  const r = mselBtn.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
  mselPanelEl.style.width = w + "px";
  mselPanelEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  const h = mselPanelEl.offsetHeight;
  mselPanelEl.style.top = (r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4) + "px";
  mselSearch.focus();
}
mselBtn.onclick = () => {
  if (!boardListData.length) loadBoardList().catch(() => {});   // 首次打开或上次失败时(重试)拉取
  setBoardPanel(!msel.classList.contains("open"));
};
document.addEventListener("click", e => { if (!msel.contains(e.target)) setBoardPanel(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") setBoardPanel(false); });
window.addEventListener("resize", () => { if (msel.classList.contains("open")) setBoardPanel(true); });
// 手机端页面滚动时收起（列表内部滚动除外）
window.addEventListener("scroll", e => { if (msel.classList.contains("open") && !mselList.contains(e.target)) setBoardPanel(false); }, true);
mselSearch.oninput = renderBoardOptions;
mselList.addEventListener("change", async e => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  cb.checked ? selectedBoards.add(cb.value) : selectedBoards.delete(cb.value);
  syncBoardBtn(); refreshSummary(); saveFilters();
  await refreshBoardSet();
  if (hasRun) render();
});
msel.querySelector(".mselClear").onclick = async () => {
  if (!selectedBoards.size) return;
  selectedBoards.clear();
  boardSet = null; boardSetErr = false; boardSetReq++;   // 令牌自增,作废在途的旧成分拉取
  renderBoardOptions(); syncBoardBtn(); refreshSummary(); saveFilters();
  if (hasRun) render();
};
// 板块列表：页面加载即拉取（不再等首次点击）
function loadBoardList() {
  if (boardListLoading) return boardListLoading;
  boardListLoading = fetchBoardList().then(list => {
    boardListData = list;
    boardNameMap = Object.fromEntries(list.map(b => [b.code, b.name]));
    mselBtn.disabled = false; mselBtn.title = "";
    // 恢复上次选择（兼容旧版单选存档的字符串）
    const arr = saved && (Array.isArray(saved.board) ? saved.board : saved.board ? [saved.board] : []) || [];
    arr.forEach(c => { if (boardNameMap[c]) selectedBoards.add(c); });
    renderBoardOptions(); syncBoardBtn(); refreshSummary();
    if (selectedBoards.size) refreshBoardSet();
    return list;
  }).catch(e => {
    boardListLoading = null;
    mselBtn.disabled = false; mselBtn.title = "板块列表加载失败，点击重试";
    mselList.innerHTML = '<div class="mselEmpty">板块列表加载失败</div>';
    throw e;
  });
  return boardListLoading;
}
// 首屏即拉取但不抢首渲染/主查询：等浏览器空闲再发（兜底 1.5s）;用户提前点开下拉时 onclick 会立即触发
if ("requestIdleCallback" in window)
  requestIdleCallback(() => loadBoardList().catch(() => {}), { timeout: 1500 });
else
  setTimeout(() => loadBoardList().catch(() => {}), 600);
(function () {
  const q = new URLSearchParams(location.search);
  const set = (id, v) => { if (v !== null && v !== "") document.getElementById(id).value = v; };
  set("tMin", q.get("tmin")); set("tMax", q.get("tmax"));
  set("cMin", q.get("cmin")); set("cMax", q.get("cmax"));
  if (q.get("industry")) window._presetIndustry = q.get("industry");
  refreshSummary();
  if (q.get("auto") === "1") run();
})();
