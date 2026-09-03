"use strict";
/* ===== screener-core.js：配置、东财 JSONP 取数、主题、分享、工具函数 =====
   经典 script 加载,与 screener-metrics.js / screener-app.js 共享全局作用域。 */

// ===== 配置 =====
const HOSTS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"]; // 实时优先,失败退延迟
// 字段含自定义指标所需的全部列：f7 振幅 f10 量比 f21 流通市值 f23 市净率 f24 60日涨幅 f25 年初至今
const FIELDS = "f12,f14,f2,f3,f6,f7,f8,f9,f10,f20,f21,f23,f24,f25,f100";
const PAGE_SIZE = 100;          // 接口上限 100/页（pz>100 会被静默截断,已实测）
const CONCURRENCY = 4;          // 并发翻页数：实测东财接口可承受,配合间隔不触发限流
const BATCH_GAP_MS = 100;
const RETRY = 2;                // 单页失败重试次数
const RENDER_CAP = 500;         // 桌面表格渲染上限（数据完整,仅限制 DOM 行数保证流畅）
const LOAD_STEP = 60;           // 手机卡片每次加载数（无限滚动）
const IS_MOBILE = () => matchMedia("(max-width: 768px)").matches;
let allRows = [], usedHost = "", abortFlag = false;

// ===== 主题切换（手动 + 自动明暗）=====
const ICON_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyThemeIcon() {
  document.getElementById("themeBtn").innerHTML =
    document.documentElement.dataset.theme === "light" ? ICON_MOON : ICON_SUN;
}
function setTheme(theme, reason) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("ts-theme", theme); } catch (e) {}
  applyThemeIcon();
  if (reason === "manual") {
    try { localStorage.setItem("ts-theme-manual", "1"); } catch (e) {}
  }
}
function autoThemeByTime() {
  // 手动覆盖优先：用户点过按钮就记住，不再自动切换
  try { if (localStorage.getItem("ts-theme-manual")) return; } catch (e) {}
  const h = new Date().getHours();
  // 18:00 (6pm) 后 → dark；08:00 后 → light
  const want = (h >= 18 || h < 8) ? "dark" : "light";
  const cur = document.documentElement.dataset.theme || "dark";
  if (want !== cur) setTheme(want, "auto");
}
document.getElementById("themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  setTheme(next, "manual");
};
// 初始化：head 内联脚本已按 localStorage/时间设置好主题,这里只需同步图标
(function initTheme() {
  applyThemeIcon();
})();
// 每 5 分钟检查一次是否该切换（跨 8:00 / 18:00 边界）
setInterval(autoThemeByTime, 5 * 60 * 1000);

// ===== Toast =====
let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ===== 分享：优先系统分享面板，退化为复制链接 =====
document.getElementById("shareBtn").onclick = async () => {
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title: document.title, text: "Turnover Screener", url }); } catch (e) {}
  } else {
    try { await navigator.clipboard.writeText(url); toast("链接已复制，粘贴分享即可"); }
    catch (e) { prompt("复制链接分享：", url); }
  }
};

// ===== JSONP（浏览器跨域）=====
// cbName：回调参数名,东财行情接口用 cb,datacenter 报表接口用 callback
let cbSeq = 0;
function jsonp(url, cbName = "cb") {
  return new Promise((resolve, reject) => {
    const cb = "emCb" + (cbSeq++);
    const s = document.createElement("script");
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 12000);
    // cleanup 后置为 noop 而非 delete：超时后迟到的响应只会空跑,不再抛 "is not a function"
    function cleanup() { clearTimeout(timer); window[cb] = () => {}; s.remove(); }
    window[cb] = (d) => { cleanup(); resolve(d); };
    s.onerror = () => { cleanup(); reject(new Error("network")); };
    s.src = url + (url.includes("?") ? "&" : "?") + cbName + "=" + cb;
    document.head.appendChild(s);
  });
}

