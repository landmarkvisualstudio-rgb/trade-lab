import { ASSETS, GROUPS, STRATEGIES, DEFAULT_SETTINGS, BAR_MS, WARMUP_BARS, assetBySymbol } from './config.js';
import { runSimulation, closeAllAtEnd, computeStats, BLOCK_REASONS } from './engine.js';
import { ensureHistory, klines, tickers, liveStream, pool, unavailable, netState, toSeries, mode, probe } from './data.js';
import { createCandleChart, createAreaChart, priceDecimals, sparkPath } from './chart.js';
import { prepare } from './strategies.js';
import { replay } from './timemachine.js';
import { load, save, remove, idbClear, setDemoStorage } from './store.js';

/* demo (simulated market) or live Binance data: decided before any state loads */
mode.demo = !!load('demo', false);
setDemoStorage(mode.demo);

/* ---------------- state ---------------- */
const S = {
  settings: mergeSettings(load('settings', {})),
  theme: load('theme', 'auto'),
  live: load('live', { status: 'idle' }),      // {status, start, end, settings}
  liveRes: null, liveStats: null, liveLoading: null, liveError: '',
  prices: {}, t24: {}, sparks: {},
  page: location.hash.slice(1) || 'dash', detail: null, tf: '15m',
  bt: { res: load('bt', null), running: null, days: load('btDays', 7), error: '' },
  filter: 'all', search: '', tradesTab: 'closed', tradesSrc: 'live',
  installEvt: null, seenEvents: load('seenEvents', 0), offline: false,
};
const charts = [];
const $ = sel => document.querySelector(sel);
const DAY = 86400000;

function mergeSettings(saved) {
  return {
    ...DEFAULT_SETTINGS, ...saved,
    strategies: { ...DEFAULT_SETTINGS.strategies, ...(saved.strategies || {}) },
    symbols: { ...DEFAULT_SETTINGS.symbols, ...(saved.symbols || {}) },
  };
}

/* ---------------- formatting ---------------- */
const nf = (x, d = 2) => (isFinite(x) ? x : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (x, d = 2) => (x > 0 ? '+' : x < 0 ? '−' : '') + nf(Math.abs(x), d);
const cls = x => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const fp = p => (p == null || !isFinite(p) ? '—' : nf(p, priceDecimals(p)));
const jDT = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const jD = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { weekday: 'short', month: 'long', day: 'numeric' });
const fdt = t => jDT.format(new Date(t));
function dur(ms) {
  ms = Math.max(0, ms);
  const d = Math.floor(ms / DAY), h = Math.floor(ms % DAY / 3600000), m = Math.floor(ms % 3600000 / 60000);
  if (d) return `${d} روز و ${h} ساعت`;
  if (h) return `${h} ساعت و ${m} دقیقه`;
  return `${m} دقیقه`;
}
const REASON = { target: 'هدف', stop: 'حد ضرر', time: 'پایان زمان', end: 'پایان تست' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- icons ---------------- */
const I = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="9" width="3" height="6" rx="1"/><rect x="12" y="6" width="3" height="8" rx="1"/><rect x="17" y="10" width="3" height="5" rx="1"/></svg>',
  trades: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4L3 8l4 4"/><path d="M3 8h13"/><path d="M17 20l4-4-4-4"/><path d="M21 16H8"/></svg>',
  backtest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
  install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 8v7"/><path d="M9 12l3 3 3-3"/></svg>',
  logo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M6 4v16M6 8h-1.5M6 15h1.5"/><rect x="4.5" y="8" width="3" height="7" rx=".8" fill="#fff"/><path d="M12 6v12"/><rect x="10.5" y="10" width="3" height="5" rx=".8" fill="#9ec1ff" stroke="#9ec1ff"/><path d="M18 3v15"/><rect x="16.5" y="6" width="3" height="8" rx=".8" fill="#fff"/></svg>',
};
const NAV = [['dash', 'داشبورد'], ['market', 'بازار'], ['trades', 'معاملات'], ['backtest', 'بک‌تست'], ['settings', 'تنظیمات']];

/* ---------------- theme ---------------- */
function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
  save('theme', S.theme);
  charts.forEach(c => c.redraw && c.redraw());
}
const isDark = () => S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => charts.forEach(c => c.redraw && c.redraw()));

/* ---------------- toast & notifications ---------------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast glass ${kind}`;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3800);
}
function notify(title, body) {
  if (!S.settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    navigator.serviceWorker?.ready.then(r => r.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'fa', dir: 'rtl' }))
      .catch(() => new Notification(title, { body }));
  } catch { /* */ }
}

/* ---------------- navigation ---------------- */
function go(page, detail = null) {
  S.page = page; S.detail = detail;
  history.replaceState(null, '', '#' + page);
  render();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (p && p !== S.page) { S.page = p; S.detail = null; render(); } });

function renderNav() {
  $('#nav').innerHTML = `
    <div class="brand"><span class="brand-mark">${I.logo}</span><div>ترید لب<small>آزمایشگاه معامله‌ی مجازی</small></div></div>
    ${NAV.map(([k, n]) => `<button data-go="${k}" class="${S.page === k ? 'active' : ''}" aria-label="${n}">${I[k]}<span>${n}</span></button>`).join('')}
    <div class="nav-foot">همه‌ی معاملات با پول مجازی است.<br>داده: Binance (اسپات و فیوچرز)</div>`;
  $('#nav').querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
}

function topbar(title) {
  return `<div class="topbar">
    <div class="brand"><span class="brand-mark">${I.logo}</span><div>ترید لب<small>${title}</small></div></div>
    <div class="spacer"></div>
    ${mode.demo ? '<button class="demo-pill" id="demoPill" title="خروج از حالت نمایشی">● حالت نمایشی</button>' : (S.offline || !netState.ok) ? '<span class="tag down">بدون اتصال به Binance</span>' : ''}
    <button class="btn icon" id="themeBtn" aria-label="تغییر تم">${isDark() ? I.sun : I.moon}</button>
  </div>`;
}

function render() {
  charts.splice(0).forEach(c => c.destroy());
  renderNav();
  const main = $('#main');
  const pages = { dash: pageDash, market: pageMarket, trades: pageTrades, backtest: pageBacktest, settings: pageSettings };
  (pages[S.page] || pageDash)(main);
  const tb = $('#themeBtn');
  if (tb) tb.onclick = () => { S.theme = isDark() ? 'light' : 'dark'; applyTheme(); tb.innerHTML = isDark() ? I.sun : I.moon; };
  const dp = $('#demoPill');
  if (dp) dp.onclick = async () => { if (await confirmBox('از حالت نمایشی خارج شوید و به داده‌ی زنده‌ی Binance برگردید؟ نتایج حالت نمایشی جدا نگه داشته می‌شوند.', 'خروج از نمایشی')) setDemo(false); };
  main.querySelectorAll('[data-demo-on]').forEach(b => b.onclick = () => setDemo(true));
  main.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => location.reload());
}

/* ---------------- shared pieces ---------------- */
function coin(sym, size = 38) {
  const a = assetBySymbol[sym] || { short: sym.slice(0, 3), color: '#456' };
  return `<span class="coin" style="background:linear-gradient(145deg, ${a.color}, ${shade(a.color)});width:${size}px;height:${size}px">${esc(a.short.slice(0, 4))}</span>`;
}
function shade(hex) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.round(v * 0.62)); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }

