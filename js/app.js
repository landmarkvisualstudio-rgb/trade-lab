import { ASSETS, GROUPS, STRATEGIES, FAMILIES, DEFAULT_SETTINGS, BAR_MS, WARMUP_BARS, assetBySymbol } from './config.js';
import { runSimulation, closeAllAtEnd, computeStats, signalStats, BLOCK_REASONS } from './engine.js';
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
  tests: [], res: {}, seen: load('seen2', {}), view: null, focus: null, draft: null,
  liveLoading: null, liveError: '',
  prices: {}, t24: {}, sparks: {},
  page: ['dash', 'market', 'trades', 'backtest', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dash', detail: null, tf: '15m',
  bt: { res: load('bt', null), running: null, days: load('btDays', 7), error: '' },
  filter: 'all', search: '', tradesTab: 'closed', tradesSrc: null,
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
  $('#nav').querySelectorAll('[data-go]').forEach(b => b.onclick = () => { if (b.dataset.go === 'dash') S.view = null; go(b.dataset.go); });
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
    <div class="kpi glass flat"><div class="k">معاملات بسته / باز</div><div class="v num">${st.n} <span class="muted" style="font-size:15px">/ ${st.openCount}</span></div><div class="s">${st.wins} برد · ${st.losses} باخت</div></div>
    <div class="kpi glass flat"><div class="k">نرخ برد</div><div class="v num">${nf(st.winRate, 1)}%</div><div class="s">${st.n ? `سربه‌سر با هدف ${extra.R || S.settings.targetR}R: ${nf(100 / (1 + (extra.R || S.settings.targetR)), 0)}%` : 'بعد از بسته شدن معامله‌ها'}</div></div>
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
    text = `${st.n} معامله بسته شده${st.openCount ? ` و ${st.openCount} معامله باز است` : ''}. برای قضاوت منصفانه حداقل ۳۰ تا ۱۰۰ معامله لازم است. برای رسیدن سریع‌تر به این عدد، پروفایل «پرفشار» را امتحان کنید و «نرخ درستی سیگنال‌ها» را ببینید که از همان ساعت اول نتیجه می‌دهد.`;
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

function breakdown(st, enabled) {
  const rows = Object.entries(STRATEGIES).filter(([k]) => !enabled || enabled.includes(k) || st.bySetup[k]).map(([k, s]) => ({ k, name: s.name, ...(st.bySetup[k] || { n: 0, wins: 0, pnl: 0 }) }));
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

function tradeRow(x, live = false, res = null) {
  const a = assetBySymbol[x.symbol];
  const px = live ? (S.prices[x.symbol] ?? res?.lastClose[x.symbol] ?? x.entry) : x.exit;
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

/* ---------------- tests (several at once) ---------------- */
// Each test has its own budget, duration, profile, setups and assets, and they all
// run side by side on the same real candles. Every test is deterministic: the same
// start time and settings give the same trades, on any device.
const DEFAULT_WARMUP = 300;      // bars before the start, so slow averages (EMA 200) are ready
const newId = () => 't' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
function loadTests() {
  const T = load('tests', null);
  if (Array.isArray(T)) return T;
  // first run of this version: the single test of the old version becomes test 1
  const out = [];
  const old = load('live', null);
  if (old && old.start && (old.status === 'running' || old.status === 'done')) {
    const id = newId();
    out.push({ id, name: 'تست ۱', status: old.status, start: old.start, end: old.end, settings: old.settings, warmup: 200 });
    const seen = load('seenEvents', 0); save('seen2', { [id]: seen });
    const snap = load('liveSnap', null); if (snap) save('snap:' + id, snap);
  }
  save('tests', out);
  return out;
}
const saveTests = () => save('tests', S.tests);
const testById = id => S.tests.find(t => t.id === id);
const testSymbols = t => ASSETS.map(a => a.symbol).filter(s => t.settings.symbols[s] && !unavailable.has(s));
const testStrats = t => Object.keys(STRATEGIES).filter(k => t.settings.strategies[k]);
const testDays = t => t.settings.testDays ?? (t.end - t.start) / DAY;
const nowBarT = () => Math.floor(Date.now() / BAR_MS) * BAR_MS;
function focusTest() {
  return testById(S.view) || testById(S.focus) || S.tests.find(t => t.status === 'running') || S.tests[S.tests.length - 1] || null;
}

function sliceSeries(s, from, to) {
  let a = 0, b = s.t.length;
  while (a < s.t.length && s.t[a] < from) a++;
  while (b > a && s.t[b - 1] >= to) b--;
  return { t: s.t.slice(a, b), o: s.o.slice(a, b), h: s.h.slice(a, b), l: s.l.slice(a, b), c: s.c.slice(a, b), v: s.v.slice(a, b) };
}

let refreshing = false, lastRefreshBar = 0;
async function refreshTests(force = false) {
  const nowBar = nowBarT();
  const todo = S.tests.filter(t => !(S.res[t.id]?.final));
  if (!todo.length || refreshing) return;
  if (!force && nowBar === lastRefreshBar && todo.every(t => S.res[t.id])) return;
  refreshing = true;
  // one download per asset for all tests: from the earliest start that needs it
  const need = {};
  let to = 0;
  for (const t of todo) {
    const from = t.start - (t.warmup || 200) * BAR_MS;
    to = Math.max(to, Math.min(nowBar, t.end));
    for (const s of testSymbols(t)) need[s] = Math.min(need[s] ?? Infinity, from);
  }
  const syms = Object.keys(need);
  S.liveLoading = { done: 0, total: syms.length };
  updateLoading();
  let toasts = 0;
  try {
    const full = {};
    await pool(syms, 4, async s => {
      try { full[s] = await ensureHistory(s, need[s], to); } catch { /* unavailable */ }
      S.liveLoading.done++; updateLoading();
    });
    if (!Object.keys(full).length) throw new Error('no data');
    for (const t of todo) {
      const from = t.start - (t.warmup || 200) * BAR_MS, tt = Math.min(nowBar, t.end);
      const data = {};
      for (const s of testSymbols(t)) if (full[s]) data[s] = sliceSeries(full[s], from, tt);
      if (!Object.keys(data).length) continue;
      if (Date.now() < t.start) { S.res[t.id] = null; continue; }
      let res = runSimulation({ data, settings: t.settings, start: t.start, end: Math.min(tt, t.end), capital: t.settings.capital });
      if (Date.now() >= t.end && res.lastTime >= t.end - BAR_MS * 2) {
        res = closeAllAtEnd(res, t.settings); res.final = true;
        if (t.status !== 'done') {
          t.status = 'done'; saveTests();
          const st = computeStats(res);
          toast(`«${esc(t.name)}» تمام شد: ${signed(st.pnl)} USDT`); notify('ترید لب', `${t.name} تمام شد. نتیجه: ${signed(st.pnl)} USDT`);
        }
      }
      res.bench = benchmark(res, data);
      res.targetR = t.settings.targetR;
      S.res[t.id] = res;
      toasts += announce(t, res, toasts);
      save('snap:' + t.id, { at: Date.now(), stats: computeStats(res), equity: thin(res.equity, 160) });
      await new Promise(r => setTimeout(r, 0)); // keep the page responsive between tests
    }
    S.liveError = '';
    lastRefreshBar = nowBar;
  } catch (e) {
    S.liveError = 'دریافت داده از Binance ممکن نشد. اتصال اینترنت یا VPN را بررسی کنید.'; S.offline = true;
  } finally {
    refreshing = false; S.liveLoading = null;
    if (['dash', 'trades'].includes(S.page) && !S.detail) render();
  }
}

function announce(t, res, already) {
  const ev = res.events.filter(e => e.type === 'entry' || e.type === 'exit');
  const seen = S.seen[t.id] ?? 0;
  const fresh = ev.slice(ev.length < seen ? 0 : seen);
  S.seen[t.id] = ev.length; save('seen2', S.seen);
  if (!fresh.length || already >= 3) return 0;
  const tag = S.tests.length > 1 ? `<b>${esc(t.name)}</b> · ` : '';
  if (fresh.length > 6) { toast(`${tag}${fresh.length} رویداد جدید از آخرین بازدید`); return 1; }
  let n = 0;
  for (const e of fresh.slice(-2)) {
    const nm = assetBySymbol[e.symbol]?.name || e.symbol;
    if (e.type === 'entry') { const m = `ورود ${e.dir > 0 ? 'خرید' : 'فروش'} ${nm} · ${STRATEGIES[e.setup]?.name}`; toast(tag + m); notify(t.name, m); }
    else { const m = `خروج ${nm} (${REASON[e.reason]}): ${signed(e.pnl)} USDT`; toast(tag + m, e.pnl >= 0 ? 'up' : 'down'); notify(t.name, m); }
    n++;
  }
  return n;
}

function thin(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; const out = []; for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * step)]); out.push(arr[arr.length - 1]); return out; }