function buildUrl(host, pn) {
  const mkts = [...document.querySelectorAll(".mkt:checked")].map(c => c.value);
  return host + "/api/qt/clist/get?pn=" + pn + "&pz=" + PAGE_SIZE +
    "&po=1&np=1&fltt=2&invt=2&fid=f8&fs=" + encodeURIComponent(mkts.join(",")) +
    "&fields=" + FIELDS;
}

// 单页获取：记住可用 host 避免每页重复试错；失败按次数重试
async function fetchPage(pn) {
  const hosts = usedHost ? [usedHost] : HOSTS;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    for (const h of hosts) {
      try {
        const d = await jsonp(buildUrl(h, pn));
        if (d && d.data) { usedHost = h; return d.data; }
        lastErr = new Error("empty");
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}

// 个股直达：6 位代码只取单只快照（ulist.np 接口,与 clist 同一套字段口径,不做全市场翻页）
// 注:stock/get 用的是另一套 f43/f57 字段体系且缺 f24/f25/f100,故不用
async function fetchSingleStock(code) {
  const secid = (/^6/.test(code) ? "1." : "0.") + code;   // 6→沪, 0/3→深, 4/8→北(与 analysis.js 同口径)
  let lastErr;
  for (const h of HOSTS) {
    try {
      const d = await jsonp(h + "/api/qt/ulist.np/get?fltt=2&invt=2&secids=" + secid + "&fields=" + FIELDS);
      const row = d && d.data && d.data.diff && d.data.diff[0];
      if (row && row.f12) { usedHost = h; return row; }
      lastErr = new Error("未找到该代码（或接口限流，可清空搜索框做全市场查询）");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 名称→代码：东财联想搜索（searchapi, JSONP）。精确名称匹配优先,唯一 A 股结果其次;都不命中返回 null（调用方退回全市场筛选）
async function resolveStockCode(kw) {
  try {
    const d = await jsonp("https://searchapi.eastmoney.com/api/suggest/get?input=" + encodeURIComponent(kw) +
      "&type=14&token=D43BF722C8E33BD1FB2C72F8B7B0E1C0&count=10");
    const list = (d && d.QuotationCodeTable && d.QuotationCodeTable.Data) || [];
    const a = list.filter(x => x.Classify === "AStock");   // 只留 A 股,排除港股/基金/指数等
    const exact = a.filter(x => x.Name === kw);
    if (exact.length) return exact[0].Code;
    if (a.length === 1) return a[0].Code;
  } catch (e) {}
  return null;
}

// ===== 板块/业务范围 筛选数据 =====
// 通用 clist 拉取（复用 HOSTS 与重试;fs 任意：板块列表 m:90+t:3、板块成分 b:BKxxxx）
async function fetchClist(fs, fields, pn) {
  const hosts = usedHost ? [usedHost] : HOSTS;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    for (const h of hosts) {
      try {
        const d = await jsonp(h + "/api/qt/clist/get?pn=" + pn + "&pz=" + PAGE_SIZE +
          "&po=1&np=1&fltt=2&invt=2&fid=f3&fs=" + encodeURIComponent(fs) + "&fields=" + fields);
        if (d && d.data) { usedHost = h; return d.data; }
        lastErr = new Error("empty");
      } catch (e) { lastErr = e; }
    }
    if (attempt < RETRY) await new Promise(r => setTimeout(r, 300));   // 重试间隔,防限流
  }
  throw lastErr;
}
// 串行翻页：clist 类辅助接口页数少,串行+间隔比并发稳（东财有 IP 限流,已实测）
async function fetchClistAll(fs, fields, onProgress) {
  const first = await fetchClist(fs, fields, 1);
  const pages = Math.ceil((first.total || 0) / PAGE_SIZE);
  const out = [...(first.diff || [])];
  for (let pn = 2; pn <= pages; pn++) {
    await new Promise(r => setTimeout(r, BATCH_GAP_MS));
    const d = await fetchClist(fs, fields, pn);
    out.push(...(d.diff || []));
    if (onProgress) onProgress(pn, pages);
  }
  return out;
}

let _boardList = null, _boardListP = null;   // 概念板块列表 [{code:"BK0907",name:"转基因"}],会话内缓存(含在途Promise防重入)
async function fetchBoardList() {
  if (_boardList) return _boardList;
  if (_boardListP) return _boardListP;
  _boardListP = (async () => {
    const rows = await fetchClistAll("m:90+t:3", "f12,f14");
    rows.sort((a, b) => a.f14.localeCompare(b.f14, "zh"));
    _boardList = rows.map(x => ({ code: x.f12, name: x.f14 }));
    return _boardList;
  })();
  try { return await _boardListP; } finally { if (!_boardList) _boardListP = null; }   // 失败允许重试
}

const _boardMembers = {};         // 板块代码 → Set(成分股代码),会话内缓存
async function fetchBoardMembers(bk, onProgress) {
  if (_boardMembers[bk]) return _boardMembers[bk];
  const rows = await fetchClistAll("b:" + bk, "f12", onProgress);
  _boardMembers[bk] = new Set(rows.map(x => x.f12));
  return _boardMembers[bk];
}

// 全市场业务范围（datacenter F10 报表,2000 条/页约 13 页;回调参数是 callback 不是 cb）;会话内缓存
let _scopeMap = null, _scopeMapP = null;   // 股票代码 → 业务范围全文（含在途Promise防重入）
async function fetchScopeMap(onProgress) {
  if (_scopeMap) return _scopeMap;
  if (_scopeMapP) return _scopeMapP;
  _scopeMapP = (async () => {
    const base = "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_BASIC_ORGINFO" +
      "&columns=SECUCODE,BUSINESS_SCOPE&sortColumns=SECUCODE&sortTypes=1&source=HSF10&client=PC&pageSize=2000";
    const map = {};
    const eat = arr => (arr || []).forEach(x => { if (x.BUSINESS_SCOPE) map[x.SECUCODE.split(".")[0]] = x.BUSINESS_SCOPE; });
    const first = await jsonp(base + "&pageNumber=1", "callback");
    const pages = (first.result && first.result.pages) || 1;
    eat(first.result && first.result.data);
    for (let pn = 2; pn <= pages; pn++) {
      const d = await jsonp(base + "&pageNumber=" + pn, "callback");
      eat(d.result && d.result.data);
      if (onProgress) onProgress(pn, pages);
    }
    _scopeMap = map;
    return map;
  })();
  try { return await _scopeMapP; } finally { if (!_scopeMap) _scopeMapP = null; }   // 失败允许重试
}

// ===== 工具函数 =====
// 区间读取：最低>最高时自动交换，避免填反导致 0 结果
function range(minId, maxId) {
  let a = parseFloat(document.getElementById(minId).value);
  let b = parseFloat(document.getElementById(maxId).value);
  if (!isNaN(a) && !isNaN(b) && a > b) { const t = a; a = b; b = t; }
  return [a, b];
}
const fmtYiT = v => typeof v === "number" ? (v / 1e8).toFixed(1) + " 亿" : "—";  // 表格用
const fmtYiC = v => typeof v === "number" ? (v / 1e8).toFixed(1) + "亿" : "—";   // 卡片用(紧凑)
const fmtN = (v, d = 2) => typeof v === "number" ? v.toFixed(d) : "—";
const cls = v => v > 0 ? "up" : v < 0 ? "down" : "";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 排序取值：非数值("-"等)排到最后，避免字符串污染数值比较
const num = v => typeof v === "number" ? v : -Infinity;
function cmpRows(key, dir) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === "string" || typeof vb === "string")
      return String(va).localeCompare(String(vb), "zh") * dir;
    return (num(va) - num(vb)) * dir;
  };
}
// 个股详情跳转：东方财富（自动区分沪/深/北）
function quoteUrl(code) {
  if (/^6/.test(code)) return "https://quote.eastmoney.com/sh" + code + ".html";
  if (/^[48]/.test(code)) return "https://quote.eastmoney.com/bj" + code + ".html";
  return "https://quote.eastmoney.com/sz" + code + ".html";
}