function kpiTiles(st, extra = {}) {
  const pf = st.profitFactor === Infinity ? '∞' : nf(st.profitFactor, 2);
  return `<div class="kpis">
    <div class="kpi glass flat"><div class="k">تعداد معاملات</div><div class="v num">${st.n}</div><div class="s">${st.wins} برد · ${st.losses} باخت</div></div>
    <div class="kpi glass flat"><div class="k">نرخ برد</div><div class="v num">${nf(st.winRate, 1)}%</div><div class="s">سربه‌سر با هدف ${S.settings.targetR}R: ${nf(100 / (1 + S.settings.targetR), 0)}%</div></div>
    <div class="kpi glass flat"><div class="k">فاکتور سود</div><div class="v num ${st.profitFactor >= 1 ? 'up' : st.n ? 'down' : ''}">${pf}</div><div class="s">سود کل ÷ زیان کل</div></div>
    <div class="kpi glass flat"><div class="k">میانگین هر معامله</div><div class="v num ${cls(st.avgR)}">${signed(st.avgR, 2)}R</div><div class="s">R = ریسک هر معامله</div></div>
    <div class="kpi glass flat"><div class="k">بیشترین افت حساب</div><div class="v num down">${nf(st.maxDD, 2)}%</div><div class="s num">${nf(st.maxDDusd)} USDT</div></div>
    <div class="kpi glass flat"><div class="k">کارمزد + لغزش</div><div class="v num">${nf(st.fees)}</div><div class="s">USDT پرداختی</div></div>
    <div class="kpi glass flat"><div class="k">میانگین برد / باخت</div><div class="v num"><span class="up">${nf(st.avgWin)}</span> / <span class="down">${nf(Math.abs(st.avgLoss))}</span></div><div class="s">USDT</div></div>
    <div class="kpi glass flat"><div class="k">${extra.k || 'پوزیشن باز'}</div><div class="v num">${extra.v ?? st.openCount}</div><div class="s">${extra.s || 'همین حالا'}</div></div>
  </div>`;
}

function verdictCard(st, bench) {
  let kind = 'mid', icon = '…', title, text;
  if (st.n < 30) {
    title = 'هنوز نمونه کافی نیست';
    text = `${st.n} معامله بسته شده. برای قضاوت منصفانه حداقل ۳۰ تا ۱۰۰ معامله لازم است؛ با یک هفته تست پرفشار به این عدد می‌رسیم.`;
  } else if (st.profitFactor >= 1.3 && st.pnl > 0) {
    kind = 'good'; icon = '↑'; title = 'تا اینجا سودده است';
    text = `فاکتور سود ${nf(st.profitFactor)} و میانگین ${signed(st.avgR)}R بعد از کارمزد. نتیجه‌ی یک هفته هنوز می‌تواند شانسی باشد.`;
  } else if (st.profitFactor >= 1) {
    kind = 'mid'; icon = '≈'; title = 'نزدیک سربه‌سر';
    text = `کمی سود بعد از کارمزد (فاکتور سود ${nf(st.profitFactor)}). کارمزد و لغزش ${nf(st.fees)} تتر از سود را برده است.`;
  } else {
    kind = 'bad'; icon = '↓'; title = 'تا اینجا زیان‌ده است';
    text = `فاکتور سود ${nf(st.profitFactor)} یعنی زیان‌ها از سودها بیشتر بوده. کارمزد و لغزش: ${nf(st.fees)} تتر.`;
  }
  if (bench != null) text += ` در همین بازه، نگه‌داشتن بیت‌کوین ${signed(bench, 2)}% بازده داشت.`;
  return `<div class="card glass"><div class="verdict ${kind}"><div class="badge">${icon}</div><div><b>${title}</b><p>${text}</p></div></div></div>`;
}

function breakdown(st) {
  const rows = Object.entries(STRATEGIES).map(([k, s]) => ({ k, name: s.name, ...(st.bySetup[k] || { n: 0, wins: 0, pnl: 0 }) }));
  const max = Math.max(1, ...rows.map(r => Math.abs(r.pnl)));
  const bars = rows.map(r => {
    const w = Math.abs(r.pnl) / max * 50;
    const side = r.pnl >= 0 ? `left:${50 - w}%;right:50%` : `right:${50 - w}%;left:50%`;
    // RTL: positive bars grow to the left of the center line
    return `<div class="bar-row"><div><b style="font-weight:600">${r.name}</b><div class="muted" style="font-size:11.5px">${r.n} معامله · برد ${r.n ? nf(r.wins / r.n * 100, 0) : 0}%</div></div>
      <div class="bar-track"><span class="mid"></span><div style="${side};background:var(--${r.pnl >= 0 ? 'up' : 'down'})"></div></div>
      <div class="num ${cls(r.pnl)}" style="font-weight:700;min-width:70px;text-align:left">${signed(r.pnl)}</div></div>`;
  }).join('');
  const syms = Object.entries(st.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  const symRows = syms.length ? syms.map(([s, v]) => `<div class="row">${coin(s, 32)}<div class="main"><div class="t1">${esc(assetBySymbol[s]?.name || s)}</div><div class="t2">${v.n} معامله · برد ${nf(v.wins / v.n * 100, 0)}%</div></div><div class="end"><div class="t1 num ${cls(v.pnl)}">${signed(v.pnl)}</div></div></div>`).join('') : '<div class="empty">هنوز معامله‌ای نیست</div>';
  return `<div class="card glass"><h3>عملکرد هر مهارت (ستاپ) <span class="muted">سود/زیان خالص USDT</span></h3><div class="bars">${bars}</div></div>
    <div class="card glass"><h3>عملکرد هر دارایی</h3><div class="list">${symRows}</div></div>`;
}

function blockedCard(res) {
  const entries = Object.entries(res.blocked || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return `<details class="more card glass"><summary>سیگنال‌هایی که مدیر ریسک رد کرد (${entries.reduce((a, x) => a + x[1], 0)}) ▾</summary>
    <div class="list" style="margin-top:8px">${entries.map(([k, n]) => `<div class="row"><div class="main"><div class="t1">${BLOCK_REASONS[k] || k}</div></div><div class="end num">${n}</div></div>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">کل سیگنال‌های اسکنر: ${res.signals}. هر سیگنال اول از فیلتر trader-risk و trader-budget رد می‌شود و بعد وارد معامله می‌شود.</p></details>`;
}

function tradeRow(x, live = false) {
  const a = assetBySymbol[x.symbol];
  const px = live ? (S.prices[x.symbol] ?? S.liveRes?.lastClose[x.symbol] ?? x.entry) : x.exit;
  const pnl = live ? (px - x.entry) * x.qty * x.dir - x.entryFee : x.pnl;
  const R = pnl / x.riskUSDT;
  const side = x.dir > 0 ? '<span class="tag up">خرید</span>' : '<span class="tag down">فروش</span>';
  const reason = live ? `<span class="tag">باز</span>` : `<span class="tag ${x.reason === 'target' ? 'up' : x.reason === 'stop' ? 'down' : ''} reason">${REASON[x.reason]}</span>`;
  return `<div class="row trade click" data-sym="${x.symbol}">${coin(x.symbol)}
    <div class="main"><div class="t1">${esc(a?.name || x.symbol)} ${side} ${reason}</div>
    <div class="t2">${STRATEGIES[x.setup]?.name} · <span class="num">${fp(x.entry)} → ${fp(px)}</span> · حد ضرر <span class="num">${fp(x.stop)}</span> · هدف <span class="num">${fp(x.target)}</span></div>
    <div class="t2">${fdt(x.entryTime)}${live ? '' : ' تا ' + fdt(x.exitTime)} · <span class="num">${nf(x.notional)}</span> USDT</div></div>
    <div class="end"><div class="t1 num ${cls(pnl)}">${signed(pnl)}</div><div class="t2 num ${cls(R)}">${signed(R, 2)}R</div></div></div>`;
}

function benchmark(res, data) {
  const s = data?.BTCUSDT; if (!s || !res) return null;
  let i0 = s.t.findIndex(t => t >= res.start); if (i0 < 0) return null;
  let i1 = s.t.length - 1; while (i1 > 0 && s.t[i1] >= res.end) i1--;
  return (s.c[i1] / s.o[i0] - 1) * 100;
}

/* ---------------- live test ---------------- */
let liveData = null, refreshing = false, lastRefreshBar = 0;

async function refreshLive(force = false) {
  const L = S.live;
  if (!L || (L.status !== 'running' && L.status !== 'done') || refreshing) return;
  const nowBar = Math.floor(Date.now() / BAR_MS) * BAR_MS;
  if (!force && nowBar === lastRefreshBar && S.liveRes) return;
  refreshing = true;
  const to = Math.min(nowBar, L.end);
  const from = L.start - WARMUP_BARS * BAR_MS;
  const syms = ASSETS.map(a => a.symbol).filter(s => L.settings.symbols[s] && !unavailable.has(s));
  S.liveLoading = { done: 0, total: syms.length };
  updateLoading();
  try {
    const data = {};
    await pool(syms, 4, async s => {
      try { data[s] = await ensureHistory(s, from, to); } catch { /* unavailable */ }
      S.liveLoading.done++; updateLoading();
    });
    if (!Object.keys(data).length) throw new Error('no data');
    let res = runSimulation({ data, settings: L.settings, start: L.start, end: Math.min(to, L.end), capital: L.settings.capital });
    if (Date.now() >= L.end && res.lastTime >= L.end - BAR_MS * 2) {
      res = closeAllAtEnd(res, L.settings);
      if (L.status !== 'done') { L.status = 'done'; save('live', L); toast('تست یک‌هفته‌ای تمام شد. نتیجه‌ی نهایی آماده است.'); notify('ترید لب', 'تست تمام شد. نتیجه‌ی نهایی آماده است.'); }
    }
    liveData = data;
    S.liveRes = res; S.liveError = '';
    lastRefreshBar = nowBar;
    announce(res);
    save('liveSnap', { at: Date.now(), stats: computeStats(res), equity: thin(res.equity, 300) });
  } catch (e) {
    S.liveError = 'دریافت داده از Binance ممکن نشد. اتصال اینترنت یا VPN را بررسی کنید.'; S.offline = true;
  } finally {
    refreshing = false; S.liveLoading = null;
    if (['dash', 'trades'].includes(S.page) && !S.detail) render();
  }
}

function announce(res) {
  const ev = res.events.filter(e => e.type === 'entry' || e.type === 'exit');
  if (ev.length < S.seenEvents) S.seenEvents = 0;
  const fresh = ev.slice(S.seenEvents);
  S.seenEvents = ev.length; save('seenEvents', S.seenEvents);
  if (fresh.length > 8) { toast(`${fresh.length} رویداد جدید از آخرین بازدید ثبت شد`); return; }
  for (const e of fresh.slice(-3)) {
    const n = assetBySymbol[e.symbol]?.name || e.symbol;
    if (e.type === 'entry') { const m = `ورود ${e.dir > 0 ? 'خرید' : 'فروش'} ${n} · ${STRATEGIES[e.setup]?.name}`; toast(m); notify('معامله‌ی جدید', m); }
    else { const m = `خروج ${n} (${REASON[e.reason]}): ${signed(e.pnl)} USDT`; toast(m, e.pnl >= 0 ? 'up' : 'down'); notify('معامله بسته شد', m); }
  }
}

function thin(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; const out = []; for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * step)]); out.push(arr[arr.length - 1]); return out; }