function updateLoading() {
  document.querySelectorAll('.liveLoading').forEach(el => {
    el.innerHTML = S.liveLoading ? `<span class="loader"></span> دریافت داده‌ی بازار ${S.liveLoading.done}/${S.liveLoading.total}` : '';
  });
}

/* new-test form: a draft that turns into a test */
const STRAT_SETS = {
  all: ['همه‌ی ستاپ‌ها', () => Object.keys(STRATEGIES)],
  trader: ['مهارت‌های تریدر', () => Object.keys(STRATEGIES).filter(k => STRATEGIES[k].src === 'trader')],
  chart: ['تحلیل‌گر چارت', () => Object.keys(STRATEGIES).filter(k => STRATEGIES[k].src === 'chart')],
  settings: ['طبق تنظیمات', () => Object.keys(STRATEGIES).filter(k => S.settings.strategies[k])],
};
const ASSET_SETS = {
  all: ['همه', () => ASSETS.map(a => a.symbol)],
  crypto: ['رمزارزهای اصلی', () => ASSETS.filter(a => a.group === 'crypto').map(a => a.symbol)],
  meme: ['میم‌کوین‌ها', () => ASSETS.filter(a => a.group === 'meme').map(a => a.symbol)],
  commod: ['طلا، نقره، مس و انرژی', () => ASSETS.filter(a => a.group === 'metal' || a.group === 'energy').map(a => a.symbol)],
  settings: ['طبق تنظیمات', () => ASSETS.filter(a => S.settings.symbols[a.symbol]).map(a => a.symbol)],
};
function freshDraft() {
  const prof = activeProfile(S.settings);
  return { name: `تست ${faNum(S.tests.length + 1)}`, capital: S.settings.capital, days: S.settings.testDays, profile: prof === 'custom' ? 'custom' : prof, strat: 'all', assets: 'all' };
}
const faNum = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
function draftSettings(dr) {
  const st = JSON.parse(JSON.stringify(S.settings));
  if (dr.profile !== 'custom' && PROFILES[dr.profile]) Object.assign(st, PROFILES[dr.profile].set);
  st.capital = Math.max(10, +dr.capital || 1000);
  st.testDays = dr.days;
  const ks = new Set(STRAT_SETS[dr.strat][1]());
  st.strategies = Object.fromEntries(Object.keys(STRATEGIES).map(k => [k, ks.has(k)]));
  const ss = new Set(ASSET_SETS[dr.assets][1]());
  st.symbols = Object.fromEntries(ASSETS.map(a => [a.symbol, ss.has(a.symbol)]));
  return st;
}
function newTestForm(dr) {
  const chips = (list, cur, attr) => list.map(([k, n]) => `<button class="chip ${cur === k ? 'active' : ''}" data-${attr}="${k}">${n}</button>`).join('');
  return `<div class="ntf">
    <div class="ntf-row"><label class="ntf-f"><span>نام تست</span><input class="input" id="ntName" maxlength="40" value="${esc(dr.name)}"></label>
    <label class="ntf-f"><span>بودجه (USDT)</span><input class="input num" id="ntCap" type="number" inputmode="decimal" min="10" step="10" value="${dr.capital}"></label></div>
    <div class="pick"><div class="pick-l">مدت</div><div class="chips">${chips(DURATIONS.map(([d, n]) => [String(d), n]), String(dr.days), 'ndur')}</div></div>
    <div class="pick"><div class="pick-l">پروفایل</div><div class="chips">${chips([...Object.entries(PROFILES).map(([k, p]) => [k, p.name]), ['custom', 'طبق تنظیمات']], dr.profile, 'nprof')}</div></div>
    <div class="pick"><div class="pick-l">ستاپ‌ها</div><div class="chips">${chips(Object.entries(STRAT_SETS).map(([k, v]) => [k, v[0]]), dr.strat, 'nstrat')}</div></div>
    <div class="pick"><div class="pick-l">دارایی‌ها</div><div class="chips">${chips(Object.entries(ASSET_SETS).map(([k, v]) => [k, v[0]]), dr.assets, 'nasset')}</div></div>
    <div class="muted ntf-sum">${draftSummary(dr)}</div>
  </div>`;
}
function draftSummary(dr) {
  const st = draftSettings(dr);
  const nS = Object.values(st.strategies).filter(Boolean).length, nA = Object.values(st.symbols).filter(Boolean).length;
  return `${nS} ستاپ روی ${nA} دارایی · ${dr.profile === 'custom' ? 'تنظیمات دستی' : PROFILES[dr.profile].desc} · ریسک هر معامله ${nf(st.capital * st.riskPct / 100)} تتر`;
}
function bindNewTestForm(root, dr, rerender) {
  root.querySelector('#ntName').oninput = e => { dr.name = e.target.value; };
  root.querySelector('#ntCap').oninput = e => { dr.capital = Math.max(10, +e.target.value || 1000); const s = root.querySelector('.ntf-sum'); if (s) s.innerHTML = draftSummary(dr); };
  root.querySelectorAll('[data-ndur]').forEach(b => b.onclick = () => { dr.days = +b.dataset.ndur; rerender(); });
  root.querySelectorAll('[data-nprof]').forEach(b => b.onclick = () => { dr.profile = b.dataset.nprof; rerender(); });
  root.querySelectorAll('[data-nstrat]').forEach(b => b.onclick = () => { dr.strat = b.dataset.nstrat; rerender(); });
  root.querySelectorAll('[data-nasset]').forEach(b => b.onclick = () => { dr.assets = b.dataset.nasset; rerender(); });
}
function startTest(dr) {
  const settings = draftSettings(dr);
  if (!Object.values(settings.strategies).some(Boolean)) return toast('هیچ ستاپی انتخاب نشده');
  if (!Object.values(settings.symbols).some(Boolean)) return toast('هیچ دارایی‌ای انتخاب نشده');
  const start = Math.ceil(Date.now() / BAR_MS) * BAR_MS;
  const t = { id: newId(), name: (dr.name || '').trim() || `تست ${faNum(S.tests.length + 1)}`, status: 'running', start, end: start + dr.days * DAY, settings, warmup: DEFAULT_WARMUP };
  S.tests.push(t); saveTests();
  S.seen[t.id] = 0; save('seen2', S.seen);
  S.focus = t.id;
  toast(`«${esc(t.name)}» با ${nf(settings.capital, 0)} تتر شروع شد. ربات از کندل ۵ دقیقه‌ای بعدی معامله می‌کند.`);
  if (S.settings.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  S.draft = null;
  render(); refreshTests(true);
}
function showNewTest() {
  const dr = freshDraft();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  const draw = () => {
    wrap.innerHTML = `<div class="modal glass ntf-modal" role="dialog" aria-modal="true"><p style="margin-bottom:10px">تست تازه</p>${newTestForm(dr)}
      <div class="acts" style="margin-top:14px"><button class="btn primary" data-ok>${I.play} شروع</button><button class="btn" data-no>انصراف</button></div></div>`;
    bindNewTestForm(wrap, dr, draw);
    wrap.querySelector('[data-ok]').onclick = () => { wrap.remove(); startTest(dr); };
    wrap.querySelector('[data-no]').onclick = () => wrap.remove();
  };
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  draw();
  document.body.appendChild(wrap);
}
async function stopTest(t) {
  if (!(await confirmBox(`«${t.name}» الان تمام شود؟ پوزیشن‌های باز با آخرین قیمت بسته می‌شوند.`, 'پایان تست'))) return;
  t.end = Math.max(t.start + BAR_MS, nowBarT());
  saveTests(); delete S.res[t.id]; refreshTests(true);
}
async function deleteTest(t) {
  if (!(await confirmBox(`«${t.name}» و همه‌ی نتیجه‌هایش از این دستگاه پاک شود؟`, 'حذف تست'))) return;
  S.tests = S.tests.filter(x => x.id !== t.id); saveTests();
  delete S.res[t.id]; remove('snap:' + t.id); delete S.seen[t.id]; save('seen2', S.seen);
  if (S.view === t.id) S.view = null;
  render();
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

/* ---------------- durations & profiles ---------------- */
const DURATIONS = [[1 / 24, '۱ ساعت'], [4 / 24, '۴ ساعت'], [0.5, '۱۲ ساعت'], [1, '۱ روز'], [3, '۳ روز'], [7, '۷ روز']];
const durLabel = d => (DURATIONS.find(x => Math.abs(x[0] - d) < 1e-6) || [d, d >= 1 ? `${+d.toFixed(2)} روز` : `${Math.round(d * 24)} ساعت`])[1];
// «پرفشار» forces many short trades so accuracy can be measured fast
const PROFILES = {
  standard: { name: 'استاندارد', desc: 'هدف ۲R، نگه‌داری تا ۴ ساعت، ریسک ۱٪', set: { targetR: 2, maxHoldHours: 4, riskPct: 1, maxPositionPct: 30, maxOpen: 6, cooldownBars: 6, maxTradesPerDay: 60, dailyLossPct: 6 } },
  stress: { name: 'پرفشار', desc: 'هدف ۱.۵R، نگه‌داری تا ۱ ساعت، ریسک ۰.۵٪، تا ۱۲ پوزیشن هم‌زمان', set: { targetR: 1.5, maxHoldHours: 1, riskPct: 0.5, maxPositionPct: 12, maxOpen: 12, cooldownBars: 2, maxTradesPerDay: 300, dailyLossPct: 10 } },
};
const activeProfile = st => Object.keys(PROFILES).find(k => Object.entries(PROFILES[k].set).every(([f, v]) => st[f] === v)) || 'custom';
function applyProfile(k) { Object.assign(S.settings, PROFILES[k].set); save('settings', S.settings); }

/* ---------------- device sync ---------------- */
// The robot is deterministic: the same start time and settings give the same
// trades on any device. A sync link carries just those, for every test.
// Setups and assets go as bit lists in a fixed order (new ones are only ever
// appended), so a test keeps exactly its own set on the other device.
const STRAT_KEYS = Object.keys(STRATEGIES), SYM_KEYS = ASSETS.map(a => a.symbol);
const LEGACY_STRATS = 5, LEGACY_SYMS = 17; // what version 1 links knew about
const toBits = arr => { let s = ''; for (let i = 0; i < arr.length; i += 4) s += (arr.slice(i, i + 4).reduce((a, b, k) => a | (b ? 1 << k : 0), 0)).toString(16); return s; };
const fromBits = (s, n) => Array.from({ length: n }, (_, i) => !!((parseInt(s[i >> 2] || '0', 16) >> (i & 3)) & 1));
function settingsDiff(st) {
  const d = {};
  for (const [k, v] of Object.entries(st)) {
    if (k === 'strategies' || k === 'symbols') continue;
    if (DEFAULT_SETTINGS[k] !== v) d[k] = v;
  }
  d.sk = toBits(STRAT_KEYS.map(k => !!st.strategies[k]));
  d.sy = toBits(SYM_KEYS.map(s => !!st.symbols[s]));
  return d;
}
function settingsFromDiff(d, legacy) {
  const { sk, sy, strategies, symbols, ...rest } = d || {};
  const st = { ...DEFAULT_SETTINGS, ...rest };
  if (legacy) { // version 1: a diff against the old defaults (5 setups, 17 assets on)
    st.strategies = Object.fromEntries(STRAT_KEYS.map((k, i) => [k, i < LEGACY_STRATS ? (strategies?.[k] ?? true) : false]));
    st.symbols = Object.fromEntries(SYM_KEYS.map((s, i) => [s, i < LEGACY_SYMS ? (symbols?.[s] ?? true) : false]));
  } else {
    const a = fromBits(sk || '', STRAT_KEYS.length), b = fromBits(sy || '', SYM_KEYS.length);
    st.strategies = Object.fromEntries(STRAT_KEYS.map((k, i) => [k, a[i]]));
    st.symbols = Object.fromEntries(SYM_KEYS.map((s, i) => [s, b[i]]));
  }
  return st;
}
const b64u = str => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));
function syncLink() {
  const payload = { v: 2, m: mode.demo ? 1 : 0, t: S.tests.map(t => ({ n: t.name, s: t.start, e: t.end, w: t.warmup || 200, d: settingsDiff(t.settings) })) };
  return location.origin + location.pathname + '#join=' + b64u(JSON.stringify(payload));
}
async function handleJoin() {
  const m = location.hash.match(/^#join=([\w-]+)/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + '#dash');
  S.page = 'dash'; S.detail = null; S.view = null;
  let p;
  try { p = JSON.parse(unb64u(m[1])); } catch { toast('لینک همگام‌سازی معتبر نیست'); return false; }
  if (!!p.m !== mode.demo) { save('demo', !!p.m); save('pendingJoin', m[1]); location.reload(); return true; }
  const list = p.v === 2 ? p.t || [] : [{ n: 'تست ۱', s: p.s, e: p.e, w: 200, d: p.d, legacy: true }];
  let added = 0;
  for (const x of list) {
    if (!x || !x.s || !x.e) continue;
    if (S.tests.some(t => t.start === x.s && t.end === x.e && t.name === x.n)) continue;
    const t = { id: newId(), name: x.n || `تست ${faNum(S.tests.length + 1)}`, status: Date.now() >= x.e ? 'done' : 'running', start: x.s, end: x.e, settings: settingsFromDiff(x.d, x.legacy), warmup: x.w || 200 };
    S.tests.push(t); S.seen[t.id] = 0; added++;
  }
  saveTests(); save('seen2', S.seen);
  toast(added ? `همگام شد: ${added} تست از دستگاه دیگر اضافه شد.` : 'همه‌ی تست‌های آن دستگاه از قبل اینجا هستند.');
  render(); refreshTests(true);
  return true;
}
let qrLib = null;
function loadQR() {
  if (qrLib) return qrLib;
  qrLib = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; sc.onload = () => res(window.qrcode); sc.onerror = rej; document.head.appendChild(sc); });
  return qrLib;
}
async function showSync() {
  const link = syncLink();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal glass sync-modal" role="dialog" aria-modal="true">
    <p style="margin-bottom:8px">همگام‌سازی با دستگاه دیگر</p>
    <div class="muted" style="font-size:13px;line-height:1.9;margin-bottom:12px">این کد را با دوربین گوشی اسکن کنید یا لینک را روی دستگاه دیگر باز کنید. همه‌ی تست‌ها با همان زمان شروع و همان تنظیمات آنجا باز می‌شوند و چون ربات از روی کندل‌های واقعی حساب می‌کند، معامله‌ها روی هر دو دستگاه یکی است.</div>
    <div class="qr" id="qrBox"><span class="loader"></span></div>
    <input class="input sync-link" readonly value="${esc(link)}" id="syncLink">
    <div class="acts" style="margin-top:12px"><button class="btn primary" data-copy>کپی لینک</button><button class="btn" data-close>بستن</button></div></div>`;
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-close]').onclick = close;
  wrap.querySelector('[data-copy]').onclick = async () => {
    const inp = wrap.querySelector('#syncLink');
    try { await navigator.clipboard.writeText(link); toast('لینک کپی شد'); } catch { inp.select(); document.execCommand?.('copy'); toast('لینک را انتخاب و کپی کنید'); }
  };
  document.body.appendChild(wrap);
  try {
    const qrcode = await loadQR();
    const q = qrcode(0, 'M'); q.addData(link); q.make();
    wrap.querySelector('#qrBox').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { wrap.querySelector('#qrBox').innerHTML = '<div class="muted" style="font-size:12px">کد QR بارگذاری نشد؛ از لینک استفاده کنید.</div>'; }
}

/* ---------------- signal accuracy ---------------- */
function accuracyCard(res, enabled) {
  if (!res?.sigEval) return '';
  const ss = signalStats(res.sigEval);
  const T = ss.total;
  const be = 100 / (1 + (res.targetR || S.settings.targetR));
  const rows = Object.entries(STRATEGIES).filter(([k]) => !enabled || enabled.includes(k) || ss.bySetup[k]).map(([k, st]) => {
    const b = ss.bySetup[k];
    if (!b || !b.n) return `<div class="bar-row"><div><b style="font-weight:600">${st.name}</b><div class="muted" style="font-size:11.5px">بدون سیگنال</div></div><div class="bar-track"></div><div class="num muted" style="min-width:70px;text-align:left">—</div></div>`;
    const acc = b.accuracy, good = acc >= be;
    return `<div class="bar-row"><div><b style="font-weight:600">${st.name}</b><div class="muted" style="font-size:11.5px">${b.done} نتیجه از ${b.n} سیگنال · هدف ${b.target} / ضرر ${b.stop}</div></div>
      <div class="bar-track"><div style="right:0;width:${Math.min(100, acc)}%;background:var(--${good ? 'up' : 'down'})"></div><span class="mid" style="right:${be}%"></span></div>
      <div class="num ${good ? 'up' : 'down'}" style="font-weight:700;min-width:70px;text-align:left">${nf(acc, 0)}% <span class="muted" style="font-weight:500;font-size:11px">${signed(b.avgR, 2)}R</span></div></div>`;
  }).join('');
  return `<div class="card glass"><h3>نرخ درستی سیگنال‌ها <span class="muted">همه‌ی سیگنال‌ها، حتی آن‌هایی که معامله نشدند</span></h3>
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi glass flat"><div class="k">سیگنال بررسی‌شده</div><div class="v num">${T.done}</div><div class="s">${T.pending} در انتظار نتیجه</div></div>
      <div class="kpi glass flat"><div class="k">نرخ درستی کل</div><div class="v num ${T.accuracy >= be ? 'up' : 'down'}">${nf(T.accuracy, 1)}%</div><div class="s">سربه‌سر: ${nf(be, 0)}%</div></div>
      <div class="kpi glass flat"><div class="k">به هدف رسید / به ضرر</div><div class="v num"><span class="up">${T.target}</span> / <span class="down">${T.stop}</span></div><div class="s">${T.time} با پایان زمان</div></div>
      <div class="kpi glass flat"><div class="k">میانگین هر سیگنال</div><div class="v num ${cls(T.avgR)}">${signed(T.avgR, 2)}R</div><div class="s">قبل از کارمزد</div></div>
    </div>
    <div class="bars">${rows}</div>
    <p class="muted" style="font-size:12px;margin:12px 0 0;line-height:1.9">«نرخ درستی» یعنی از سیگنال‌هایی که به هدف یا حد ضرر رسیدند، چند درصد اول به هدف رسیدند. خط عمودی نقطه‌ی سربه‌سر است: با هدف ${res.targetR || S.settings.targetR}R، درستی بالای ${nf(be, 0)}% یعنی آن مهارت در این بازه سودده بوده.</p></div>`;
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

/* ---------------- page: dashboard (all tests) ---------------- */
function howItWorks() {
  return `<div class="card glass">
    <h3>چطور کار می‌کند</h3>
    <div class="list">
      ${[['۱', 'چند تست هم‌زمان', 'هر تست بودجه، مدت، پروفایل، ستاپ‌ها و دارایی‌های خودش را دارد؛ همه در یک پنل کنار هم'], ['۲', 'اسکنر', `${Object.keys(STRATEGIES).length} ستاپ (مهارت‌های تریدر و تحلیل‌گر چارت) روی کندل‌های ۵ دقیقه‌ای ${ASSETS.length} دارایی`], ['۳', 'ورود و خروج', 'فقط بعد از بسته شدن کندل؛ حد ضرر قبل از ورود، هدف بر حسب R و سقف زمان نگه‌داری'], ['۴', 'بودجه و ریسک', 'ریسک هر معامله درصدی از همان بودجه‌ی تست، حد ضرر روزانه و سقف پوزیشن باز'], ['۵', 'کارمزد واقعی', `کارمزد ${S.settings.feeSpotPct}% و لغزش ${S.settings.slippagePct}% در هر معامله کم می‌شود`], ['۶', 'همگام‌سازی', 'با دکمه‌ی «همگام‌سازی» همه‌ی تست‌ها روی گوشی یا لپ‌تاپ دیگر هم باز می‌شوند']]
        .map(([n, a, b]) => `<div class="row"><span class="coin" style="background:linear-gradient(145deg,#2c4fb0,#0a1838)">${n}</span><div class="main"><div class="t1">${a}</div><div class="t2" style="white-space:normal">${b}</div></div></div>`).join('')}
    </div>
    <p class="note" style="margin:12px 0 0">اگر اپ را ببندید ربات متوقف نمی‌شود: با باز کردن دوباره، کندل‌های جاافتاده از Binance گرفته و دقیقاً همان معامله‌ها بازسازی می‌شوند.</p>
  </div>`;
}

function testStatsOf(t) {
  const res = S.res[t.id];
  if (res) return { st: computeStats(res, S.prices), res };
  const snap = load('snap:' + t.id, null);
  return { st: snap?.stats || null, res: null, snap };
}
function statusTag(t) {
  const now = Date.now();
  if (t.status === 'done') return '<span class="status done"><span class="dot"></span> تمام شد</span>';
  if (now < t.start) return '<span class="status run"><span class="dot"></span> منتظر اولین کندل</span>';
  return '<span class="status run"><span class="dot"></span> در حال معامله</span>';
}
const profName = st => PROFILES[activeProfile(st)]?.name || 'سفارشی';
const progOf = t => Math.min(100, Math.max(0, (Math.min(Date.now(), t.end) - t.start) / (t.end - t.start) * 100));
function miniSpark(eq, base) {
  if (!eq || eq.length < 2) return '<div class="tc-spark"></div>';
  const vals = eq.map(x => x[1]);
  const up = vals[vals.length - 1] >= base;
  return `<svg class="tc-spark" viewBox="0 0 120 34" preserveAspectRatio="none"><path d="${sparkPath(vals, 120, 34)}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
}

