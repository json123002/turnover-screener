"use strict";
/* ===== screener-metrics.js：自定义指标 注册表 / UI / 过滤 =====
   依赖 screener-core.js 的工具函数（esc 等）；
   调用 screener-app.js 的 refreshSummary/saveFilters/render（运行时解析,加载顺序保证可用）。 */

// 基础展示列已包含的指标不再重复出列，只参与过滤
const BASE_COL_KEYS = ["f6", "f20", "f9"];

const numOrNull = v => typeof v === "number" ? v : null;
const yiOrNull = v => typeof v === "number" ? v / 1e8 : null;

// 指标注册表：k = 东财字段, disp = 原始值 → 过滤/显示用数值(如成交额转亿), fmt = 数值 → 展示文本
const METRICS = [
  { k: "f6",  name: "成交额",     unit: "亿", disp: yiOrNull,  fmt: v => v.toFixed(1) + " 亿" },
  { k: "f20", name: "总市值",     unit: "亿", disp: yiOrNull,  fmt: v => v.toFixed(1) + " 亿" },
  { k: "f21", name: "流通市值",   unit: "亿", disp: yiOrNull,  fmt: v => v.toFixed(1) + " 亿" },
  { k: "f9",  name: "市盈率",     unit: "",   disp: numOrNull, fmt: v => v.toFixed(1) },
  { k: "f23", name: "市净率",     unit: "",   disp: numOrNull, fmt: v => v.toFixed(2) },
  { k: "f7",  name: "振幅",       unit: "%",  disp: numOrNull, fmt: v => v.toFixed(2) + "%" },
  { k: "f10", name: "量比",       unit: "",   disp: numOrNull, fmt: v => v.toFixed(2) },
  { k: "f24", name: "60日涨幅",   unit: "%",  disp: numOrNull, fmt: v => v.toFixed(2) + "%" },
  { k: "f25", name: "年初至今涨幅", unit: "%", disp: numOrNull, fmt: v => v.toFixed(2) + "%" },
];

let activeMetrics = [];   // [{k, min, max}] min/max 为输入框原始字符串,空 = 不设界

function metricDef(k) { return METRICS.find(m => m.k === k); }
// 原始字段值 → 展示文本
function fmtMetric(d, raw) { const v = d.disp(raw); return v === null ? "—" : d.fmt(v); }

// ===== UI =====
function buildMetricAddOptions() {
  document.getElementById("metricAdd").innerHTML = '<option value="">+ 添加指标</option>' +
    METRICS.filter(m => !activeMetrics.some(a => a.k === m.k))
      .map(m => `<option value="${m.k}">${m.name}${m.unit ? "（" + m.unit + "）" : ""}</option>`).join("");
}

function buildMetricsUI() {
  buildMetricAddOptions();
  document.getElementById("metricsBox").innerHTML = activeMetrics.map(m => {
    const d = metricDef(m.k);
    return `<div class="metric-line" data-k="${d.k}">
      <span class="mName">${d.name}${d.unit ? `<span class="mUnit">（${d.unit}）</span>` : ""}</span>
      <input type="number" class="mMin" placeholder="最低" step="any" inputmode="decimal" value="${esc(m.min)}"> —
      <input type="number" class="mMax" placeholder="最高" step="any" inputmode="decimal" value="${esc(m.max)}">
      <button class="mDel" title="移除指标">×</button>
    </div>`;
  }).join("");
}

function addMetric(k) {
  if (!metricDef(k) || activeMetrics.some(a => a.k === k)) return;
  activeMetrics.push({ k, min: "", max: "" });
  buildMetricsUI(); refreshSummary(); saveFilters();
  if (hasRun) render();
}
function removeMetric(k) {
  activeMetrics = activeMetrics.filter(a => a.k !== k);
  buildMetricsUI(); refreshSummary(); saveFilters();
  if (hasRun) render();
}

document.getElementById("metricAdd").addEventListener("change", e => {
  if (e.target.value) addMetric(e.target.value);
});
document.getElementById("metricsBox").addEventListener("input", e => {
  const line = e.target.closest(".metric-line");
  if (!line) return;
  const m = activeMetrics.find(a => a.k === line.dataset.k);
  if (!m) return;
  m.min = line.querySelector(".mMin").value;
  m.max = line.querySelector(".mMax").value;
  saveFilters(); refreshSummary();
  if (hasRun) render();
});
document.getElementById("metricsBox").addEventListener("click", e => {
  const del = e.target.closest(".mDel");
  if (del) removeMetric(del.closest(".metric-line").dataset.k);
});

// ===== 过滤：任一指标不达标即剔除；未设区间的指标仅展示不过滤 =====
function metricPass(r) {
  for (const m of activeMetrics) {
    let lo = parseFloat(m.min), hi = parseFloat(m.max);
    if (isNaN(lo) && isNaN(hi)) continue;
    if (!isNaN(lo) && !isNaN(hi) && lo > hi) { const t = lo; lo = hi; hi = t; }
    const v = metricDef(m.k).disp(r[m.k]);
    if (v === null) return false;              // 无数据（停牌等）视为不达标
    if (!isNaN(lo) && v < lo) return false;
    if (!isNaN(hi) && v > hi) return false;
  }
  return true;
}

// ===== 供 app.js 使用的辅助 =====
function getMetricsState() { return activeMetrics.map(m => ({ k: m.k, min: m.min, max: m.max })); }
function setMetricsState(arr) {
  activeMetrics = (Array.isArray(arr) ? arr : [])
    .filter(m => m && metricDef(m.k))
    .map(m => ({ k: m.k, min: m.min || "", max: m.max || "" }));
  buildMetricsUI();
}

// 折叠面板摘要中的指标部分
function metricsSummaryPart() {
  return activeMetrics.map(m => {
    const d = metricDef(m.k);
    if (!m.min && !m.max) return d.name;
    return d.name + " " + (m.min || "") + "~" + (m.max || "∞") + (d.unit || "");
  }).join(" · ");
}

// 手机卡片附加指标文本（跳过基础列已有的,避免重复展示）
function metricCardExtras(r) {
  const s = activeMetrics.filter(m => !BASE_COL_KEYS.includes(m.k))
    .map(m => { const d = metricDef(m.k); return d.name + " " + fmtMetric(d, r[m.k]); })
    .join(" · ");
  return s ? " · " + s : "";
}

// 桌面表格需要追加的指标列（跳过基础列）
function metricExtraCols() {
  return activeMetrics.map(m => metricDef(m.k)).filter(d => !BASE_COL_KEYS.includes(d.k));
}