function updateLoading() {
  const el = $('#liveLoading');
  if (el) el.innerHTML = S.liveLoading ? `<span class="loader"></span> دریافت داده‌ی بازار ${S.liveLoading.done}/${S.liveLoading.total}` : '';
}

function startLive() {
  const start = Math.ceil(Date.now() / BAR_MS) * BAR_MS;
  S.live = { status: 'running', start, end: start + S.settings.testDays * DAY, settings: JSON.parse(JSON.stringify(S.settings)) };
  save('live', S.live); S.seenEvents = 0; save('seenEvents', 0);
  S.liveRes = null; lastRefreshBar = 0;
  toast('تست شروع شد. ربات از کندل ۵ دقیقه‌ای بعدی معامله می‌کند.');
  if (S.settings.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  render(); refreshLive(true);
}
async function stopLive() {
  if (!(await confirmBox('تست الان تمام شود؟ پوزیشن‌های باز با آخرین قیمت بسته می‌شوند.', 'پایان تست'))) return;
  S.live.end = Math.floor(Date.now() / BAR_MS) * BAR_MS;
  save('live', S.live); refreshLive(true);
}
async function resetLive() {
  if (S.live.status === 'running' && !(await confirmBox('نتیجه‌ی تست فعلی پاک شود و تست تازه شروع شود؟', 'شروع دوباره'))) return;
  S.live = { status: 'idle' }; save('live', S.live); remove('liveSnap'); S.liveRes = null; render();
}
function confirmBox(msg, okText = 'تأیید') {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal glass" role="dialog" aria-modal="true"><p>${esc(msg)}</p><div class="acts"><button class="btn primary" data-ok>${esc(okText)}</button><button class="btn" data-no>انصراف</button></div></div>`;
    const done = v => { wrap.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-ok]').onclick = () => done(true);
    wrap.querySelector('[data-no]').onclick = () => done(false);
    document.addEventListener('keydown', key);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok]').focus();
  });
}

/* ---------------- offline / demo ---------------- */
function setDemo(on) { save('demo', on); location.reload(); }
function offlineCard() {
  if (mode.demo) return `<div class="note warn" style="margin-bottom:14px"><b>حالت نمایشی:</b> قیمت‌ها و کندل‌ها شبیه‌سازی‌شده‌اند، نه بازار واقعی. این حالت برای دیدن کارکرد اپ است و سود و زیانش چیزی درباره‌ی کارایی سیستم در بازار واقعی نمی‌گوید.</div>`;
  if (!S.offline) return '';
  return `<div class="card glass offline-card"><div class="txt"><b>اتصال به Binance برقرار نشد</b>
    <p>این دستگاه به داده‌ی بازار دسترسی ندارد. در ایران معمولاً VPN لازم است. صفحه‌ی claude.ai هم اجازه‌ی اتصال به سایت‌های بیرونی را نمی‌دهد؛ برای داده‌ی زنده، اپ را از لینک خودش (GitHub Pages یا Netlify) باز کنید.</p></div>
    <div class="hero-actions" style="margin:0"><button class="btn sm" data-retry>${I.refresh} تلاش دوباره</button><button class="btn sm primary" data-demo-on>${I.play} حالت نمایشی</button></div></div>`;
}