function testCard(t) {
  const { st, res, snap } = testStatsOf(t);
  const cap = t.settings.capital;
  const acc = res?.sigEval ? signalStats(res.sigEval).total : null;
  const eq = res ? thin(res.equity, 120) : snap?.equity;
  return `<div class="card glass test-card click" data-test="${t.id}">
    <div class="tc-head"><b>${esc(t.name)}</b>${statusTag(t)}</div>
    <div class="tc-meta">${durLabel(testDays(t))} · ${profName(t.settings)} · ${testStrats(t).length} ستاپ · ${testSymbols(t).length} دارایی</div>
    <div class="tc-eq num" data-teq="${t.id}">${st ? nf(st.equity) : '<span class="skeleton">1,000.00</span>'}<small>USDT</small></div>
    <div class="pnl-row" data-tpnl="${t.id}">${st ? pnlPills(st, cap) : ''}</div>
    ${miniSpark(eq, cap)}
    <div class="tc-stats">
      <div><span>بودجه</span><b class="num">${nf(cap, 0)}</b></div>
      <div><span>بسته / باز</span><b class="num">${st ? `${st.n} / ${st.openCount}` : '—'}</b></div>
      <div><span>نرخ برد</span><b class="num">${st && st.n ? nf(st.winRate, 0) + '%' : '—'}</b></div>
      <div><span>درستی</span><b class="num">${acc && acc.done ? nf(acc.accuracy, 0) + '%' : '—'}</b></div>
    </div>
    <div class="progress"><div style="width:${progOf(t)}%"></div></div>
    <div class="progress-meta"><span>${fdt(t.start)}</span><span>${t.status === 'done' ? 'پایان: ' + fdt(t.end) : 'باقی‌مانده: ' + dur(t.end - Date.now())}</span></div>
  </div>`;
}