/* ---------------- page: dashboard ---------------- */
function pageDash(main) {
  const L = S.live;
  if (L.status === 'idle') {
    main.innerHTML = `<div class="page">${topbar('داشبورد')}${offlineCard()}
      <div class="dash-grid">
        <div class="card glass hero">
          <div class="hero-top"><span class="status"><span class="dot"></span> آماده‌ی شروع</span></div>
          <div class="label" style="margin-top:14px">سرمایه‌ی مجازی</div>
          <div class="equity num">${nf(S.settings.capital, 0)}<small>USDT</small></div>
          <p class="muted" style="margin:6px 0 0;max-width:560px">ربات با پول مجازی و روی قیمت واقعی بازار، به‌صورت خودکار معامله می‌کند: اسکنر ستاپ پیدا می‌کند، برنامه‌ی خروج حد ضرر و هدف را می‌گذارد، مدیر بودجه حجم را تعیین می‌کند و مدیر ریسک معامله‌های پرخطر را رد می‌کند. بعد از ${S.settings.testDays} روز معلوم می‌شود این سیستم چقدر سود یا ضرر داده است.</p>
          <div class="hero-actions">
            <button class="btn primary" id="startBtn">${I.play} شروع تست ${S.settings.testDays} روزه</button>
            <button class="btn" data-go2="backtest">${I.backtest} اول یک بک‌تست سریع</button>
          </div>
        </div>
        <div class="card glass">
          <h3>چطور کار می‌کند</h3>
          <div class="list">
            ${[['۱', 'اسکنر', '۵ ستاپ روی کندل‌های ۵ دقیقه‌ای ۱۷ دارایی'], ['۲', 'ورود', 'فقط بعد از بسته شدن کندل؛ با قیمت باز کندل بعد'], ['۳', 'خروج', `حد ضرر قبل از ورود، هدف ${S.settings.targetR}R، حداکثر ${S.settings.maxHoldHours} ساعت`], ['۴', 'بودجه و ریسک', `ریسک هر معامله ${S.settings.riskPct}% و حد ضرر روزانه ${S.settings.dailyLossPct}%`], ['۵', 'کارمزد واقعی', `کارمزد ${S.settings.feeSpotPct}% و لغزش ${S.settings.slippagePct}% در هر معامله کم می‌شود`]]
              .map(([n, a, b]) => `<div class="row"><span class="coin" style="background:linear-gradient(145deg,#2c4fb0,#0a1838)">${n}</span><div class="main"><div class="t1">${a}</div><div class="t2" style="white-space:normal">${b}</div></div></div>`).join('')}
          </div>
          <p class="note" style="margin:12px 0 0">اگر اپ را ببندید ربات متوقف نمی‌شود: با باز کردن دوباره، کندل‌های جاافتاده از Binance گرفته و دقیقاً همان معامله‌ها بازسازی می‌شوند.</p>
        </div>
      </div></div>`;
    $('#startBtn').onclick = startLive;
    main.querySelector('[data-go2]').onclick = () => go('backtest');
    return;
  }

  const res = S.liveRes;
  const snap = !res ? load('liveSnap', null) : null;
  const st = res ? computeStats(res, S.prices) : snap?.stats;
  const now = Date.now();
  const done = L.status === 'done';
  const prog = Math.min(100, Math.max(0, (Math.min(now, L.end) - L.start) / (L.end - L.start) * 100));
  const statusHtml = done ? '<span class="status done"><span class="dot"></span> تست تمام شد</span>'
    : now < L.start ? '<span class="status run"><span class="dot"></span> منتظر اولین کندل</span>'
    : '<span class="status run"><span class="dot"></span> ربات در حال معامله</span>';
  const bench = res && liveData ? benchmark(res, liveData) : null;

  main.innerHTML = `<div class="page">${topbar('داشبورد')}${offlineCard()}
    ${S.liveError ? `<div class="note warn" style="margin-bottom:12px">${S.liveError}</div>` : ''}
    <div class="dash-grid">
      <div class="card glass hero">
        <div class="hero-top">${statusHtml}<span class="muted" id="liveLoading" style="font-size:12.5px"></span></div>
        <div class="label" style="margin-top:14px">ارزش حساب مجازی</div>
        <div class="equity num" id="eqVal">${st ? nf(st.equity) : '<span class="skeleton">1,000.00</span>'}<small>USDT</small></div>
        <div class="pnl-row" id="pnlRow">${st ? pnlPills(st, L.settings.capital) : ''}</div>
        <div class="subrow"><span>سود قطعی: <b class="num ${cls(st?.realized)}">${st ? signed(st.realized) : '—'}</b></span><span>سود شناور: <b class="num ${cls(st?.unrealized)}" id="unrealVal">${st ? signed(st.unrealized) : '—'}</b></span><span>سرمایه‌ی اولیه: <b class="num">${nf(L.settings.capital, 0)}</b></span></div>
        <div class="progress"><div style="width:${prog}%"></div></div>
        <div class="progress-meta"><span>${jD.format(new Date(L.start))}</span><span>${done ? 'پایان: ' + jD.format(new Date(L.end)) : 'باقی‌مانده: ' + dur(L.end - now)}</span></div>
        <div class="hero-actions">
          <button class="btn sm" id="refreshBtn">${I.refresh} به‌روزرسانی</button>
          ${done ? `<button class="btn sm primary" id="newBtn">${I.play} تست تازه</button>` : `<button class="btn sm danger" id="stopBtn">${I.stop} پایان زودهنگام</button>`}
          ${done ? '' : `<button class="btn sm" id="resetBtn">شروع دوباره</button>`}
        </div>
      </div>
      ${st ? verdictCard(st, bench) : '<div class="card glass"><div class="empty"><span class="loader"></span><br>در حال ساخت نتیجه از کندل‌های بازار…</div></div>'}
      <div class="span-2">${st ? kpiTiles(st, { k: 'سیگنال اسکنر', v: res?.signals ?? '—', s: `${st.openCount} پوزیشن باز` }) : ''}</div>
      <div class="card glass span-2"><h3>منحنی سرمایه <span class="muted">هر نقطه = بسته شدن یک کندل ۵ دقیقه‌ای</span></h3><div class="chart-box" id="eqChart"></div></div>
      <div class="card glass"><h3>پوزیشن‌های باز <span class="muted">قیمت زنده</span></h3><div class="list" id="openList">${openList()}</div></div>
      <div class="card glass"><h3>آخرین معاملات <span class="muted"><a href="#trades">همه</a></span></h3><div class="list">${res && res.closed.length ? res.closed.slice(-6).reverse().map(x => tradeRow(x)).join('') : '<div class="empty">هنوز معامله‌ای بسته نشده</div>'}</div></div>
      ${st && st.n ? `<div class="span-2 grid cols-2">${breakdown(st)}</div>` : ''}
      ${res ? `<div class="span-2">${blockedCard(res)}</div>` : ''}
    </div></div>`;
  const eq = createAreaChart($('#eqChart'), { base: L.settings.capital, emptyText: 'منحنی سرمایه بعد از اولین کندل‌ها رسم می‌شود' });
  charts.push(eq);
  eq.setData(res ? thin(res.equity, 600).concat(res.equity.length ? [[Date.now(), st.equity]] : []) : snap?.equity || [], L.settings.capital);
  $('#refreshBtn').onclick = () => refreshLive(true);
  $('#stopBtn') && ($('#stopBtn').onclick = stopLive);
  $('#resetBtn') && ($('#resetBtn').onclick = resetLive);
  $('#newBtn') && ($('#newBtn').onclick = () => { S.live = { status: 'idle' }; save('live', S.live); render(); });
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
  updateLoading();
}
const pnlPills = (st, cap) => `<span class="pill ${st.pnl >= 0 ? 'up' : 'down'} num">${signed(st.pnl)} USDT</span><span class="pill ${st.pnl >= 0 ? 'up' : 'down'} num">${signed(st.pnl / cap * 100)}%</span>`;
function openList() {
  const res = S.liveRes;
  if (!res || !res.open.length) return '<div class="empty">پوزیشن بازی نیست</div>';
  return res.open.map(x => tradeRow(x, true)).join('');
}

// light refresh on price ticks
function onPrices() {
  if (S.page === 'dash' && S.liveRes && !S.detail) {
    const st = computeStats(S.liveRes, S.prices);
    const e = $('#eqVal'); if (e) e.innerHTML = `${nf(st.equity)}<small>USDT</small>`;
    const p = $('#pnlRow'); if (p) p.innerHTML = pnlPills(st, S.live.settings.capital);
    const u = $('#unrealVal'); if (u) { u.textContent = signed(st.unrealized); u.className = 'num ' + cls(st.unrealized); }
    const o = $('#openList'); if (o) { o.innerHTML = openList(); o.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym)); }
  }
  document.querySelectorAll('[data-price]').forEach(el => { const s = el.dataset.price; if (S.prices[s] != null) el.textContent = fp(S.prices[s]); });
  document.querySelectorAll('[data-chg]').forEach(el => {
    const t = S.t24[el.dataset.chg]; if (!t) return;
    el.textContent = signed(t.changePct) + '%'; el.className = `tag ${t.changePct >= 0 ? 'up' : 'down'} num`;
  });
}

/* ---------------- page: market ---------------- */
function pageMarket(main) {
  if (S.detail) return pageDetail(main, S.detail);
  const list = ASSETS.filter(a => (S.filter === 'all' || a.group === S.filter) &&
    (!S.search || a.name.includes(S.search) || a.symbol.toLowerCase().includes(S.search.toLowerCase())));
  main.innerHTML = `<div class="page">${topbar('بازار')}${offlineCard()}
    <div class="toolbar">
      <label class="search glass flat">${I.search}<input id="q" placeholder="جستجو: بیت‌کوین، طلا، نفت…" value="${esc(S.search)}"></label>
      <div class="chips">${[['all', 'همه'], ...Object.entries(GROUPS)].map(([k, n]) => `<button class="chip ${S.filter === k ? 'active' : ''}" data-f="${k}">${n}</button>`).join('')}</div>
    </div>
    <div class="card glass"><div class="list">
      ${list.map(a => {
        const t = S.t24[a.symbol];
        const un = unavailable.has(a.symbol);
        const sp = S.sparks[a.symbol];
        const col = sp && sp[sp.length - 1] >= sp[0] ? 'var(--up)' : 'var(--down)';
        return `<div class="row click" data-sym="${a.symbol}">${coin(a.symbol)}
          <div class="main"><div class="t1">${esc(a.name)}</div><div class="t2"><span class="ltr">${a.symbol}</span> · ${GROUPS[a.group]}${a.market === 'futures' ? ' · قرارداد دائمی' : ''}</div></div>
          ${sp ? `<svg class="spark" viewBox="0 0 76 28" preserveAspectRatio="none"><path d="${sparkPath(sp, 76, 28)}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/></svg>` : '<span class="spark"></span>'}
          <div class="end"><div class="t1 num" data-price="${a.symbol}">${un ? '—' : fp(S.prices[a.symbol] ?? t?.last)}</div>
          <div class="t2">${un ? '<span class="tag">در دسترس نیست</span>' : t ? `<span class="tag ${t.changePct >= 0 ? 'up' : 'down'} num" data-chg="${a.symbol}">${signed(t.changePct)}%</span>` : '<span class="skeleton">+0.00%</span>'}</div></div></div>`;
      }).join('') || '<div class="empty">چیزی پیدا نشد</div>'}
    </div></div>
    <p class="muted" style="font-size:12px;margin:12px 4px">${mode.demo ? 'حالت نمایشی: قیمت‌ها شبیه‌سازی‌شده‌اند. ' : ''}قیمت‌ها زنده از Binance. طلا، نقره، مس و نفت از قراردادهای دائمی USDT همین صرافی می‌آیند؛ PAXG توکن طلای فیزیکی است. تغییر ۲۴ ساعته.</p>
  </div>`;
  const q = $('#q');
  q.oninput = () => { S.search = q.value; const pos = q.selectionStart; pageMarket(main); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
  main.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filter = b.dataset.f; pageMarket(main); });
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
  loadSparks();
}
let sparkAt = 0;
async function loadSparks() {
  if (Date.now() - sparkAt < 10 * 60000) return;
  sparkAt = Date.now();
  await pool(ASSETS.map(a => a.symbol).filter(s => !unavailable.has(s)), 4, async s => {
    try { const r = await klines(s, '1h', { limit: 24 }); S.sparks[s] = r.map(x => x[4]); } catch { /* */ }
  });
  if (S.page === 'market' && !S.detail) render();
}

function openDetail(sym) { S.page = 'market'; S.detail = sym; history.replaceState(null, '', '#market'); render(); window.scrollTo({ top: 0 }); }

const TFS = [['1m', '۱ دقیقه', '۱د'], ['5m', '۵ دقیقه', '۵د'], ['15m', '۱۵ دقیقه', '۱۵د'], ['1h', '۱ ساعت', '۱س'], ['4h', '۴ ساعت', '۴س'], ['1d', 'روزانه', 'روز']];
let detailTimer = null;
function pageDetail(main, sym) {
  const a = assetBySymbol[sym];
  const t = S.t24[sym];
  const res = S.liveRes;
  const mine = res ? res.closed.filter(x => x.symbol === sym) : [];
  const openPos = res ? res.open.find(x => x.symbol === sym) : null;
  main.innerHTML = `<div class="page">${topbar('بازار')}
    <button class="back" id="backBtn">${I.back} بازار</button>
    <div class="card glass">
      <div class="detail-head">${coin(sym, 44)}<div><div style="font-weight:800;font-size:17px">${esc(a.name)}</div><div class="muted ltr" style="font-size:12px">${sym}</div></div>
        <div style="margin-inline-start:auto;text-align:left"><div class="price num" data-price="${sym}">${fp(S.prices[sym] ?? t?.last)}</div>
        ${t ? `<span class="tag ${t.changePct >= 0 ? 'up' : 'down'} num" data-chg="${sym}">${signed(t.changePct)}%</span>` : ''}</div></div>
      <div class="toolbar" style="justify-content:space-between;margin:6px 0 4px"><div class="seg" id="tfSeg">${TFS.map(([k, n, sh]) => `<button data-tf="${k}" title="${n}" class="${S.tf === k ? 'active' : ''}"><span class="tf-l">${n}</span><span class="tf-s">${sh}</span></button>`).join('')}</div></div>
      <div class="chart-big" id="candles"></div>
      <div class="legend"><span><i style="background:var(--ma1)"></i>میانگین ۲۰</span><span><i style="background:var(--ma2)"></i>میانگین ۵۰</span><span>▲ ورود ربات · ● خروج</span><span>بکشید = جابه‌جایی، دو انگشت یا اسکرول = زوم، دابل‌کلیک = بازگشت</span></div>
      <div class="stats-strip">
        <div class="stat"><div class="k">بیشترین ۲۴ساعته</div><div class="v num">${fp(t?.high)}</div></div>
        <div class="stat"><div class="k">کمترین ۲۴ساعته</div><div class="v num">${fp(t?.low)}</div></div>
        <div class="stat"><div class="k">حجم ۲۴ساعته (USDT)</div><div class="v num">${t ? nf(t.quoteVol / 1e6, 1) + 'M' : '—'}</div></div>
        <div class="stat"><div class="k">معاملات ربات روی این نماد</div><div class="v num">${mine.length}${mine.length ? ` · <span class="${cls(mine.reduce((s, x) => s + x.pnl, 0))}">${signed(mine.reduce((s, x) => s + x.pnl, 0))}</span>` : ''}</div></div>
      </div>
    </div>
    <div class="sep"></div>
    <div class="grid cols-2">
      <div class="card glass" id="tmCard"><h3>ماشین زمان <span class="muted">trader-timemachine</span></h3><div class="empty"><span class="loader"></span></div></div>
      <div class="card glass"><h3>معاملات ربات روی ${esc(a.name)}</h3><div class="list">${openPos ? tradeRow(openPos, true) : ''}${mine.slice(-8).reverse().map(x => tradeRow(x)).join('') || (openPos ? '' : '<div class="empty">ربات هنوز روی این نماد معامله نکرده</div>')}</div></div>
    </div></div>`;
  $('#backBtn').onclick = () => { S.detail = null; render(); };
  const ch = createCandleChart($('#candles'), { emptyText: 'در حال دریافت نمودار…' });
  charts.push(ch);
  // markers + position lines
  const all = res ? [...res.closed, ...res.open].filter(x => x.symbol === sym) : [];
  const markers = [];
  for (const x of all) {
    markers.push({ time: x.entryTime, price: x.entry, shape: x.dir > 0 ? 'up' : 'down', color: x.dir > 0 ? cssVar('--up') : cssVar('--down') });
    if (x.exitTime) markers.push({ time: x.exitTime - BAR_MS, price: x.exit, shape: 'dot', color: x.pnl >= 0 ? cssVar('--up') : cssVar('--down') });
  }
  ch.setMarkers(markers);
  if (openPos) ch.setLines([{ price: openPos.entry, color: '#7aa2ff', text: 'ورود' }, { price: openPos.stop, color: cssVar('--down'), text: 'حد ضرر' }, { price: openPos.target, color: cssVar('--up'), text: 'هدف' }]);
  let rows = [];
  const loadChart = async () => {
    try { rows = await klines(sym, S.tf, { limit: 500 }); ch.setData(rows); } catch { ch.setData([]); }
  };
  loadChart();
  clearInterval(detailTimer);
  detailTimer = setInterval(async () => {
    if (S.page !== 'market' || S.detail !== sym) return clearInterval(detailTimer);
    try {
      const last = await klines(sym, S.tf, { limit: 2 });
      for (const r of last) { const k = rows.findIndex(x => x[0] === r[0]); if (k >= 0) rows[k] = r; else if (!rows.length || r[0] > rows[rows.length - 1][0]) rows.push(r); }
      ch.setData(rows);
    } catch { /* */ }
  }, 15000);
  S.onDetailTick = p => ch.updateLast(p);
  main.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => {
    S.tf = b.dataset.tf; main.querySelectorAll('[data-tf]').forEach(x => x.classList.toggle('active', x === b)); ch.setData([]); loadChart();
  });
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => {});
  timeMachinePanel(sym);
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