function compareCard() {
  if (S.tests.length < 2) return '';
  const rows = S.tests.map(t => { const { st } = testStatsOf(t); return { t, ret: st ? st.pnl / t.settings.capital * 100 : null, st }; });
  const max = Math.max(0.5, ...rows.map(r => Math.abs(r.ret || 0)));
  const bars = rows.sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9)).map(({ t, ret, st }) => {
    const w = Math.abs(ret || 0) / max * 50;
    const side = (ret || 0) >= 0 ? `left:${50 - w}%;right:50%` : `right:${50 - w}%;left:50%`;
    return `<div class="bar-row click" data-test="${t.id}"><div><b style="font-weight:600">${esc(t.name)}</b><div class="muted" style="font-size:11.5px">${durLabel(testDays(t))} · ${profName(t.settings)} · ${st ? st.n : 0} معامله</div></div>
      <div class="bar-track"><span class="mid"></span>${ret == null ? '' : `<div style="${side};background:var(--${ret >= 0 ? 'up' : 'down'})"></div>`}</div>
      <div class="num ${cls(ret)}" style="font-weight:700;min-width:70px;text-align:left">${ret == null ? '—' : signed(ret) + '%'}</div></div>`;
  }).join('');
  return `<div class="card glass span-2"><h3>مقایسه‌ی تست‌ها <span class="muted">بازده نسبت به بودجه‌ی هر تست</span></h3><div class="bars">${bars}</div></div>`;
}