async function timeMachinePanel(sym) {
  const el = $('#tmCard'); if (!el) return;
  try {
    const rows = await klines(sym, '5m', { limit: 1000 });
    const p = prepare(toSeries(rows));
    const i = p.t.length - 1;
    const entry = S.prices[sym] ?? p.c[i];
    const R = S.settings.targetR;
    const risk = 1.5 * p.atr14[i];
    const stop = entry - risk, target = entry + R * risk;
    const horizon = Math.round(S.settings.maxHoldHours * 12);
    const tm = replay(p, i, { entry, stop, target, dir: 1, horizon, replays: 2000, seed: 19 });
    if (!tm) throw new Error();
    const w = x => (x * 100).toFixed(1);
    el.innerHTML = `<h3>ماشین زمان <span class="muted">۲,۰۰۰ تکرار · seed ${tm.seed}</span></h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 6px">اگر همین حالا با قیمت <b class="num">${fp(entry)}</b> بخریم، حد ضرر <b class="num">${fp(stop)}</b> (۱.۵ ATR) و هدف <b class="num">${fp(target)}</b> (${R}R)، در ${S.settings.maxHoldHours} ساعت آینده چه می‌شود؟ شبیه‌سازی از شکل کندل‌های ۱۰۰۰ کندل اخیر خود این دارایی.</p>
      <div class="stack"><div style="width:${w(tm.pTarget)}%;background:var(--up)"></div><div style="width:${w(tm.pNeither)}%;background:var(--muted);opacity:.4"></div><div style="width:${w(tm.pStop)}%;background:var(--down)"></div></div>
      <div class="odds"><div class="stat"><div class="k">اول هدف</div><div class="v num up">${w(tm.pTarget)}%</div></div><div class="stat"><div class="k">هیچ‌کدام</div><div class="v num">${w(tm.pNeither)}%</div></div><div class="stat"><div class="k">اول حد ضرر</div><div class="v num down">${w(tm.pStop)}%</div></div></div>
      <div class="note"><b>${tm.verdict}</b> · برای سربه‌سر با هدف ${R}R باید ${nf(tm.breakeven * 100, 0)}% از برخوردها به هدف برسد؛ شد ${nf((tm.share || 0) * 100, 1)}%. میانگین <span class="num">${signed(tm.avgR)}R</span>. قیمت پایان: میانه <span class="num">${fp(tm.median)}</span>، ۹۰٪ بین <span class="num">${fp(tm.p5)}</span> و <span class="num">${fp(tm.p95)}</span>.<br>این شبیه‌سازی است، نه پیش‌بینی؛ خبر و رویداد می‌تواند کاری کند که در این کندل‌ها نبوده.</div>`;
  } catch {
    el.innerHTML = '<h3>ماشین زمان</h3><div class="empty">داده‌ی کافی برای شبیه‌سازی دریافت نشد</div>';
  }
}