function pageDash(main) {
  if (S.view && testById(S.view)) return pageTest(main, testById(S.view));
  S.view = null;
  if (!S.tests.length) {
    const dr = S.draft || (S.draft = freshDraft());
    main.innerHTML = `<div class="page">${topbar('داشبورد')}${offlineCard()}
      <div class="dash-grid">
        <div class="card glass hero">
          <div class="hero-top"><span class="status"><span class="dot"></span> آماده‌ی شروع</span></div>
          <div class="label" style="margin-top:14px">اولین تست</div>
          <p class="muted" style="margin:6px 0 10px;max-width:560px">ربات با پول مجازی و روی قیمت واقعی بازار، خودکار معامله می‌کند. می‌توانید چند تست هم‌زمان بسازید (مثلاً یکی ۴ ساعته و یکی ۱ روزه) و همه را در یک پنل مقایسه کنید.</p>
          <div id="ntBox">${newTestForm(dr)}</div>
          <div class="hero-actions">
            <button class="btn primary" id="startBtn">${I.play} شروع تست</button>
            <button class="btn" data-go2="backtest">${I.backtest} اول یک بک‌تست سریع</button>
          </div>
        </div>
        ${howItWorks()}
      </div></div>`;
    const box = $('#ntBox');
    const redraw = () => { box.innerHTML = newTestForm(dr); bindNewTestForm(box, dr, redraw); };
    bindNewTestForm(box, dr, redraw);
    $('#startBtn').onclick = () => startTest(dr);
    main.querySelector('[data-go2]').onclick = () => go('backtest');
    return;
  }

  // totals over every test
  let cap = 0, eq = 0, n = 0, wins = 0, open = 0, have = 0;
  for (const t of S.tests) {
    const { st } = testStatsOf(t);
    cap += t.settings.capital;
    if (st) { have++; eq += st.equity; n += st.n; wins += st.wins; open += st.openCount; } else eq += t.settings.capital;
  }
  const pnl = eq - cap;
  const running = S.tests.filter(t => t.status === 'running').length;
  main.innerHTML = `<div class="page">${topbar('داشبورد')}${offlineCard()}
    ${S.liveError ? `<div class="note warn" style="margin-bottom:12px">${S.liveError}</div>` : ''}
    <div class="dash-grid">
      <div class="card glass hero span-2">
        <div class="hero-top"><span class="status ${running ? 'run' : 'done'}"><span class="dot"></span> ${running ? `${faNum(running)} تست در حال معامله` : 'همه‌ی تست‌ها تمام شده'}${S.tests.length - running ? ` · ${faNum(S.tests.length - running)} تمام‌شده` : ''}</span><span class="muted liveLoading" style="font-size:12.5px"></span></div>
        <div class="label" style="margin-top:14px">ارزش کل همه‌ی تست‌ها</div>
        <div class="equity num" id="totEq">${nf(eq)}<small>USDT</small></div>
        <div class="pnl-row" id="totPnl"><span class="pill ${pnl >= 0 ? 'up' : 'down'} num">${signed(pnl)} USDT</span><span class="pill ${pnl >= 0 ? 'up' : 'down'} num">${signed(pnl / cap * 100)}%</span></div>
        <div class="subrow"><span>بودجه‌ی کل: <b class="num">${nf(cap, 0)}</b></span><span>معاملات بسته / باز: <b class="num">${n} / ${open}</b></span><span>نرخ برد کل: <b class="num">${n ? nf(wins / n * 100, 1) + '%' : '—'}</b></span></div>
        <div class="hero-actions">
          <button class="btn sm primary" id="newTestBtn">${I.play} تست جدید</button>
          <button class="btn sm" id="refreshBtn">${I.refresh} به‌روزرسانی</button>
          <button class="btn sm" id="syncBtn">${I.install} همگام‌سازی دستگاه‌ها</button>
        </div>
      </div>
      ${compareCard()}
      <div class="span-2 tests-grid">${S.tests.slice().reverse().map(testCard).join('')}</div>
    </div></div>`;
  $('#newTestBtn').onclick = showNewTest;
  $('#refreshBtn').onclick = () => refreshTests(true);
  $('#syncBtn').onclick = showSync;
  main.querySelectorAll('[data-test]').forEach(c => c.onclick = () => { S.view = c.dataset.test; S.focus = S.view; render(); window.scrollTo({ top: 0 }); });
  updateLoading();
}

/* one test, in full */
function pageTest(main, t) {
  const L = t;
  const { st, res, snap } = testStatsOf(t);
  const now = Date.now();
  const done = L.status === 'done';
  const enabled = testStrats(t);
  main.innerHTML = `<div class="page">${topbar('داشبورد')}${offlineCard()}
    <button class="back" id="backBtn">${I.back} همه‌ی تست‌ها</button>
    ${S.liveError ? `<div class="note warn" style="margin-bottom:12px">${S.liveError}</div>` : ''}
    <div class="dash-grid">
      <div class="card glass hero">
        <div class="hero-top">${statusTag(t)}<span class="muted liveLoading" style="font-size:12.5px"></span></div>
        <div class="label" style="margin-top:14px">${esc(t.name)} · ارزش حساب مجازی</div>
        <div class="equity num" id="eqVal">${st ? nf(st.equity) : '<span class="skeleton">1,000.00</span>'}<small>USDT</small></div>
        <div class="pnl-row" id="pnlRow">${st ? pnlPills(st, L.settings.capital) : ''}</div>
        <div class="subrow"><span>سود قطعی: <b class="num ${cls(st?.realized)}">${st ? signed(st.realized) : '—'}</b></span><span>سود شناور: <b class="num ${cls(st?.unrealized)}" id="unrealVal">${st ? signed(st.unrealized) : '—'}</b></span><span>بودجه: <b class="num">${nf(L.settings.capital, 0)}</b></span></div>
        <div class="progress"><div style="width:${progOf(t)}%"></div></div>
        <div class="progress-meta"><span>${fdt(L.start)} · ${durLabel(testDays(t))}</span><span>${done ? 'پایان: ' + fdt(L.end) : 'باقی‌مانده: ' + dur(L.end - now)}</span></div>
        <div class="hero-actions">
          <button class="btn sm" id="refreshBtn">${I.refresh} به‌روزرسانی</button>
          <button class="btn sm" id="syncBtn">${I.install} همگام‌سازی</button>
          ${done ? '' : `<button class="btn sm danger" id="stopBtn">${I.stop} پایان زودهنگام</button>`}
          <button class="btn sm" id="delBtn">حذف تست</button>
        </div>
      </div>
      ${st ? verdictCard(st, res?.bench, L.settings.targetR) : `<div class="card glass"><div class="empty">${now < t.start ? 'تست از کندل ۵ دقیقه‌ای بعدی شروع می‌شود…' : '<span class="loader"></span><br>در حال ساخت نتیجه از کندل‌های بازار…'}</div></div>`}
      <div class="span-2">${st ? kpiTiles(st, { k: 'سیگنال اسکنر', v: res?.signals ?? '—', s: `${durLabel(testDays(t))} · ${profName(L.settings)}`, R: L.settings.targetR }) : ''}</div>
      <div class="card glass span-2"><h3>تنظیمات این تست</h3><div class="tc-cfg">
        <span>پروفایل: <b>${profName(L.settings)}</b></span><span>ریسک هر معامله: <b class="num">${L.settings.riskPct}%</b></span><span>هدف: <b class="num">${L.settings.targetR}R</b></span><span>نگه‌داری: <b class="num">${L.settings.maxHoldHours}</b> ساعت</span><span>پوزیشن هم‌زمان: <b class="num">${L.settings.maxOpen}</b></span><span>شورت: <b>${L.settings.allowShort ? 'روشن' : 'خاموش'}</b></span></div>
        <div class="muted" style="font-size:12.5px;margin-top:8px;line-height:1.9">ستاپ‌ها: ${enabled.map(k => STRATEGIES[k].name).join('، ')}<br>دارایی‌ها: ${testSymbols(t).map(s => assetBySymbol[s]?.short || s).join('، ')}</div></div>
      ${res ? `<div class="span-2">${accuracyCard(res, enabled)}</div>` : ''}
      <div class="card glass span-2"><h3>منحنی سرمایه <span class="muted">هر نقطه = بسته شدن یک کندل ۵ دقیقه‌ای</span></h3><div class="chart-box" id="eqChart"></div></div>
      <div class="card glass"><h3>پوزیشن‌های باز <span class="muted">قیمت زنده</span></h3><div class="list" id="openList">${openList(res)}</div></div>
      <div class="card glass"><h3>آخرین معاملات <span class="muted"><a href="#trades" id="allTrades">همه</a></span></h3><div class="list">${res && res.closed.length ? res.closed.slice(-6).reverse().map(x => tradeRow(x, false, res)).join('') : '<div class="empty">هنوز معامله‌ای بسته نشده</div>'}</div></div>
      ${st && st.n ? `<div class="span-2 grid cols-2">${breakdown(st, enabled)}</div>` : ''}
      ${res ? `<div class="span-2">${blockedCard(res)}</div>` : ''}
    </div></div>`;
  const eq = createAreaChart($('#eqChart'), { base: L.settings.capital, emptyText: 'منحنی سرمایه بعد از اولین کندل‌ها رسم می‌شود' });
  charts.push(eq);
  eq.setData(res ? thin(res.equity, 600).concat(res.equity.length ? [[Date.now(), st.equity]] : []) : snap?.equity || [], L.settings.capital);
  $('#backBtn').onclick = () => { S.view = null; render(); window.scrollTo({ top: 0 }); };
  $('#refreshBtn').onclick = () => refreshTests(true);
  $('#syncBtn').onclick = showSync;
  $('#stopBtn') && ($('#stopBtn').onclick = () => stopTest(t));
  $('#delBtn').onclick = () => deleteTest(t);
  $('#allTrades').onclick = e => { e.preventDefault(); S.tradesSrc = t.id; go('trades'); };
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
  updateLoading();
}
const pnlPills = (st, cap) => `<span class="pill ${st.pnl >= 0 ? 'up' : 'down'} num">${signed(st.pnl)} USDT</span><span class="pill ${st.pnl >= 0 ? 'up' : 'down'} num">${signed(st.pnl / cap * 100)}%</span>`;
function openList(res) {
  if (!res || !res.open.length) return '<div class="empty">پوزیشن بازی نیست</div>';
  return res.open.map(x => tradeRow(x, true, res)).join('');
}