/* ---------------- page: trades ---------------- */
function pageTrades(main) {
  const res = S.tradesSrc === 'live' ? S.liveRes : S.bt.res;
  const closed = res ? [...res.closed].reverse() : [];
  const openT = S.tradesSrc === 'live' && res ? res.open : [];
  main.innerHTML = `<div class="page">${topbar('معاملات')}
    <div class="toolbar">
      <div class="seg">${[['live', 'تست زنده'], ['bt', 'بک‌تست']].map(([k, n]) => `<button data-src="${k}" class="${S.tradesSrc === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <div class="seg">${[['closed', `بسته (${closed.length})`], ['open', `باز (${openT.length})`]].map(([k, n]) => `<button data-tab="${k}" class="${S.tradesTab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <div style="flex:1"></div>
      <button class="btn sm" id="csvBtn" ${closed.length ? '' : 'disabled'}>${I.download} خروجی CSV</button>
    </div>
    <div class="card glass"><div class="list">
      ${S.tradesTab === 'open' ? (openT.map(x => tradeRow(x, true)).join('') || '<div class="empty">پوزیشن بازی نیست</div>')
        : (closed.slice(0, 300).map(x => tradeRow(x)).join('') || `<div class="empty">${res ? 'هنوز معامله‌ای بسته نشده' : S.tradesSrc === 'live' ? 'تست زنده هنوز شروع نشده' : 'هنوز بک‌تستی اجرا نشده'}</div>`)}
      ${closed.length > 300 && S.tradesTab === 'closed' ? `<div class="empty">${closed.length - 300} معامله‌ی قدیمی‌تر در فایل CSV هست</div>` : ''}
    </div></div></div>`;
  main.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { S.tradesSrc = b.dataset.src; render(); });
  main.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tradesTab = b.dataset.tab; render(); });
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
  $('#csvBtn').onclick = () => exportCSV(closed);
}
function exportCSV(trades) {
  const head = ['id', 'symbol', 'setup', 'side', 'entry_time', 'entry', 'stop', 'target', 'qty', 'notional_usdt', 'risk_usdt', 'exit_time', 'exit', 'reason', 'fees_usdt', 'pnl_usdt', 'R'];
  const lines = [head.join(',')].concat(trades.map(x => [x.id, x.symbol, x.setup, x.dir > 0 ? 'long' : 'short', new Date(x.entryTime).toISOString(), x.entry, x.stop, x.target, x.qty, x.notional.toFixed(2), x.riskUSDT.toFixed(2), new Date(x.exitTime).toISOString(), x.exit, x.reason, x.fees.toFixed(4), x.pnl.toFixed(4), x.R.toFixed(3)].join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const filename = `trade-lab-${S.tradesSrc}-${new Date().toISOString().slice(0, 10)}.csv`;
  if (window.claude?.use) { // inside claude.ai the viewer offers the file
    window.claude.use('downloads').then(dl => {
      if (!dl) return toast('دانلود فایل در این صفحه در دسترس نیست');
      dl.save({ filename, data: blob }).catch(e => { if (e?.code !== 'declined') toast('ذخیره‌ی فایل انجام نشد'); });
    });
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trade-lab-${S.tradesSrc}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------- page: backtest ---------------- */
function pageBacktest(main) {
  const B = S.bt;
  const res = B.res;
  const st = res ? computeStats(res) : null;
  main.innerHTML = `<div class="page">${topbar('بک‌تست')}${offlineCard()}
    <div class="card glass hero">
      <div class="label">تست سریع روی گذشته</div>
      <p class="muted" style="margin:4px 0 12px">همان ربات و همان قوانین تنظیمات، روی کندل‌های واقعی چند روز گذشته اجرا می‌شود و در چند ثانیه نتیجه می‌دهد. از ${nf(S.settings.capital, 0)} تتر مجازی شروع می‌کند.</p>
      <div class="toolbar" style="margin:0">
        <div class="seg">${[3, 7, 14, 30].map(d => `<button data-days="${d}" class="${B.days === d ? 'active' : ''}">${d} روز</button>`).join('')}</div>
        <button class="btn primary" id="runBt" ${B.running ? 'disabled' : ''}>${B.running ? `<span class="loader"></span> ${B.running}` : `${I.play} اجرا`}</button>
      </div>
      ${B.error ? `<div class="note warn" style="margin-top:12px">${B.error}</div>` : ''}
    </div>
    <div class="sep"></div>
    ${st ? `<div class="dash-grid">
      <div class="card glass hero">
        <div class="hero-top"><span class="status done"><span class="dot"></span> ${res.days || ''} روز · ${jD.format(new Date(res.start))} تا ${jD.format(new Date(res.end))}</span></div>
        <div class="label" style="margin-top:14px">ارزش نهایی حساب</div>
        <div class="equity num">${nf(st.equity)}<small>USDT</small></div>
        <div class="pnl-row">${pnlPills(st, res.capital)}</div>
        <div class="subrow"><span>دارایی‌ها: <b>${res.symbols.length}</b></span><span>کندل‌ها: <b class="num">${res.bars}</b></span><span>سیگنال‌ها: <b class="num">${res.signals}</b></span></div>
      </div>
      ${verdictCard(st, res.bench)}
      <div class="span-2">${kpiTiles(st, { k: 'بهترین / بدترین', v: `<span class="up">${signed(st.best?.pnl || 0)}</span> / <span class="down">${signed(st.worst?.pnl || 0)}</span>`, s: 'USDT در یک معامله' })}</div>
      <div class="card glass span-2"><h3>منحنی سرمایه</h3><div class="chart-box" id="btChart"></div></div>
      <div class="span-2 grid cols-2">${breakdown(st)}</div>
      <div class="span-2">${blockedCard(res)}</div>
      <div class="card glass span-2"><h3>آخرین معاملات بک‌تست <span class="muted"><a href="#trades" id="btAll">همه</a></span></h3><div class="list">${res.closed.slice(-10).reverse().map(x => tradeRow(x)).join('') || '<div class="empty">در این بازه معامله‌ای انجام نشد</div>'}</div></div>
    </div>` : '<div class="card glass"><div class="empty">هنوز بک‌تستی اجرا نشده. بازه را انتخاب کنید و «اجرا» را بزنید.</div></div>'}
    <p class="muted" style="font-size:12px;margin:12px 4px">بک‌تست معمولاً از نتیجه‌ی واقعی خوش‌بینانه‌تر است؛ تست زنده‌ی یک‌هفته‌ای ملاک اصلی است.</p>
  </div>`;
  main.querySelectorAll('[data-days]').forEach(b => b.onclick = () => { B.days = +b.dataset.days; save('btDays', B.days); render(); });
  $('#runBt').onclick = runBacktest;
  if (st) {
    const c = createAreaChart($('#btChart'), { base: res.capital }); charts.push(c); c.setData(res.equity, res.capital);
    main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
    $('#btAll').onclick = e => { e.preventDefault(); S.tradesSrc = 'bt'; go('trades'); };
  }
}
async function runBacktest() {
  const B = S.bt;
  const end = Math.floor(Date.now() / BAR_MS) * BAR_MS;
  const start = end - B.days * DAY;
  const syms = ASSETS.map(a => a.symbol).filter(s => S.settings.symbols[s] && !unavailable.has(s));
  B.error = ''; B.running = `دریافت داده 0/${syms.length}`; render();
  const data = {}; let done = 0;
  await pool(syms, 4, async s => {
    try { data[s] = await ensureHistory(s, start - WARMUP_BARS * BAR_MS, end); } catch { /* */ }
    done++; B.running = `دریافت داده ${done}/${syms.length}`;
    const b = $('#runBt'); if (b) b.innerHTML = `<span class="loader"></span> ${B.running}`;
  });
  if (!Object.keys(data).length) { B.running = null; B.error = 'دریافت داده از Binance ممکن نشد. اتصال اینترنت یا VPN را بررسی کنید، یا حالت نمایشی را امتحان کنید.'; S.offline = true; render(); return; }
  B.running = 'اجرای ربات…'; render();
  await new Promise(r => setTimeout(r, 30));
  const res = closeAllAtEnd(runSimulation({ data, settings: S.settings, start, end }), S.settings);
  res.bench = benchmark(res, data);
  res.days = B.days;
  res.equity = thin(res.equity, 800);
  res.events = [];
  B.res = res; B.running = null;
  save('bt', res);
  render();
}

/* ---------------- page: settings ---------------- */
function pageSettings(main) {
  const st = S.settings;
  const locked = S.live.status === 'running';
  const num = (key, label, hint, step = 'any', min = 0, max = 1e9) => `<div class="field"><div class="lbl"><b>${label}</b><span>${hint}</span></div><input class="input" type="number" inputmode="decimal" data-k="${key}" value="${st[key]}" step="${step}" min="${min}" max="${max}"></div>`;
  const sw = (key, label, hint, checked, attr = 'data-k') => `<div class="field"><div class="lbl"><b>${label}</b><span>${hint}</span></div><label class="switch"><input type="checkbox" ${attr}="${key}" ${checked ? 'checked' : ''}><span></span></label></div>`;
  main.innerHTML = `<div class="page">${topbar('تنظیمات')}
    ${locked ? '<div class="note warn" style="margin-bottom:12px">یک تست زنده در جریان است. تغییرها روی بک‌تست و تست بعدی اثر دارند؛ تست فعلی با تنظیمات لحظه‌ی شروعش ادامه می‌دهد تا نتیجه‌اش دست‌کاری نشود.</div>' : ''}
    <div class="grid cols-2">
      <div class="card glass"><h3>ظاهر و اپ</h3>
        <div class="field"><div class="lbl"><b>تم</b><span>سورمه‌ای تیره یا سفید</span></div><div class="seg" id="themeSeg">${[['auto', 'خودکار'], ['light', 'روشن'], ['dark', 'تیره']].map(([k, n]) => `<button data-theme="${k}" class="${S.theme === k ? 'active' : ''}">${n}</button>`).join('')}</div></div>
        ${sw('notifications', 'اعلان معامله‌ها', 'وقتی اپ باز است، ورود و خروج‌ها را اعلان می‌دهد', st.notifications)}
        <div class="field"><div class="lbl"><b>نصب روی دستگاه</b><span id="installHint">${installHint()}</span></div><button class="btn sm" id="installBtn" ${S.installEvt ? '' : 'disabled'}>${I.install} نصب</button></div>
      </div>
      <div class="card glass"><h3>سرمایه و دوره‌ی تست</h3>
        ${num('capital', 'سرمایه‌ی مجازی (USDT)', 'پیش‌فرض ۱۰۰۰ تتر', 1, 10)}
        ${num('testDays', 'مدت تست زنده (روز)', 'تست پرفشار: ۷ روز', 1, 1, 60)}
        ${num('maxHoldHours', 'حداکثر نگه‌داری (ساعت)', 'بازار ۲۴ ساعته زنگ بسته شدن ندارد؛ بعد از این مدت پوزیشن بسته می‌شود', 0.5, 0.5, 72)}
      </div>
      <div class="card glass"><h3>مدیر بودجه و ریسک <span class="muted">trader-budget / trader-risk</span></h3>
        ${num('riskPct', 'ریسک هر معامله (% حساب)', 'ضرر اگر حد ضرر بخورد؛ ۱٪ از ۱۰۰۰ = ۱۰ تتر', 0.1, 0.1, 10)}
        ${num('targetR', 'هدف سود (R)', 'چند برابر ریسک؛ trader-exit پیش‌فرض ۲R', 0.25, 0.5, 10)}
        ${num('maxOpen', 'حداکثر پوزیشن باز', 'هم‌زمان روی دارایی‌های مختلف', 1, 1, 17)}
        ${num('maxPositionPct', 'بزرگ‌ترین پوزیشن (% حساب)', 'سقف حجم یک معامله', 1, 1, 100)}
        ${num('dailyLossPct', 'حد ضرر روزانه (% سرمایه)', 'رسیدن به آن یعنی تا فردا معامله‌ی جدید نه', 0.5, 0.5, 50)}
        ${num('maxTradesPerDay', 'سقف معامله در روز', 'برای تست پرفشار بالا گذاشته شده', 1, 1, 500)}
        ${num('cooldownBars', 'استراحت بعد از ضرر (کندل)', 'روی همان نماد', 1, 0, 100)}
        ${sw('allowShort', 'معامله‌ی فروش (شورت)', 'مهارت‌ها فقط خرید دارند؛ با روشن کردن، آینه‌ی هر ستاپ هم معامله می‌شود', st.allowShort)}
      </div>
      <div class="card glass"><h3>کارمزد و واقع‌گرایی</h3>
        ${num('feeSpotPct', 'کارمزد اسپات (% هر طرف)', 'Binance: ۰.۱٪ taker', 0.01, 0, 1)}
        ${num('feeFuturesPct', 'کارمزد فیوچرز (% هر طرف)', 'Binance: ۰.۰۵٪ taker', 0.01, 0, 1)}
        ${num('slippagePct', 'لغزش قیمت (% هر پر شدن)', 'فاصله‌ی قیمت اجرا با قیمت دیده‌شده', 0.01, 0, 1)}
        ${sw('timeMachineFilter', 'فیلتر ماشین زمان', 'قبل از هر ورود ۴۰۰ بار شبیه‌سازی؛ اگر شانس از سربه‌سر کمتر بود رد می‌شود', st.timeMachineFilter)}
        ${num('tmMinEdge', 'حداقل برتری ماشین زمان (واحد درصد)', 'نسبت به نقطه‌ی سربه‌سر', 1, -50, 50)}
      </div>
      <div class="card glass"><h3>مهارت‌ها (ستاپ‌های اسکنر)</h3>
        ${Object.entries(STRATEGIES).map(([k, s]) => sw(k, s.name, s.desc, st.strategies[k], 'data-strat')).join('')}
      </div>
      <div class="card glass"><h3>دارایی‌ها</h3>
        ${ASSETS.map(a => sw(a.symbol, a.name, `${a.symbol} · ${GROUPS[a.group]}${unavailable.has(a.symbol) ? ' · در دسترس نیست' : ''}`, st.symbols[a.symbol], 'data-sym-t')).join('')}
      </div>
      <div class="card glass"><h3>داده‌ها</h3>
        <div class="field"><div class="lbl"><b>بازگشت به تنظیمات پیش‌فرض</b><span>تست جاری دست نمی‌خورد</span></div><button class="btn sm" id="defBtn">پیش‌فرض</button></div>
        <div class="field"><div class="lbl"><b>پاک کردن همه‌چیز</b><span>تست، بک‌تست و کندل‌های ذخیره‌شده روی این دستگاه</span></div><button class="btn sm danger" id="wipeBtn">پاک کردن</button></div>
        <p class="note" style="margin:8px 0 0">همه‌ی داده‌ها فقط روی همین دستگاه ذخیره می‌شوند. این اپ هیچ کلید، رمز یا حساب صرافی نمی‌خواهد و هیچ سفارش واقعی ثبت نمی‌کند.</p>
      </div>
    </div></div>`;
  const persist = () => { save('settings', S.settings); };
  main.querySelectorAll('input[data-k]').forEach(inp => inp.onchange = () => {
    const k = inp.dataset.k;
    if (inp.type === 'checkbox') {
      S.settings[k] = inp.checked;
      if (k === 'notifications' && inp.checked && 'Notification' in window) Notification.requestPermission();
    } else {
      let v = parseFloat(inp.value);
      if (!isFinite(v)) v = DEFAULT_SETTINGS[k];
      v = Math.min(+inp.max, Math.max(+inp.min, v));
      inp.value = v; S.settings[k] = v;
    }
    persist(); toast('ذخیره شد');
  });
  main.querySelectorAll('input[data-strat]').forEach(inp => inp.onchange = () => { S.settings.strategies[inp.dataset.strat] = inp.checked; persist(); });
  main.querySelectorAll('input[data-sym-t]').forEach(inp => inp.onchange = () => { S.settings.symbols[inp.dataset.symT] = inp.checked; persist(); });
  main.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { S.theme = b.dataset.theme; applyTheme(); render(); });
  $('#installBtn').onclick = async () => { if (!S.installEvt) return; S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; render(); };
  $('#defBtn').onclick = () => { S.settings = mergeSettings({}); persist(); render(); toast('تنظیمات پیش‌فرض برگشت'); };
  $('#wipeBtn').onclick = async () => {
    if (!(await confirmBox('همه‌ی داده‌ها روی این دستگاه پاک شود؟', 'پاک کردن'))) return;
    ['live', 'liveSnap', 'bt', 'seenEvents'].forEach(remove); await idbClear();
    S.live = { status: 'idle' }; S.liveRes = null; S.bt.res = null; toast('پاک شد'); render();
  };
}
function installHint() {
  if (matchMedia('(display-mode: standalone)').matches) return 'اپ نصب شده است';
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return 'در Safari: دکمه‌ی Share و بعد Add to Home Screen';
  return S.installEvt ? 'روی موبایل و دسکتاپ مثل یک اپ جدا باز می‌شود' : 'از منوی مرورگر گزینه‌ی Install app یا Add to Home screen را بزنید';
}

/* ---------------- boot ---------------- */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; if (S.page === 'settings') render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

applyTheme();
render();
document.fonts?.ready.then(() => charts.forEach(c => c.redraw && c.redraw()));

let tickPending = false;
async function boot() {
  if (!mode.demo && !(await probe())) { S.offline = true; render(); }
  try {
    S.t24 = await tickers(ASSETS.map(a => a.symbol));
    for (const [s, v] of Object.entries(S.t24)) S.prices[s] ??= v.last;
  } catch { /* offline */ }
  if (S.page === 'market' || S.page === 'dash') render();
  liveStream(ASSETS.map(a => a.symbol).filter(s => !unavailable.has(s)), (s, price, t) => {
    S.prices[s] = price;
    if (t) S.t24[s] = { ...(S.t24[s] || {}), ...t, quoteVol: t.quoteVol ?? S.t24[s]?.quoteVol };
    if (S.detail === s && S.onDetailTick) S.onDetailTick(price);
    if (!tickPending) { tickPending = true; setTimeout(() => { tickPending = false; onPrices(); }, 1200); }
  });
  refreshLive(true);
  setInterval(() => refreshLive(false), 20000);
  setInterval(async () => { try { const t = await tickers(ASSETS.map(a => a.symbol)); for (const [s, v] of Object.entries(t)) S.t24[s] = v; } catch { /* */ } }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(false); });
}
boot();