// light refresh on price ticks
function onPrices() {
  if (S.page === 'dash' && !S.detail) {
    const t = S.view && testById(S.view);
    if (t && S.res[t.id]) {
      const res = S.res[t.id];
      const st = computeStats(res, S.prices);
      const e = $('#eqVal'); if (e) e.innerHTML = `${nf(st.equity)}<small>USDT</small>`;
      const p = $('#pnlRow'); if (p) p.innerHTML = pnlPills(st, t.settings.capital);
      const u = $('#unrealVal'); if (u) { u.textContent = signed(st.unrealized); u.className = 'num ' + cls(st.unrealized); }
      const o = $('#openList'); if (o) { o.innerHTML = openList(res); o.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym)); }
    } else if (!t) {
      let cap = 0, eq = 0;
      for (const x of S.tests) {
        const { st } = testStatsOf(x); cap += x.settings.capital; eq += st ? st.equity : x.settings.capital;
        if (!st) continue;
        const e = document.querySelector(`[data-teq="${x.id}"]`); if (e) e.innerHTML = `${nf(st.equity)}<small>USDT</small>`;
        const p = document.querySelector(`[data-tpnl="${x.id}"]`); if (p) p.innerHTML = pnlPills(st, x.settings.capital);
      }
      const te = $('#totEq'); if (te) te.innerHTML = `${nf(eq)}<small>USDT</small>`;
      const tp = $('#totPnl'); if (tp && cap) { const pnl = eq - cap; tp.innerHTML = `<span class="pill ${pnl >= 0 ? 'up' : 'down'} num">${signed(pnl)} USDT</span><span class="pill ${pnl >= 0 ? 'up' : 'down'} num">${signed(pnl / cap * 100)}%</span>`; }
    }
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
  const ft = focusTest();
  const res = ft ? S.res[ft.id] : null;
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
      <div class="card glass"><h3>معاملات ربات روی ${esc(a.name)}${ft && S.tests.length > 1 ? ` <span class="muted">${esc(ft.name)}</span>` : ''}</h3><div class="list">${openPos ? tradeRow(openPos, true, res) : ''}${mine.slice(-8).reverse().map(x => tradeRow(x)).join('') || (openPos ? '' : '<div class="empty">ربات هنوز روی این نماد معامله نکرده</div>')}</div></div>
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
  const srcs = [...S.tests.slice().reverse().map(x => [x.id, x.name]), ['bt', 'بک‌تست']];
  if (!srcs.some(([k]) => k === S.tradesSrc)) S.tradesSrc = focusTest()?.id || 'bt';
  const isBt = S.tradesSrc === 'bt';
  const res = isBt ? S.bt.res : S.res[S.tradesSrc];
  const closed = res ? [...res.closed].reverse() : [];
  const openT = !isBt && res ? res.open : [];
  main.innerHTML = `<div class="page">${topbar('معاملات')}
    <div class="toolbar">
      <div class="chips src-chips">${srcs.map(([k, n]) => `<button data-src="${k}" class="chip ${S.tradesSrc === k ? 'active' : ''}">${esc(n)}</button>`).join('')}</div>
    </div>
    <div class="toolbar">
      <div class="seg">${[['closed', `بسته (${closed.length})`], ['open', `باز (${openT.length})`]].map(([k, n]) => `<button data-tab="${k}" class="${S.tradesTab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <div style="flex:1"></div>
      <button class="btn sm" id="csvBtn" ${closed.length ? '' : 'disabled'}>${I.download} خروجی CSV</button>
    </div>
    <div class="card glass"><div class="list">
      ${S.tradesTab === 'open' ? (openT.map(x => tradeRow(x, true, res)).join('') || '<div class="empty">پوزیشن بازی نیست</div>')
        : (closed.slice(0, 300).map(x => tradeRow(x)).join('') || `<div class="empty">${res ? 'هنوز معامله‌ای بسته نشده' : isBt ? 'هنوز بک‌تستی اجرا نشده' : S.tests.length ? 'در حال ساخت نتیجه…' : 'هنوز تستی شروع نشده'}</div>`)}
      ${closed.length > 300 && S.tradesTab === 'closed' ? `<div class="empty">${closed.length - 300} معامله‌ی قدیمی‌تر در فایل CSV هست</div>` : ''}
    </div></div></div>`;
  main.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { S.tradesSrc = b.dataset.src; if (b.dataset.src !== 'bt') S.focus = b.dataset.src; render(); });
  main.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tradesTab = b.dataset.tab; render(); });
  main.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym));
  $('#csvBtn').onclick = () => exportCSV(closed);
}
function exportCSV(trades) {
  const head = ['id', 'symbol', 'setup', 'side', 'entry_time', 'entry', 'stop', 'target', 'qty', 'notional_usdt', 'risk_usdt', 'exit_time', 'exit', 'reason', 'fees_usdt', 'pnl_usdt', 'R'];
  const lines = [head.join(',')].concat(trades.map(x => [x.id, x.symbol, x.setup, x.dir > 0 ? 'long' : 'short', new Date(x.entryTime).toISOString(), x.entry, x.stop, x.target, x.qty, x.notional.toFixed(2), x.riskUSDT.toFixed(2), new Date(x.exitTime).toISOString(), x.exit, x.reason, x.fees.toFixed(4), x.pnl.toFixed(4), x.R.toFixed(3)].join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const filename = `trade-lab-${S.tradesSrc === 'bt' ? 'backtest' : 'test-' + (S.tests.findIndex(x => x.id === S.tradesSrc) + 1)}-${new Date().toISOString().slice(0, 10)}.csv`;
  if (window.claude?.use) { // inside claude.ai the viewer offers the file
    window.claude.use('downloads').then(dl => {
      if (!dl) return toast('دانلود فایل در این صفحه در دسترس نیست');
      dl.save({ filename, data: blob }).catch(e => { if (e?.code !== 'declined') toast('ذخیره‌ی فایل انجام نشد'); });
    });
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
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
        <div class="seg">${[1, 3, 7, 14, 30].map(d => `<button data-days="${d}" class="${B.days === d ? 'active' : ''}">${d} روز</button>`).join('')}</div>
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
      <div class="span-2">${accuracyCard(res)}</div>
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
  res.targetR = S.settings.targetR;
  res.equity = thin(res.equity, 800);
  res.events = [];
  B.res = res; B.running = null;
  save('bt', res);
  render();
}

/* ---------------- page: settings ---------------- */
function pageSettings(main) {
  const st = S.settings;
  const locked = S.tests.some(x => x.status === 'running');
  const num = (key, label, hint, step = 'any', min = 0, max = 1e9) => `<div class="field"><div class="lbl"><b>${label}</b><span>${hint}</span></div><input class="input" type="number" inputmode="decimal" data-k="${key}" value="${st[key]}" step="${step}" min="${min}" max="${max}"></div>`;
  const sw = (key, label, hint, checked, attr = 'data-k') => `<div class="field"><div class="lbl"><b>${label}</b><span>${hint}</span></div><label class="switch"><input type="checkbox" ${attr}="${key}" ${checked ? 'checked' : ''}><span></span></label></div>`;
  main.innerHTML = `<div class="page">${topbar('تنظیمات')}
    ${locked ? '<div class="note warn" style="margin-bottom:12px">تست‌های در جریان با تنظیمات لحظه‌ی شروعشان ادامه می‌دهند تا نتیجه‌شان دست‌کاری نشود. تغییرها روی بک‌تست و تست‌های تازه اثر دارند.</div>' : ''}
    <div class="grid cols-2">
      <div class="card glass"><h3>ظاهر و اپ</h3>
        <div class="field"><div class="lbl"><b>تم</b><span>سورمه‌ای تیره یا سفید</span></div><div class="seg" id="themeSeg">${[['auto', 'خودکار'], ['light', 'روشن'], ['dark', 'تیره']].map(([k, n]) => `<button data-theme="${k}" class="${S.theme === k ? 'active' : ''}">${n}</button>`).join('')}</div></div>
        ${sw('notifications', 'اعلان معامله‌ها', 'وقتی اپ باز است، ورود و خروج‌ها را اعلان می‌دهد', st.notifications)}
        <div class="field"><div class="lbl"><b>نصب روی دستگاه</b><span id="installHint">${installHint()}</span></div><button class="btn sm" id="installBtn" ${S.installEvt ? '' : 'disabled'}>${I.install} نصب</button></div>
      </div>
      <div class="card glass"><h3>سرمایه و دوره‌ی تست</h3>
        ${num('capital', 'سرمایه‌ی مجازی (USDT)', 'پیش‌فرض ۱۰۰۰ تتر', 1, 10)}
        <div class="field"><div class="lbl"><b>مدت پیش‌فرض تست تازه</b><span>کوتاه‌تر = نتیجه‌ی سریع‌تر</span></div></div>
        <div class="chips" style="flex-wrap:wrap;margin:-4px 0 8px">${DURATIONS.map(([d, n]) => `<button class="chip ${Math.abs(st.testDays - d) < 1e-6 ? 'active' : ''}" data-dur="${d}">${n}</button>`).join('')}</div>
        <div class="field"><div class="lbl"><b>پروفایل</b><span>${activeProfile(st) === 'custom' ? 'سفارشی' : PROFILES[activeProfile(st)].desc}</span></div><div class="seg">${Object.entries(PROFILES).map(([k, pr]) => `<button data-prof="${k}" class="${activeProfile(st) === k ? 'active' : ''}">${pr.name}</button>`).join('')}</div></div>
        ${num('maxHoldHours', 'حداکثر نگه‌داری (ساعت)', 'بازار ۲۴ ساعته زنگ بسته شدن ندارد؛ بعد از این مدت پوزیشن بسته می‌شود', 0.5, 0.5, 72)}
      </div>
      <div class="card glass"><h3>مدیر بودجه و ریسک <span class="muted">trader-budget / trader-risk</span></h3>
        ${num('riskPct', 'ریسک هر معامله (% حساب)', 'ضرر اگر حد ضرر بخورد؛ ۱٪ از ۱۰۰۰ = ۱۰ تتر', 0.1, 0.1, 10)}
        ${num('targetR', 'هدف سود (R)', 'چند برابر ریسک؛ trader-exit پیش‌فرض ۲R', 0.25, 0.5, 10)}
        ${num('maxOpen', 'حداکثر پوزیشن باز', 'هم‌زمان روی دارایی‌های مختلف', 1, 1, 60)}
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
      <div class="card glass"><h3>ستاپ‌ها <span class="muted">پیش‌فرض تست‌های تازه و بک‌تست</span></h3>
        ${[['trader', 'از مهارت‌های تریدر'], ['chart', 'از مهارت تحلیل‌گر چارت']].map(([src, title]) => `<div class="grp-h">${title}</div>` + Object.entries(STRATEGIES).filter(([, s]) => s.src === src).map(([k, s]) => sw(k, s.name, `<span class="tag fam">${FAMILIES[s.family]}</span> ${s.desc}`, st.strategies[k], 'data-strat')).join('')).join('')}
      </div>
      <div class="card glass"><h3>دارایی‌ها <span class="muted">${ASSETS.filter(a => st.symbols[a.symbol]).length} از ${ASSETS.length}</span></h3>
        ${Object.entries(GROUPS).map(([g, gn]) => `<details class="grp" ${g === 'meme' || g === 'crypto' ? '' : 'open'}><summary><span>${gn} <span class="muted">(${ASSETS.filter(a => a.group === g && st.symbols[a.symbol]).length}/${ASSETS.filter(a => a.group === g).length})</span></span><span class="grp-acts"><button class="btn sm" data-grp-on="${g}">همه</button><button class="btn sm" data-grp-off="${g}">هیچ</button></span></summary>
          ${ASSETS.filter(a => a.group === g).map(a => sw(a.symbol, a.name, `${a.symbol}${a.market === 'futures' ? ' · فیوچرز' : ''}${unavailable.has(a.symbol) ? ' · در دسترس نیست' : ''}`, st.symbols[a.symbol], 'data-sym-t')).join('')}</details>`).join('')}
      </div>
      <div class="card glass"><h3>داده‌ها</h3>
        <div class="field"><div class="lbl"><b>بازگشت به تنظیمات پیش‌فرض</b><span>تست‌های جاری دست نمی‌خورند</span></div><button class="btn sm" id="defBtn">پیش‌فرض</button></div>
        <div class="field"><div class="lbl"><b>پاک کردن همه‌چیز</b><span>همه‌ی تست‌ها، بک‌تست و کندل‌های ذخیره‌شده روی این دستگاه</span></div><button class="btn sm danger" id="wipeBtn">پاک کردن</button></div>
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
  const grp = (g, on) => { ASSETS.filter(a => a.group === g).forEach(a => { S.settings.symbols[a.symbol] = on; }); persist(); render(); };
  main.querySelectorAll('[data-grp-on]').forEach(b => b.onclick = e => { e.preventDefault(); grp(b.dataset.grpOn, true); });
  main.querySelectorAll('[data-grp-off]').forEach(b => b.onclick = e => { e.preventDefault(); grp(b.dataset.grpOff, false); });
  main.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { S.theme = b.dataset.theme; applyTheme(); render(); });
  main.querySelectorAll('[data-dur]').forEach(b => b.onclick = () => { S.settings.testDays = +b.dataset.dur; persist(); render(); });
  main.querySelectorAll('[data-prof]').forEach(b => b.onclick = () => { applyProfile(b.dataset.prof); render(); toast('پروفایل ' + PROFILES[b.dataset.prof].name + ' اعمال شد'); });
  $('#installBtn').onclick = async () => { if (!S.installEvt) return; S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; render(); };
  $('#defBtn').onclick = () => { S.settings = mergeSettings({}); persist(); render(); toast('تنظیمات پیش‌فرض برگشت'); };
  $('#wipeBtn').onclick = async () => {
    if (!(await confirmBox('همه‌ی داده‌ها روی این دستگاه پاک شود؟', 'پاک کردن'))) return;
    S.tests.forEach(x => remove('snap:' + x.id));
    ['live', 'liveSnap', 'bt', 'seenEvents', 'seen2'].forEach(remove); await idbClear();
    S.tests = []; saveTests(); S.res = {}; S.seen = {}; S.view = null; S.bt.res = null; toast('پاک شد'); render();
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

S.tests = loadTests();
applyTheme();
render();
document.fonts?.ready.then(() => charts.forEach(c => c.redraw && c.redraw()));

let tickPending = false;
async function boot() {
  const pj = load('pendingJoin', null);
  if (pj) { remove('pendingJoin'); history.replaceState(null, '', location.pathname + '#join=' + pj); }
  if (await handleJoin()) { /* joined */ }
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
  refreshTests(true);
  setInterval(() => refreshTests(false), 20000);
  setInterval(async () => { try { const t = await tickers(ASSETS.map(a => a.symbol)); for (const [s, v] of Object.entries(t)) S.t24[s] = v; } catch { /* */ } }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTests(false); });
}
boot();
