import { ASSETS, GROUPS, STRATEGIES, FAMILIES, DEFAULT_SETTINGS, BAR_MS, WARMUP_BARS, OPTIMIZED, PRO_DEFAULTS, assetBySymbol } from './config.js';
import { runSimulation, closeAllAtEnd, computeStats, signalStats, BLOCK_REASONS } from './engine.js';
import { ensureHistory, ensureDeriv, ensureHourly, spotUniverse, klines, tickers, liveStream, pool, unavailable, stale, netState, toSeries, mode, probe } from './data.js';
import { runRotation, pickRotation, ROT_WARM_H } from './rotation.js';
import { confidence, walkForward, wfWarmupBars } from './validate.js';
import { REGIME_NAMES } from './regime.js';
import { SESSION_NAMES } from './calendar.js';
import { createCandleChart, createAreaChart, priceDecimals, sparkPath } from './chart.js';
import { prepare } from './strategies.js';
import { FACTORS, analysisLine } from './analyst.js';
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

function deep(x) { return JSON.parse(JSON.stringify(x ?? null)); }
function mergeSettings(saved) {
  return {
    ...DEFAULT_SETTINGS, ...saved,
    strategies: { ...DEFAULT_SETTINGS.strategies, ...(saved.strategies || {}) },
    symbols: { ...DEFAULT_SETTINGS.symbols, ...(saved.symbols || {}) },
    // the pro desk is on for new tests unless it was switched off (null)
    pro: saved.pro === null ? null : { ...deep(PRO_DEFAULTS), ...(saved.pro || {}) },
  };
}
// bars needed before the start: slow averages on the signal timeframe, plus the learning warm-up
const warmupFor = st => Math.round(300 * Math.max(1, (st.pro?.tf || 5) / 5)) + (st.learn ? Math.round((st.learnWarmDays ?? 3) * 288) : 0);

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
const REASON = { target: 'هدف', stop: 'حد ضرر', trail: 'حد ضرر جابه‌جاشده', time: 'پایان زمان', end: 'پایان تست', rotate: 'از گروه برتر خارج شد', market: 'بیت‌کوین نزولی شد' };
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
  const a = assetBySymbol[sym] || { short: sym.replace(/USDT$/, ''), color: colorOf(sym) };
  return `<span class="coin" style="background:linear-gradient(145deg, ${a.color}, ${shade(a.color)});width:${size}px;height:${size}px">${esc(a.short.slice(0, 4))}</span>`;
}
function colorOf(sym) { let h = 0; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return '#' + (0x335577 + (h % 0x8899aa)).toString(16).padStart(6, '0').slice(0, 6); }
const coinName = s => assetBySymbol[s]?.name || s.replace(/USDT$/, '');
const setupName = k => STRATEGIES[k]?.name || (k === 'momentum' ? 'چرخش مومنتوم' : k);
function shade(hex) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.round(v * 0.62)); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }

function kpiTiles(st, extra = {}) {
  const pf = st.profitFactor === Infinity ? '∞' : nf(st.profitFactor, 2);
  return `<div class="kpis">
    <div class="kpi glass flat"><div class="k">معاملات بسته / باز</div><div class="v num">${st.n} <span class="muted" style="font-size:15px">/ ${st.openCount}</span></div><div class="s">${st.wins} برد · ${st.losses} باخت</div></div>
    <div class="kpi glass flat"><div class="k">نرخ برد</div><div class="v num">${nf(st.winRate, 1)}%</div><div class="s">${!st.n ? 'بعد از بسته شدن معامله‌ها' : extra.noBE ? 'سهم معامله‌های سودده' : `سربه‌سر با هدف ${extra.R || S.settings.targetR}R: ${nf(100 / (1 + (extra.R || S.settings.targetR)), 0)}%`}</div></div>
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

function breakdown(st, enabled, assetsOnly = false) {
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
  const symRows = syms.length ? syms.map(([s, v]) => `<div class="row">${coin(s, 32)}<div class="main"><div class="t1">${esc(coinName(s))}</div><div class="t2">${v.n} معامله · برد ${nf(v.wins / v.n * 100, 0)}%</div></div><div class="end"><div class="t1 num ${cls(v.pnl)}">${signed(v.pnl)}</div></div></div>`).join('') : '<div class="empty">هنوز معامله‌ای نیست</div>';
  const assetCard = `<div class="card glass"><h3>عملکرد هر دارایی</h3><div class="list">${symRows}</div></div>`;
  if (assetsOnly) return assetCard;
  return `<div class="card glass"><h3>عملکرد هر مهارت (ستاپ) <span class="muted">سود/زیان خالص USDT</span></h3><div class="bars">${bars}</div></div>
    ${assetCard}`;
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
  const pnl = live ? (px - x.entry) * x.qty * x.dir - x.entryFee + (x.pGross || 0) - (x.pFees || 0) - (x.funding || 0) : x.pnl;
  const R = pnl / x.riskUSDT;
  const side = x.dir > 0 ? '<span class="tag up">خرید</span>' : '<span class="tag down">فروش</span>';
  const reason = (live ? `<span class="tag">باز</span>` : `<span class="tag ${x.reason === 'target' ? 'up' : x.reason === 'stop' ? 'down' : ''} reason">${REASON[x.reason] || x.reason}</span>`) + (x.partialDone ? ' <span class="tag up">نیمی با سود بسته شد</span>' : '');
  return `<div class="row trade click" data-sym="${x.symbol}">${coin(x.symbol)}
    <div class="main"><div class="t1">${esc(coinName(x.symbol))} ${side} ${reason}</div>
    <div class="t2">${setupName(x.setup)}${x.rank ? ` (رتبه‌ی ${faNum(x.rank)}، رشد ${nf(x.mom * 100, 1)}٪)` : ''} · <span class="num">${fp(x.entry)} → ${fp(px)}</span> · حد ضرر <span class="num">${fp(x.stop)}</span> · هدف <span class="num">${fp(x.target)}</span></div>
    <div class="t2">${fdt(x.entryTime)}${live ? '' : ' تا ' + fdt(x.exitTime)} · <span class="num">${nf(x.notional)}</span> USDT</div>
    ${x.ana ? `<div class="t2 ana-line"><span class="grade g${x.ana.grade}">${x.ana.grade}</span> ${esc(analysisLine(x.ana))}</div>` : ''}
    ${x.learn ? `<div class="t2 ana-line">🧠 ${esc(x.learn.why)}${x.learn.mult && x.learn.mult !== 1 ? ` · ریسک ×${x.learn.mult.toFixed(2)}` : ''}</div>` : ''}
    ${x.stop0 != null ? `<div class="t2 ana-line">کندل ${faNum(x.tf || 5)} دقیقه‌ای${x.reg ? ` · ${REGIME_NAMES[x.reg] || x.reg}` : ''} · بیشترین سود در مسیر <span class="num up">${nf(x.mfe, 1)}R</span> · بیشترین ضرر در مسیر <span class="num down">${nf(x.mae, 1)}R</span>${x.funding ? ` · فاندینگ <span class="num">${signed(-x.funding)}</span>` : ''}${x.brake ? ` · ریسک نصف (ترمز)` : ''}</div>` : ''}</div>
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
const isRot = t => t.kind === 'rotation';
const testSymbols = t => (isRot(t) ? t.rot.uni : ASSETS.map(a => a.symbol).filter(s => t.settings.symbols[s] && !unavailable.has(s)));
const testStrats = t => isRot(t) ? ['momentum'] : Object.keys(STRATEGIES).filter(k => t.settings.strategies[k] && (!t.settings.groupStrategies || Object.values(t.settings.groupStrategies).some(l => l.includes(k))));
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
  const todoAll = S.tests.filter(t => !(S.res[t.id]?.final));
  if (!todoAll.length || refreshing) return;
  const todo = todoAll.filter(t => !isRot(t)), rots = todoAll.filter(isRot);
  if (!force && nowBar === lastRefreshBar && todoAll.every(t => S.res[t.id])) return;
  refreshing = true;
  if (!todo.length) { try { for (const t of rots) await refreshRotation(t, force); } finally { refreshing = false; lastRefreshBar = nowBar; if (['dash', 'trades'].includes(S.page) && !S.detail) render(); } return; }
  // one download per asset for all tests: from the earliest start that needs it
  const need = {};
  let to = 0;
  for (const t of todo) {
    const from = t.start - (t.warmup || 200) * BAR_MS;
    to = Math.max(to, Math.min(nowBar, t.end));
    for (const s of testSymbols(t)) need[s] = Math.min(need[s] ?? Infinity, from);
    if (t.settings.pro?.regime) need.BTCUSDT = Math.min(need.BTCUSDT ?? Infinity, from); // bitcoin leads crypto
  }
  const wantDeriv = new Set(todo.filter(t => t.settings.pro?.deriv).flatMap(t => testSymbols(t)));
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
    const dv = {};
    if (wantDeriv.size) await pool([...wantDeriv], 4, async s => { try { dv[s] = await ensureDeriv(s, need[s], to); } catch { /* no futures data */ } });
    for (const t of todo) {
      const from = t.start - (t.warmup || 200) * BAR_MS, tt = Math.min(nowBar, t.end);
      const data = {};
      for (const s of testSymbols(t)) if (full[s]) data[s] = sliceSeries(full[s], from, tt);
      if (t.settings.pro?.regime && full.BTCUSDT && !data.BTCUSDT) data.BTCUSDT = sliceSeries(full.BTCUSDT, from, tt);
      if (!Object.keys(data).length) continue;
      if (Date.now() < t.start) { S.res[t.id] = null; continue; }
      let res = runSimulation({ data, settings: t.settings, start: t.start, end: Math.min(tt, t.end), capital: t.settings.capital, deriv: t.settings.pro?.deriv ? dv : null });
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
    for (const t of rots) await refreshRotation(t, force);
    S.liveError = '';
    lastRefreshBar = nowBar;
  } catch (e) {
    S.liveError = 'دریافت داده از Binance ممکن نشد. اتصال اینترنت یا VPN را بررسی کنید.'; S.offline = true;
  } finally {
    refreshing = false; S.liveLoading = null;
    if (['dash', 'trades'].includes(S.page) && !S.detail) render();
  }
}

/* ---------------- momentum rotation tests (many coins, hourly) ---------------- */
const HOUR = 3600000;
const rotHours = new Map(); // test id -> the hour last computed
async function refreshRotation(t, force) {
  const nowH = Math.floor(Date.now() / HOUR) * HOUR;
  if (!force && rotHours.get(t.id) === nowH && S.res[t.id]) return;
  if (Date.now() < t.start) { S.res[t.id] = null; return; }
  const to = Math.min(nowH, t.end), from = t.start - ROT_WARM_H * HOUR;
  const series = {};
  S.liveLoading = { done: 0, total: t.rot.uni.length }; updateLoading();
  await pool(t.rot.uni, 4, async s => { try { series[s] = await ensureHourly(s, from, to); } catch { /* not traded any more */ } S.liveLoading.done++; updateLoading(); });
  S.liveLoading = null;
  if (!Object.keys(series).length) throw new Error('no data');
  const done = Date.now() >= t.end && to >= t.end - HOUR;
  const res = runRotation({ series, start: t.start, end: to, params: t.rot.p, capital: t.settings.capital, closeAtEnd: done });
  if (done) { res.final = true; if (t.status !== 'done') { t.status = 'done'; saveTests(); const st = computeStats(res); toast(`«${esc(t.name)}» تمام شد: ${signed(st.pnl)} USDT`); notify('ترید لب', `${t.name} تمام شد. نتیجه: ${signed(st.pnl)} USDT`); } }
  const B = series.BTCUSDT;
  if (B && B.t.length) { const i0 = B.t.findIndex(x => x >= t.start); let i1 = B.t.length - 1; while (i1 > 0 && B.t[i1] >= to) i1--; res.bench = i0 >= 0 && i1 >= i0 ? (B.c[i1] / B.o[i0] - 1) * 100 : null; }
  res.targetR = null;
  S.res[t.id] = res; rotHours.set(t.id, nowH);
  announce(t, res, 0);
  save('snap:' + t.id, { at: Date.now(), stats: computeStats(res), equity: thin(res.equity, 160) });
}
// a new rotation test: today's 200 most traded coins, settings picked from the last 60 days
async function startRotationTest(dr) {
  const wrap = document.createElement('div'); wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal glass" role="dialog" aria-modal="true"><p>آماده‌سازی تست مومنتوم</p><div class="muted" id="rotMsg" style="font-size:13px;line-height:1.9;margin-top:8px"><span class="loader"></span> فهرست ۲۰۰ ارز پرحجم Binance…</div></div>`;
  document.body.appendChild(wrap);
  const msg = h => { const m = wrap.querySelector('#rotMsg'); if (m) m.innerHTML = `<span class="loader"></span> ${h}`; };
  try {
    const uni = await spotUniverse(200);
    const start = Math.ceil(Date.now() / HOUR) * HOUR, pickFrom = start - 60 * DAY;
    const series = {}; let n = 0;
    await pool(uni, 4, async s => { try { series[s] = await ensureHourly(s, pickFrom - ROT_WARM_H * HOUR, start); } catch { /* */ } msg(`دریافت کندل‌های ساعتی ${faNum(++n)} از ${faNum(uni.length)}`); });
    msg('امتحان ۲۴ ترکیب روی ۶۰ روز گذشته و انتخاب بهترین…');
    await new Promise(r => setTimeout(r, 30));
    const { best } = pickRotation({ series, start: pickFrom, end: start, capital: +dr.capital || 1000 });
    const capital = Math.max(10, +dr.capital || 1000);
    const settings = { ...deep(S.settings), capital, testDays: dr.days, pro: null, analyst: false, learn: false };
    const t = { id: newId(), kind: 'rotation', name: (dr.name || '').trim() || `مومنتوم ${faNum(S.tests.length + 1)}`, status: 'running', start, end: start + dr.days * DAY, settings, warmup: ROT_WARM_H,
      rot: { uni: uni.filter(s => series[s]), p: best.p, pick: { ret: best.ret, dd: best.dd, n: best.n, from: pickFrom, to: start } } };
    S.tests.push(t); saveTests(); S.seen[t.id] = 0; save('seen2', S.seen); S.focus = t.id; S.draft = null;
    wrap.remove();
    toast(`«${esc(t.name)}» با ${faNum(t.rot.uni.length)} ارز شروع شد. اولین چرخش در سر ساعت بعد.`);
    render(); refreshTests(true);
  } catch (e) {
    wrap.remove(); toast('دریافت داده از Binance ممکن نشد. اتصال اینترنت را بررسی کنید.');
  }
}
const rotDesc = p => `رشد ${faNum(p.lookH / 24)} روزه، ${faNum(p.top)} ارز برتر، حد ضرر متحرک ${faNum(Math.round(p.trail * 100))}٪${p.btcFilter ? '، با فیلتر بیت‌کوین' : ''}`;

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
    const nm = coinName(e.symbol);
    if (e.type === 'entry') { const m = `ورود ${e.dir > 0 ? 'خرید' : 'فروش'} ${nm} · ${setupName(e.setup)}`; toast(tag + m); notify(t.name, m); }
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
const BRAINS = {
  learn: ['تحلیل‌گر + خودآموز', 'قبل از هر ورود، چارت با چک‌لیست تحلیل‌گر بررسی می‌شود. ربات از نتیجه‌ی هر سیگنال درس می‌گیرد و بر اساس تجربه، معامله‌های بد را رد و معامله‌های خوب را بزرگ‌تر می‌کند. قبل از شروع، ۳ روز گذشته‌ی بازار را تماشا می‌کند تا با تجربه شروع کند.'],
  analyst: ['فقط تحلیل‌گر', 'هر سیگنال با چک‌لیست تحلیل‌گر امتیاز می‌گیرد و سیگنال‌های با امتیاز منفی رد می‌شوند؛ بدون یادگیری.'],
  off: ['ساده', 'فقط قوانین ستاپ‌ها، مثل نسخه‌ی اول؛ برای مقایسه.'],
};
const brainOf = st => st.learn ? 'learn' : st.analyst ? 'analyst' : 'off';
function freshDraft() {
  const prof = activeProfile(S.settings);
  return { kind: 'setups', name: `تست ${faNum(S.tests.length + 1)}`, capital: S.settings.capital, days: S.settings.testDays, profile: prof === 'custom' ? 'custom' : prof, strat: 'all', assets: 'all', brain: brainOf(S.settings), pro: !!S.settings.pro };
}
const faNum = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
function draftSettings(dr) {
  const st = JSON.parse(JSON.stringify(S.settings));
  if (dr.profile !== 'custom' && PROFILES[dr.profile]) Object.assign(st, JSON.parse(JSON.stringify(PROFILES[dr.profile].set)));
  st.capital = Math.max(10, +dr.capital || 1000);
  st.testDays = dr.days;
  const ks = new Set(STRAT_SETS[dr.strat][1]());
  st.strategies = Object.fromEntries(Object.keys(STRATEGIES).map(k => [k, ks.has(k)]));
  const ss = new Set(ASSET_SETS[dr.assets][1]());
  st.symbols = Object.fromEntries(ASSETS.map(a => [a.symbol, ss.has(a.symbol)]));
  st.analyst = dr.brain !== 'off';
  st.learn = dr.brain === 'learn';
  if (dr.profile !== 'profit') st.pro = dr.pro ? (st.pro || deep(PRO_DEFAULTS)) : null; // the profit profile always uses the desk
  return st;
}
function newTestForm(dr) {
  const chips = (list, cur, attr) => list.map(([k, n]) => `<button class="chip ${cur === k ? 'active' : ''}" data-${attr}="${k}">${n}</button>`).join('');
  return `<div class="ntf">
    <div class="ntf-row"><label class="ntf-f"><span>نام تست</span><input class="input" id="ntName" maxlength="40" value="${esc(dr.name)}"></label>
    <label class="ntf-f"><span>بودجه (USDT)</span><input class="input num" id="ntCap" type="number" inputmode="decimal" min="10" step="10" value="${dr.capital}"></label></div>
    <div class="pick"><div class="pick-l">نوع تست</div><div class="chips">${chips([['setups', 'ستاپ‌ها (۵۷ دارایی)'], ['rotation', 'مومنتوم ۲۰۰ ارز']], dr.kind || 'setups', 'nkind')}</div></div>
    <div class="pick"><div class="pick-l">مدت</div><div class="chips">${chips(DURATIONS.map(([d, n]) => [String(d), n]), String(dr.days), 'ndur')}</div></div>
    ${dr.kind === 'rotation' ? `<div class="muted ntf-brain">هر روز ۲۰۰ ارز پرحجم Binance بر اساس رشد اخیر رتبه‌بندی می‌شوند؛ ربات قوی‌ترین‌ها را می‌خرد، با حد ضرر متحرک نگه می‌دارد و ضعیف‌شده‌ها را عوض می‌کند. قبل از شروع، ۲۴ ترکیب روی ۶۰ روز گذشته امتحان و بهترینش انتخاب می‌شود. کندل ساعتی اسپات، بدون نیاز به VPN.</div>
    <div class="note warn" style="margin-top:8px;font-size:12px">در اعتبارسنجی ۴ ماه گذشته این روش هم برتری پایدار نشان نداد: ترکیبی که در ۲ ماه اول بهترین بود، در ماه بعد ۹٪ ضرر داد. این تست برای سنجیدن روی بازار زنده است.</div>` : `
    <div class="pick"><div class="pick-l">پروفایل</div><div class="chips">${chips([...Object.entries(PROFILES).map(([k, p]) => [k, p.name]), ['custom', 'طبق تنظیمات']], dr.profile, 'nprof')}</div></div>
    <div class="pick"><div class="pick-l">ستاپ‌ها</div><div class="chips">${chips(Object.entries(STRAT_SETS).map(([k, v]) => [k, v[0]]), dr.strat, 'nstrat')}</div></div>
    <div class="pick"><div class="pick-l">دارایی‌ها</div><div class="chips">${chips(Object.entries(ASSET_SETS).map(([k, v]) => [k, v[0]]), dr.assets, 'nasset')}</div></div>
    <div class="pick"><div class="pick-l">مغز ربات</div><div class="chips">${chips(Object.entries(BRAINS).map(([k, v]) => [k, v[0]]), dr.brain, 'nbrain')}</div></div>
    <div class="muted ntf-brain">${BRAINS[dr.brain][1]}</div>
    ${dr.profile === 'profit' ? '' : `<div class="pick"><div class="pick-l">میز حرفه‌ای</div><div class="chips">${chips([['on', 'روشن (۱۰ مهارت)'], ['off', 'خاموش (مثل قبل)']], dr.pro ? 'on' : 'off', 'npro')}</div></div>`}
    <div class="muted ntf-sum">${draftSummary(dr)}</div>`}
  </div>`;
}
function draftSummary(dr) {
  const st = draftSettings(dr);
  const nS = Object.values(st.strategies).filter(Boolean).length, nA = Object.values(st.symbols).filter(Boolean).length;
  return `${nS} ستاپ روی ${nA} دارایی · ${dr.profile === 'custom' ? 'تنظیمات دستی' : PROFILES[dr.profile].desc} · ریسک هر معامله ${nf(st.capital * st.riskPct / 100)} تتر${st.pro ? ` · میز حرفه‌ای، کندل ${faNum(st.pro.tf)} دقیقه‌ای` : ''}`;
}
function bindNewTestForm(root, dr, rerender) {
  root.querySelector('#ntName').oninput = e => { dr.name = e.target.value; };
  root.querySelector('#ntCap').oninput = e => { dr.capital = Math.max(10, +e.target.value || 1000); const s = root.querySelector('.ntf-sum'); if (s) s.innerHTML = draftSummary(dr); };
  root.querySelectorAll('[data-nkind]').forEach(b => b.onclick = () => { dr.kind = b.dataset.nkind; if (dr.kind === 'rotation' && /^تست /.test(dr.name)) dr.name = `مومنتوم ${faNum(S.tests.length + 1)}`; rerender(); });
  root.querySelectorAll('[data-ndur]').forEach(b => b.onclick = () => { dr.days = +b.dataset.ndur; rerender(); });
  root.querySelectorAll('[data-nprof]').forEach(b => b.onclick = () => { dr.profile = b.dataset.nprof; rerender(); });
  root.querySelectorAll('[data-nstrat]').forEach(b => b.onclick = () => { dr.strat = b.dataset.nstrat; rerender(); });
  root.querySelectorAll('[data-nasset]').forEach(b => b.onclick = () => { dr.assets = b.dataset.nasset; rerender(); });
  root.querySelectorAll('[data-nbrain]').forEach(b => b.onclick = () => { dr.brain = b.dataset.nbrain; rerender(); });
  root.querySelectorAll('[data-npro]').forEach(b => b.onclick = () => { dr.pro = b.dataset.npro === 'on'; rerender(); });
}
function startTest(dr) {
  if (dr.kind === 'rotation') return startRotationTest(dr);
  const settings = draftSettings(dr);
  if (!Object.values(settings.strategies).some(Boolean)) return toast('هیچ ستاپی انتخاب نشده');
  if (!Object.values(settings.symbols).some(Boolean)) return toast('هیچ دارایی‌ای انتخاب نشده');
  const start = Math.ceil(Date.now() / BAR_MS) * BAR_MS;
  const t = { id: newId(), name: (dr.name || '').trim() || `تست ${faNum(S.tests.length + 1)}`, status: 'running', start, end: start + dr.days * DAY, settings, warmup: warmupFor(settings) };
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
// the validator (backtest page) can replace the profit profile with a fresh walk-forward choice
const savedOpt = load('optProfile', null);
const PROFILES = {
  profit: { name: 'سودمحور', desc: savedOpt?.desc || OPTIMIZED.desc, set: deep(savedOpt?.set || OPTIMIZED.set) },
  standard: { name: 'استاندارد', desc: 'هدف ۲R، نگه‌داری تا ۴ ساعت، ریسک ۱٪', set: { targetR: 2, maxHoldHours: 4, riskPct: 1, maxPositionPct: 30, maxOpen: 6, cooldownBars: 6, maxTradesPerDay: 60, dailyLossPct: 6, groupStrategies: null } },
  stress: { name: 'پرفشار', desc: 'هدف ۱.۵R، نگه‌داری تا ۱ ساعت، ریسک ۰.۵٪، تا ۱۲ پوزیشن هم‌زمان', set: { targetR: 1.5, maxHoldHours: 1, riskPct: 0.5, maxPositionPct: 12, maxOpen: 12, cooldownBars: 2, maxTradesPerDay: 300, dailyLossPct: 10, groupStrategies: null } },
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const activeProfile = st => Object.keys(PROFILES).find(k => Object.entries(PROFILES[k].set).every(([f, v]) => same(st[f], v))) || 'custom';
function applyProfile(k) { Object.assign(S.settings, JSON.parse(JSON.stringify(PROFILES[k].set))); save('settings', S.settings); }

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
    if (k === 'strategies' || k === 'symbols' || k === 'analyst' || k === 'learn' || k === 'maxCostR' || k === 'pro') continue;
    if (DEFAULT_SETTINGS[k] !== v) d[k] = v;
  }
  if (st.analyst) d.an = 1;   // sent explicitly: tests made before these existed have them off
  if (st.learn) d.le = 1;
  d.mc = st.maxCostR ?? 0;    // 0 = no cost filter (tests made before it existed)
  if (st.pro) d.pr = st.pro;  // the pro desk (tests made before it have none)
  d.sk = toBits(STRAT_KEYS.map(k => !!st.strategies[k]));
  d.sy = toBits(SYM_KEYS.map(s => !!st.symbols[s]));
  return d;
}
function settingsFromDiff(d, legacy) {
  const { sk, sy, an, le, mc, pr, strategies, symbols, analyst, learn, maxCostR, pro, ...rest } = d || {};
  const st = { ...DEFAULT_SETTINGS, ...rest, analyst: !!an, learn: !!le, maxCostR: mc ? mc : null, pro: pr || null };
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
  const payload = { v: 2, m: mode.demo ? 1 : 0, t: S.tests.map(t => isRot(t)
    ? { n: t.name, s: t.start, e: t.end, k: 'r', c: t.settings.capital, r: { u: t.rot.uni.map(x => x.replace(/USDT$/, '')).join(','), p: t.rot.p, k: t.rot.pick } }
    : { n: t.name, s: t.start, e: t.end, w: t.warmup || 200, d: settingsDiff(t.settings) }) };
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
    const t = x.k === 'r'
      ? { id: newId(), kind: 'rotation', name: x.n || `مومنتوم ${faNum(S.tests.length + 1)}`, status: Date.now() >= x.e ? 'done' : 'running', start: x.s, end: x.e, warmup: ROT_WARM_H,
          settings: { ...deep(DEFAULT_SETTINGS), capital: x.c || 1000, testDays: (x.e - x.s) / DAY, pro: null, analyst: false, learn: false },
          rot: { uni: x.r.u.split(',').map(z => z + 'USDT'), p: x.r.p, pick: x.r.k } }
      : { id: newId(), name: x.n || `تست ${faNum(S.tests.length + 1)}`, status: Date.now() >= x.e ? 'done' : 'running', start: x.s, end: x.e, settings: settingsFromDiff(x.d, x.legacy), warmup: x.w || 200 };
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
    const q = qrcode(0, 'L'); q.addData(link); q.make();
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
function staleNote() {
  if (!stale.size) return '';
  const fut = [...stale.keys()].filter(s => assetBySymbol[s]?.market === 'futures').length;
  const oldest = Math.min(...stale.values());
  return `<div class="note warn" style="margin-bottom:14px"><b>${faNum(stale.size)} دارایی به‌روز نشد</b>${fut ? ` (${faNum(fut)} تا از بازار فیوچرز)` : ''}: سرور Binance از این دستگاه در دسترس نیست. این دارایی‌ها با آخرین کندل‌های ذخیره‌شده (تا ${fdt(oldest)}) در تست می‌مانند و از آن به بعد معامله نمی‌شوند. سرور فیوچرز Binance از ایران معمولاً فقط با VPN باز می‌شود؛ با روشن شدن VPN، کندل‌های جاافتاده گرفته و همه‌ی تست‌ها دقیق بازسازی می‌شوند.</div>`;
}
function offlineCard() {
  if (!mode.demo && stale.size) return staleNote() + (S.offline ? offlineCard0() : '');
  return offlineCard0();
}
function offlineCard0() {
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
      ${[['۱', 'چند تست هم‌زمان', 'هر تست بودجه، مدت، پروفایل، ستاپ‌ها و دارایی‌های خودش را دارد؛ همه در یک پنل کنار هم'], ['۲', 'اسکنر', `${Object.keys(STRATEGIES).length} ستاپ (مهارت‌های تریدر و تحلیل‌گر چارت) روی ${ASSETS.length} دارایی؛ با میز حرفه‌ای روی کندل‌های ${faNum(S.settings.pro?.tf || 5)} دقیقه‌ای و فقط در حالت بازار مناسب هر ستاپ`], ['۳', 'ورود و خروج', 'فقط بعد از بسته شدن کندل؛ حد ضرر قبل از ورود، هدف بر حسب R و سقف زمان نگه‌داری'], ['۴', 'بودجه و ریسک', 'ریسک هر معامله درصدی از همان بودجه‌ی تست، حد ضرر روزانه و سقف پوزیشن باز'], ['۵', 'کارمزد واقعی', `کارمزد ${S.settings.feeSpotPct}% و لغزش ${S.settings.slippagePct}% در هر معامله کم می‌شود`], ['۶', 'همگام‌سازی', 'با دکمه‌ی «همگام‌سازی» همه‌ی تست‌ها روی گوشی یا لپ‌تاپ دیگر هم باز می‌شوند']]
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
    <div class="tc-meta">${isRot(t) ? `${durLabel(testDays(t))} · <span class="tag brain">مومنتوم ${faNum(t.rot.uni.length)} ارز</span> · ${rotDesc(t.rot.p)}` : `${durLabel(testDays(t))} · ${profName(t.settings)} · ${testStrats(t).length} ستاپ · ${testSymbols(t).length} دارایی`}${isRot(t) ? '' : t.settings.learn ? ' · <span class="tag brain">🧠 خودآموز</span>' : t.settings.analyst ? ' · <span class="tag brain">تحلیل‌گر</span>' : ''}${!isRot(t) && t.settings.pro ? ` · <span class="tag brain">حرفه‌ای · ${faNum(t.settings.pro.tf)}د</span>` : ''}</div>
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
    return `<div class="bar-row click" data-test="${t.id}"><div><b style="font-weight:600">${esc(t.name)}</b><div class="muted" style="font-size:11.5px">${durLabel(testDays(t))} · ${isRot(t) ? 'مومنتوم' : profName(t.settings)} · ${st ? st.n : 0} معامله</div></div>
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
      <div class="span-2">${st ? kpiTiles(st, isRot(t) ? { k: 'چرخش‌ها', v: res?.rebalances ?? '—', s: res?.marketOff ? `${faNum(res.marketOff)} بار در نقد ماند (بیت‌کوین نزولی)` : 'رتبه‌بندی روزانه', noBE: true } : { k: 'سیگنال اسکنر', v: res?.signals ?? '—', s: `${durLabel(testDays(t))} · ${profName(L.settings)}`, R: L.settings.targetR }) : ''}</div>
      ${isRot(t) ? rotConfigCard(t, res) : `<div class="card glass span-2"><h3>تنظیمات این تست</h3><div class="tc-cfg">
        <span>پروفایل: <b>${profName(L.settings)}</b></span><span>ریسک هر معامله: <b class="num">${L.settings.riskPct}%</b></span><span>هدف: <b class="num">${L.settings.targetR}R</b></span><span>نگه‌داری: <b class="num">${L.settings.maxHoldHours}</b> ساعت</span><span>پوزیشن هم‌زمان: <b class="num">${L.settings.maxOpen}</b></span><span>شورت: <b>${L.settings.pro ? (L.settings.pro.shorts ? 'روی فیوچرز' : 'خاموش') : L.settings.allowShort ? 'روشن' : 'خاموش'}</b></span><span>مغز ربات: <b>${BRAINS[brainOf(L.settings)][0]}</b></span><span>میز حرفه‌ای: <b>${L.settings.pro ? `روشن، کندل ${faNum(L.settings.pro.tf)} دقیقه‌ای` : 'خاموش'}</b></span></div>
        ${L.settings.pro ? `<div class="muted" style="font-size:12.5px;margin-top:8px;line-height:1.9">${proLines(L.settings.pro).join(' · ')}</div>` : ''}
        <div class="muted" style="font-size:12.5px;margin-top:8px;line-height:1.9">${L.settings.groupStrategies ? Object.entries(GROUPS).map(([g, gn]) => `ستاپ‌های ${gn}: ${(L.settings.groupStrategies[g] || []).filter(k => L.settings.strategies[k]).map(k => STRATEGIES[k].name).join('، ') || 'هیچ (این گروه معامله نمی‌شود)'}`).join('<br>') : `ستاپ‌ها: ${enabled.map(k => STRATEGIES[k].name).join('، ')}`}<br>${L.settings.maxCostR ? `سقف کارمزد: ${nf(L.settings.maxCostR * 100, 0)}٪ ریسک<br>` : ''}دارایی‌ها: ${testSymbols(t).map(s => assetBySymbol[s]?.short || s).join('، ')}</div></div>`}
      ${res?.learn ? `<div class="span-2">${experienceCard(res)}</div>` : res?.decisions ? `<div class="span-2">${decisionsCard(res)}</div>` : ''}
      ${res && res.closed.length ? `<div class="span-2 grid cols-2">${validationCard(res, L.settings)}${postTradeCard(res)}</div>` : ''}
      ${res ? `<div class="span-2">${accuracyCard(res, enabled)}</div>` : ''}
      <div class="card glass span-2"><h3>منحنی سرمایه <span class="muted">هر نقطه = بسته شدن یک کندل ۵ دقیقه‌ای</span></h3><div class="chart-box" id="eqChart"></div></div>
      <div class="card glass"><h3>پوزیشن‌های باز <span class="muted">قیمت زنده</span></h3><div class="list" id="openList">${openList(res)}</div></div>
      <div class="card glass"><h3>آخرین معاملات <span class="muted"><a href="#trades" id="allTrades">همه</a></span></h3><div class="list">${res && res.closed.length ? res.closed.slice(-6).reverse().map(x => tradeRow(x, false, res)).join('') : '<div class="empty">هنوز معامله‌ای بسته نشده</div>'}</div></div>
      ${st && st.n ? `<div class="span-2 grid cols-2">${breakdown(st, isRot(t) ? null : enabled, isRot(t))}</div>` : ''}
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
function rotConfigCard(t, res) {
  const p = t.rot.p, k = t.rot.pick;
  const held = res?.open?.length ? res.open.map(x => coinName(x.symbol)).join('، ') : 'فعلاً هیچ (نقد)';
  return `<div class="card glass span-2"><h3>تنظیمات این تست <span class="muted">مومنتوم ${faNum(t.rot.uni.length)} ارز</span></h3>
    <div class="tc-cfg"><span>بازه‌ی رشد: <b>${faNum(p.lookH / 24)} روز</b></span><span>تعداد ارز هم‌زمان: <b>${faNum(p.top)}</b></span><span>چرخش: <b>هر ${faNum(p.rebH)} ساعت</b></span><span>حد ضرر متحرک: <b>${faNum(Math.round(p.trail * 100))}٪</b></span><span>فیلتر بیت‌کوین: <b>${p.btcFilter ? 'روشن' : 'خاموش'}</b></span><span>کارمزد: <b>۰.۱٪</b> + لغزش بر اساس حجم</span></div>
    <div class="muted" style="font-size:12.5px;margin-top:8px;line-height:1.9">این تنظیمات از بین ۲۴ ترکیب، روی ۶۰ روز قبل از شروع انتخاب شد (آنجا: ${signed(k.ret, 1)}٪ با بیشترین افت ${nf(k.dd, 1)}٪ و ${faNum(k.n)} معامله). این تست نشان می‌دهد همان تنظیمات روی بازار تازه چه می‌کند.<br>الان در دست: ${esc(held)}</div></div>`;
}
/* the analyst's and the memory's decisions, and what the memory has learned */
const DEC = { taken: 'معامله شد', learned: 'رد به خاطر تجربه', analyst: 'رد به خاطر تحلیل چارت', other: 'رد توسط مدیر ریسک', skipped: 'پوزیشن باز بود یا وقت گذشت', filtered: 'رد توسط فیلترها (حالت بازار، بیت‌کوین، خبر، کارمزد)' };
function decisionRows(res) {
  const d = res.decisions || {};
  return ['taken', 'filtered', 'learned', 'analyst', 'other'].filter(k => d[k]).map(k => {
    const x = d[k], avg = x.sumR / x.n;
    return `<div class="row"><div class="main"><div class="t1">${DEC[k]}</div><div class="t2">${x.n} سیگنال · ${nf(x.wins / x.n * 100, 0)}% به هدف رسید</div></div><div class="end"><div class="t1 num ${cls(avg)}">${signed(avg, 2)}R</div><div class="t2">میانگین بعد از کارمزد</div></div></div>`;
  }).join('');
}
function decisionsCard(res) {
  return `<div class="card glass"><h3>${res.analyst ? 'تصمیم‌های تحلیل‌گر' : 'تصمیم‌های ربات'} <span class="muted">هر سیگنال تا نتیجه دنبال شد</span></h3><div class="list">${decisionRows(res) || '<div class="empty">هنوز سیگنالی به نتیجه نرسیده</div>'}</div>
    <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.9">اگر میانگین سیگنال‌های ردشده از معامله‌های انجام‌شده بدتر باشد، یعنی تحلیل‌گر درست رد کرده است.</p></div>`;
}
function experienceCard(res) {
  const Lm = res.learn;
  const w = Lm.weights, maxW = Math.max(0.05, ...Object.values(w).map(Math.abs));
  const bars = Object.entries(FACTORS).filter(([k]) => k in w).map(([k, name]) => {
    const v = w[k] || 0, width = Math.abs(v) / maxW * 50;
    const side = v >= 0 ? `left:${50 - width}%;right:50%` : `right:${50 - width}%;left:50%`;
    return `<div class="bar-row"><div><b style="font-weight:600">${name}</b></div><div class="bar-track"><span class="mid"></span><div style="${side};background:var(--${v >= 0 ? 'up' : 'down'})"></div></div><div class="num ${cls(v)}" style="font-weight:700;min-width:70px;text-align:left">${signed(v, 2)}R</div></div>`;
  }).join('');
  const status = r => r.est < -0.12 ? '<span class="tag down">کنار گذاشته</span>' : r.est > 0.15 ? '<span class="tag up">تقویت‌شده</span>' : '<span class="tag">عادی</span>';
  const rowHtml = r => `<div class="row"><div class="main"><div class="t1">${STRATEGIES[r.setup]?.name || r.setup} · ${GROUPS[r.group] || r.group}</div><div class="t2">${r.n} درس · ${nf(r.winRate, 0)}% برد</div></div><div class="end"><div class="t1 num ${cls(r.avgR)}">${signed(r.avgR, 2)}R</div><div class="t2">${status(r)}</div></div></div>`;
  const rows = Lm.rows.filter(r => r.n >= 3);
  const best = [...rows].sort((a, b) => b.est - a.est).slice(0, 5), worst = [...rows].sort((a, b) => a.est - b.est).filter(r => r.est < 0).slice(0, 5);
  const curve = Lm.history.length > 2 ? `<svg class="tc-spark" viewBox="0 0 120 34" preserveAspectRatio="none" style="height:46px"><path d="${sparkPath(Lm.history.map(x => x[1]), 120, 34)}" fill="none" stroke="var(--accent)" stroke-width="1.6"/></svg>` : '';
  const d = res.decisions || {}, tk = d.taken, lr = d.learned;
  return `<div class="card glass"><h3>🧠 حافظه‌ی تجربه <span class="muted">ربات از نتیجه‌ی هر سیگنال درس می‌گیرد</span></h3>
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi glass flat"><div class="k">درس‌های یادگرفته</div><div class="v num">${Lm.lessons}</div><div class="s">${Lm.ready ? 'حافظه تصمیم می‌گیرد' : 'هنوز در حال تجربه'}</div></div>
      <div class="kpi glass flat"><div class="k">میانگین همه‌ی تجربه‌ها</div><div class="v num ${cls(Lm.overall)}">${signed(Lm.overall, 2)}R</div><div class="s">بعد از کارمزد</div></div>
      <div class="kpi glass flat"><div class="k">معامله‌های انجام‌شده</div><div class="v num ${cls(tk ? tk.sumR / tk.n : 0)}">${tk ? signed(tk.sumR / tk.n, 2) + 'R' : '—'}</div><div class="s">${tk ? tk.n + ' معامله‌ی به‌نتیجه‌رسیده' : 'هنوز نتیجه‌ای نیست'}</div></div>
      <div class="kpi glass flat"><div class="k">ردشده به خاطر تجربه</div><div class="v num ${cls(lr ? lr.sumR / lr.n : 0)}">${lr ? signed(lr.sumR / lr.n, 2) + 'R' : '—'}</div><div class="s">${lr ? lr.n + ' سیگنال؛ اگر منفی باشد، ردشان درست بود' : 'هنوز چیزی رد نشده'}</div></div>
    </div>
    <div class="grid cols-2">
      <div><div class="grp-h">کدام نشانه‌های چارت واقعاً مهم بودند</div><div class="bars">${bars}</div>
        <p class="muted" style="font-size:11.5px;margin:8px 0 0;line-height:1.8">عدد مثبت یعنی وقتی این نشانه به نفع معامله بود، نتیجه بهتر شد. ربات وزن هر نشانه را از تجربه یاد می‌گیرد.</p></div>
      <div><div class="grp-h">بهترین تجربه‌ها</div><div class="list">${best.map(rowHtml).join('') || '<div class="empty">هنوز کافی نیست</div>'}</div>
        ${worst.length ? `<div class="grp-h">چیزهایی که یاد گرفت انجام ندهد</div><div class="list">${worst.map(rowHtml).join('')}</div>` : ''}</div>
    </div>
    ${Lm.ctx?.length ? `<div class="grp-h">درس‌های زمان و حالت بازار</div><div class="list">${[...Lm.ctx].sort((a, b) => Math.abs(b.est) - Math.abs(a.est)).slice(0, 6).map(c => `<div class="row"><div class="main"><div class="t1">${c.kind === 'regime' ? `${STRATEGIES[c.a]?.name || c.a} در ${REGIME_NAMES[c.b] || c.b}` : `${GROUPS[c.a] || c.a} در ${SESSION_NAMES[c.b] || c.b}`}</div><div class="t2">${c.n} درس · ${nf(c.winRate, 0)}% برد</div></div><div class="end"><div class="t1 num ${cls(c.avgR)}">${signed(c.avgR, 2)}R</div></div></div>`).join('')}</div>` : ''}
    ${curve ? `<div class="grp-h">منحنی یادگیری <span class="muted">میانگین نتیجه‌ی تجربه‌ها در طول زمان</span></div>${curve}` : ''}
    <details class="more"><summary>همه‌ی تصمیم‌ها ▾</summary><div class="list" style="margin-top:8px">${decisionRows(res)}</div></details>
    <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.9">ربات قبل از شروع ۳ روز بازار را تماشا کرد تا با تجربه شروع کند. تجربه‌های تازه وزن بیشتری دارند و ستاپی که کنار گذاشته شده همچنان زیر نظر است تا اگر دوباره خوب شد، برگردد.</p></div>`;
}
/* skill 1: is the result luck? skill 10: what the trades say about the exits */
function validationCard(res, settings) {
  const c = confidence(res.closed, settings.riskPct);
  const kind = { good: 'good', mid: 'mid', bad: 'bad', low: 'mid' }[c.level];
  const b = c.b, mc = c.mc;
  return `<div class="card glass"><h3>اعتبار نتیجه <span class="muted">شانس بود یا مهارت؟</span></h3>
    <div class="verdict ${kind}" style="margin-bottom:12px"><div class="badge">${c.level === 'good' ? '✓' : c.level === 'bad' ? '!' : '?'}</div><div><b>${c.level === 'good' ? 'نتیجه معنادار است' : c.level === 'bad' ? 'ضرر واقعی است، نه بدشانسی' : c.level === 'low' ? 'نمونه کم است' : 'هنوز قطعی نیست'}</b><p>${c.text}</p></div></div>
    ${b ? `<div class="kpis">
      <div class="kpi glass flat"><div class="k">احتمال برتری واقعی</div><div class="v num ${b.pPos >= 0.75 ? 'up' : b.pPos <= 0.25 ? 'down' : ''}">${nf(b.pPos * 100, 0)}%</div><div class="s">میانگین بالای صفر (بوت‌استرپ)</div></div>
      <div class="kpi glass flat"><div class="k">بازه‌ی میانگین هر معامله</div><div class="v num" style="font-size:17px">${signed(b.lo, 2)} تا ${signed(b.hi, 2)}R</div><div class="s">با ۹۰٪ اطمینان</div></div>
      <div class="kpi glass flat"><div class="k">افت بدبینانه</div><div class="v num down">${nf(mc.dd95, 1)}%</div><div class="s">۵٪ ترتیب‌های تصادفی بدتر از این</div></div>
      <div class="kpi glass flat"><div class="k">احتمال ضرر با همین معامله‌ها</div><div class="v num">${nf(mc.pLoss * 100, 0)}%</div><div class="s">در ۱۰۰۰ ترتیب تصادفی (مونت‌کارلو)</div></div>
    </div>` : ''}</div>`;
}
function postTradeCard(res) {
  const T = res.closed;
  const Rs = T.map(x => x.R), n = T.length;
  const wins = T.filter(x => x.R > 0), losses = T.filter(x => x.R <= 0);
  const exp = Rs.reduce((a, x) => a + x, 0) / n;
  const bins = [[-Infinity, -1.5], [-1.5, -0.5], [-0.5, 0], [0, 0.5], [0.5, 1.5], [1.5, Infinity]];
  const lab = ['زیر −۱.۵', '−۱.۵ تا −۰.۵', '−۰.۵ تا ۰', '۰ تا ۰.۵', '۰.۵ تا ۱.۵', 'بالای ۱.۵'];
  const cnt = bins.map(([a, b]) => Rs.filter(r => r > a && r <= b).length), maxC = Math.max(1, ...cnt);
  const hist = cnt.map((c, k) => `<div class="hist-col"><div class="hist-bar" style="height:${c / maxC * 100}%;background:var(--${k < 3 ? 'down' : 'up'})"></div><span class="num">${c}</span><small>${lab[k]}</small></div>`).join('');
  const hasEx = T.some(x => x.mfe != null);
  const tips = [];
  if (hasEx) {
    const saved = losses.filter(x => x.mfe >= 1).length;
    if (losses.length >= 5 && saved / losses.length > 0.25) tips.push(`${nf(saved / losses.length * 100, 0)}٪ باخت‌ها اول دست‌کم ۱R سود دیدند و بعد برگشتند: جابه‌جا کردن حد ضرر به نقطه‌ی ورود یا برداشتن بخشی از سود در ۱R کمک می‌کند.`);
    const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
    const wMae = med(wins.map(x => x.mae));
    if (wins.length >= 5 && wMae < 0.3) tips.push(`برنده‌ها معمولاً کمتر از ${nf(wMae, 2)}R خلاف جهت رفتند: حد ضرر شاید بیش از حد دور است.`);
    if (wins.length >= 5 && wMae > 0.75) tips.push(`برنده‌ها هم تا ${nf(wMae, 2)}R خلاف جهت رفتند: حد ضرر تنگ‌تر خیلی از آن‌ها را از دست می‌داد.`);
  }
  const time = T.filter(x => x.reason === 'time').length;
  if (n >= 10 && time / n > 0.35) tips.push(`${nf(time / n * 100, 0)}٪ معامله‌ها با پایان زمان بسته شدند: هدف دور است یا زمان نگه‌داری کوتاه.`);
  const feeShare = T.reduce((a, x) => a + x.fees, 0) / Math.max(1e-9, T.reduce((a, x) => a + Math.abs(x.gross), 0));
  if (feeShare > 0.3) tips.push(`کارمزد ${nf(feeShare * 100, 0)}٪ اندازه‌ی سود و زیان‌هاست: حد ضررهای بزرگ‌تر (تایم‌فریم بالاتر) یا معامله‌ی کمتر لازم است.`);
  const avgW = wins.length ? wins.reduce((a, x) => a + x.R, 0) / wins.length : 0, avgL = losses.length ? losses.reduce((a, x) => a + x.R, 0) / losses.length : 0;
  return `<div class="card glass"><h3>تحلیل پس از معامله <span class="muted">ژورنال</span></h3>
    <div class="kpis">
      <div class="kpi glass flat"><div class="k">امید ریاضی</div><div class="v num ${cls(exp)}">${signed(exp, 2)}R</div><div class="s">میانگین سود هر معامله بعد از کارمزد</div></div>
      <div class="kpi glass flat"><div class="k">برد / باخت متوسط</div><div class="v num"><span class="up">${signed(avgW, 2)}</span> / <span class="down">${signed(avgL, 2)}</span></div><div class="s">بر حسب R</div></div>
    </div>
    <div class="grp-h">پخش نتیجه‌ها (R)</div><div class="hist">${hist}</div>
    ${tips.length ? `<div class="grp-h">پیشنهادها</div><ul class="tips">${tips.map(x => `<li>${x}</li>`).join('')}</ul>` : `<p class="muted" style="font-size:12px;margin:10px 0 0">${n < 10 ? 'برای پیشنهاد، معامله‌های بیشتری لازم است.' : 'الگوی مشکل‌داری در خروج‌ها دیده نشد.'}</p>`}</div>`;
}
// what the pro desk is doing, in plain words
function proLines(pr) {
  const out = [];
  if (pr.regime) out.push('هر ستاپ فقط در حالت بازار مناسب خودش، با تأیید بیت‌کوین');
  if (pr.risk) out.push(`حداکثر ${faNum(pr.risk.maxCluster)} پوزیشن هم‌جهت در هر گروه، ریسک باز کل ${faNum(pr.risk.maxRiskPct)}٪، ریسک نصف بعد از ${faNum(pr.risk.ddHalf)}٪ افت یا ${faNum(pr.risk.streak)} باخت پشت سر هم، توقف یک‌روزه بعد از ${faNum(pr.risk.ddStop)}٪ افت`);
  if (pr.exits) out.push(`${faNum(pr.exits.partialPct)}٪ سود در ${faNum(pr.exits.partial)}R، حد ضرر به نقطه‌ی ورود، حد ضرر متحرک ${faNum(pr.exits.trail)}×ATR`);
  else out.push('خروج ثابت: حد ضرر و هدف');
  if (pr.costs) out.push('لغزش بر اساس حجم هر ارز و فاندینگ فیوچرز');
  if (pr.shorts) out.push('شورت روی فیوچرز');
  if (pr.deriv) out.push('فاندینگ و Open Interest در تحلیل');
  if (pr.calendar) out.push(`بدون ورود ${faNum(pr.newsMin)} دقیقه دور خبرهای CPI، اشتغال و فدرال رزرو و وقتی بازار اصلی طلا و نفت بسته است`);
  return out;
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

function openDetail(sym) { if (!assetBySymbol[sym]) return; S.page = 'market'; S.detail = sym; history.replaceState(null, '', '#market'); render(); window.scrollTo({ top: 0 }); }

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
      ${res.closed.length ? `<div class="span-2 grid cols-2">${validationCard(res, S.settings)}${postTradeCard(res)}</div>` : ''}
      <div class="span-2">${accuracyCard(res)}</div>
      <div class="span-2 grid cols-2">${breakdown(st)}</div>
      <div class="span-2">${blockedCard(res)}</div>
      <div class="card glass span-2"><h3>آخرین معاملات بک‌تست <span class="muted"><a href="#trades" id="btAll">همه</a></span></h3><div class="list">${res.closed.slice(-10).reverse().map(x => tradeRow(x)).join('') || '<div class="empty">در این بازه معامله‌ای انجام نشد</div>'}</div></div>
    </div>` : '<div class="card glass"><div class="empty">هنوز بک‌تستی اجرا نشده. بازه را انتخاب کنید و «اجرا» را بزنید.</div></div>'}
    <p class="muted" style="font-size:12px;margin:12px 4px">بک‌تست معمولاً از نتیجه‌ی واقعی خوش‌بینانه‌تر است؛ تست زنده‌ی یک‌هفته‌ای ملاک اصلی است.</p>
    <div class="sep"></div>
    ${wfSection()}
  </div>`;
  main.querySelectorAll('[data-days]').forEach(b => b.onclick = () => { B.days = +b.dataset.days; save('btDays', B.days); render(); });
  $('#runBt').onclick = runBacktest;
  $('#wfBtn').onclick = runWalkForward;
  $('#wfSave') && ($('#wfSave').onclick = saveWfProfile);
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
  const pr = S.settings.pro;
  const fetchSyms = pr?.regime && !syms.includes('BTCUSDT') ? [...syms, 'BTCUSDT'] : syms;
  B.error = ''; B.running = `دریافت داده 0/${fetchSyms.length}`; render();
  const data = {}, dv = {}; let done = 0;
  const from = start - warmupFor(S.settings) * BAR_MS;
  await pool(fetchSyms, 4, async s => {
    try { data[s] = await ensureHistory(s, from, end); } catch { /* */ }
    if (pr?.deriv && syms.includes(s)) try { dv[s] = await ensureDeriv(s, from, end); } catch { /* */ }
    done++; B.running = `دریافت داده ${done}/${fetchSyms.length}`;
    const b = $('#runBt'); if (b) b.innerHTML = `<span class="loader"></span> ${B.running}`;
  });
  if (!Object.keys(data).length) { B.running = null; B.error = 'دریافت داده از Binance ممکن نشد. اتصال اینترنت یا VPN را بررسی کنید، یا حالت نمایشی را امتحان کنید.'; S.offline = true; render(); return; }
  B.running = 'اجرای ربات…'; render();
  await new Promise(r => setTimeout(r, 30));
  const res = closeAllAtEnd(runSimulation({ data, settings: S.settings, start, end, deriv: pr?.deriv ? dv : null }), S.settings);
  res.bench = benchmark(res, data);
  res.days = B.days;
  res.targetR = S.settings.targetR;
  res.equity = thin(res.equity, 800);
  res.events = [];
  B.res = res; B.running = null;
  save('bt', res);
  render();
}

/* ---------------- walk-forward validator (skill 1) ---------------- */
const WF = { rep: load('wf', null), running: null, error: '' };
function wfSection() {
  const r = WF.rep;
  const pct = x => `<span class="num ${cls(x)}">${signed(x, 2)}%</span>`;
  const pfv = x => (x === Infinity ? '∞' : nf(x, 2));
  const prow = (name, x) => x ? `<tr><td>${name}</td><td class="num">${x.n}</td><td class="num">${nf(x.win, 0)}%</td><td>${pct(x.pnlPct)}</td><td class="num ${x.pf >= 1 ? 'up' : 'down'}">${pfv(x.pf)}</td><td class="num down">${nf(x.dd, 1)}%</td><td class="num">${x.conf.b ? nf(x.conf.b.pPos * 100, 0) + '%' : '—'}</td></tr>` : '';
  let body = '';
  if (r) {
    const b = r.best, P = r.port;
    const picked = Object.entries(b.gsel).map(([g, l]) => `<b>${GROUPS[g]}</b>: ${l.length ? l.map(k => STRATEGIES[k]?.name || k).join('، ') : 'هیچ (معامله نمی‌شود)'}`).join('<br>');
    const good = P.opt.out.pnlPct > 0 && P.opt.out.pf > 1.1;
    body = `<div class="note ${good ? '' : 'warn'}" style="margin:12px 0">${good
      ? `پروفایل انتخاب‌شده روی ۱۰ روزی که در انتخابش نقشی نداشت سود داد (${signed(P.opt.out.pnlPct, 2)}%). این نشانه‌ی خوبی است، نه تضمین؛ با یک تست زنده‌ی چندروزه هم امتحانش کنید.`
      : `پروفایل انتخاب‌شده روی ۱۰ روز آخر سود نداد (${signed(P.opt.out.pnlPct, 2)}%). یعنی چیزی که در ۲۰ روز اول خوب بود، ادامه پیدا نکرد. این همان بیش‌برازش (overfitting) است که اعتبارسنجی برای پیدا کردنش ساخته شده.`}</div>
      <div class="table-wrap"><table class="wf"><thead><tr><th>روی ۱۰ روز آخر (خارج از نمونه)</th><th>معامله</th><th>برد</th><th>بازده</th><th>فاکتور سود</th><th>افت</th><th>احتمال برتری</th></tr></thead><tbody>
        ${prow('سیستم قبلی', P.now.out)}${prow('میز حرفه‌ای با همه‌ی ستاپ‌ها', P.pro.out)}${prow('پروفایل انتخاب‌شده', P.opt.out)}${prow('همان + تحلیل‌گر و خودآموز', P.optLearn.out)}
      </tbody></table></div>
      <div class="table-wrap" style="margin-top:10px"><table class="wf"><thead><tr><th>روی ۲۰ روز اول (داخل نمونه)</th><th>معامله</th><th>برد</th><th>بازده</th><th>فاکتور سود</th><th>افت</th><th>احتمال برتری</th></tr></thead><tbody>
        ${prow('سیستم قبلی', P.now.in)}${prow('پروفایل انتخاب‌شده', P.opt.in)}
      </tbody></table></div>
      <div class="grp-h">انتخاب: کندل ${faNum(b.tf)} دقیقه‌ای، هدف ${faNum(b.tR)}R، خروج ${b.ek === 'fixed' ? 'ثابت' : 'مدیریت‌شده'}، نگه‌داری تا ${faNum(b.hold)} ساعت</div>
      <div class="muted" style="font-size:12.5px;line-height:2">${picked}</div>
      <details class="more"><summary>همه‌ی ترکیب‌های امتحان‌شده ▾</summary><div class="table-wrap"><table class="wf"><thead><tr><th>کندل</th><th>هدف</th><th>خروج</th><th>سیگنال انتخابی (۲۰ روز)</th><th>میانگین</th><th>همان‌ها در ۱۰ روز آخر</th><th>میانگین</th></tr></thead><tbody>
        ${r.cands.map(c => `<tr class="${c.tf === b.tf && c.tR === b.tR && c.ek === b.ek ? 'sel' : ''}"><td class="num">${c.tf}د</td><td class="num">${c.tR}R</td><td>${c.ek === 'fixed' ? 'ثابت' : 'مدیریت‌شده'}</td><td class="num">${c.nIn}</td><td class="num ${cls(c.inR)}">${signed(c.inR, 3)}R</td><td class="num">${c.nOut}</td><td class="num ${cls(c.outR)}">${signed(c.outR, 3)}R</td></tr>`).join('')}
      </tbody></table></div></details>
      <div class="hero-actions"><button class="btn primary" id="wfSave" ${b.nIn ? '' : 'disabled'}>ذخیره به‌عنوان پروفایل «سودمحور»</button></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">اجرا شده در ${fdt(r.at)} روی ${faNum(r.days)} روز گذشته. همه‌ی اعداد بعد از کارمزد، لغزش و فاندینگ.</p>`;
  }
  return `<div class="card glass"><h3>اعتبارسنجی Walk-forward <span class="muted">مهارت ۱</span></h3>
    <p class="muted" style="margin:4px 0 12px;line-height:1.9">۱۲ ترکیب (کندل ۵، ۱۵ و ۳۰ دقیقه × هدف ۲R و ۳R × خروج ثابت و مدیریت‌شده) روی ۳۰ روز گذشته‌ی Binance امتحان می‌شود. انتخاب فقط با ۲۰ روز اول انجام می‌شود و ستاپ‌هایی نگه داشته می‌شوند که روی هر گروه دارایی سود دادند. بعد نتیجه روی ۱۰ روز آخر، که در انتخاب نقشی نداشت، سنجیده می‌شود. چند دقیقه طول می‌کشد.</p>
    <button class="btn ${r ? '' : 'primary'}" id="wfBtn" ${WF.running ? 'disabled' : ''}>${WF.running ? `<span class="loader"></span> ${WF.running}` : `${I.play} ${r ? 'اجرای دوباره' : 'شروع اعتبارسنجی'}`}</button>
    ${WF.error ? `<div class="note warn" style="margin-top:12px">${WF.error}</div>` : ''}${body}</div>`;
}
async function runWalkForward() {
  if (WF.running) return;
  const end = Math.floor(Date.now() / BAR_MS) * BAR_MS, days = 30;
  const from = end - days * DAY - wfWarmupBars() * BAR_MS;
  const syms = ASSETS.map(a => a.symbol).filter(s => S.settings.symbols[s] && !unavailable.has(s));
  const all = syms.includes('BTCUSDT') ? syms : [...syms, 'BTCUSDT'];
  const upd = msg => { WF.running = msg; const b = $('#wfBtn'); if (b) b.innerHTML = `<span class="loader"></span> ${msg}`; };
  WF.error = ''; upd('دریافت داده'); render();
  const data = {}, dv = {}; let done = 0;
  await pool(all, 4, async s => {
    for (let k = 0; k < 3 && !data[s]; k++) { try { data[s] = await ensureHistory(s, from, end); } catch { await new Promise(r => setTimeout(r, 2000)); } }
    if (syms.includes(s)) try { dv[s] = await ensureDeriv(s, from, end); } catch { /* */ }
    done++; upd(`دریافت داده ${done}/${all.length}`);
  });
  if (Object.keys(data).length < 5) { WF.running = null; WF.error = 'دریافت داده از Binance ممکن نشد.'; render(); return; }
  try {
    const base = { ...deep(S.settings), symbols: Object.fromEntries(ASSETS.map(a => [a.symbol, syms.includes(a.symbol)])) };
    const rep = await walkForward({ data, deriv: dv, base, end, days, onProgress: (k, n, msg) => upd(`${k}/${n} · ${msg}`) });
    WF.rep = rep; save('wf', rep);
  } catch (e) { WF.error = 'اعتبارسنجی کامل نشد: ' + esc(e.message || e); }
  WF.running = null; render();
}
function saveWfProfile() {
  const r = WF.rep; if (!r) return;
  const b = r.best;
  const desc = `از اعتبارسنجی ${fdt(r.at)}: کندل ${faNum(b.tf)} دقیقه‌ای، هدف ${faNum(b.tR)}R، فقط ستاپ‌های سودده هر گروه`;
  save('optProfile', { desc, set: r.set, at: r.at });
  PROFILES.profit.desc = desc; PROFILES.profit.set = deep(r.set);
  toast('پروفایل «سودمحور» به‌روز شد. تست تازه با این پروفایل بسازید.');
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
        ${num('maxCostR', 'سقف کارمزد نسبت به ریسک', 'اگر کارمزد و لغزش بیشتر از این کسر از ریسک معامله باشد، معامله انجام نمی‌شود (۰.۲ یعنی ۲۰٪)', 0.05, 0.05, 2)}
        ${sw('analyst', 'تحلیل‌گر چارت', 'قبل از هر ورود، چارت با چک‌لیست مهارت تحلیل‌گر امتیاز می‌گیرد (پیش‌فرض تست‌های تازه)', st.analyst)}
        ${sw('learn', 'خودآموز (حافظه‌ی تجربه)', 'از نتیجه‌ی هر سیگنال یاد می‌گیرد و تصمیم‌های بعدی را با آن می‌گیرد', st.learn)}
        ${sw('timeMachineFilter', 'فیلتر ماشین زمان', 'قبل از هر ورود ۴۰۰ بار شبیه‌سازی؛ اگر شانس از سربه‌سر کمتر بود رد می‌شود', st.timeMachineFilter)}
        ${num('tmMinEdge', 'حداقل برتری ماشین زمان (واحد درصد)', 'نسبت به نقطه‌ی سربه‌سر', 1, -50, 50)}
      </div>
      <div class="card glass"><h3>میز حرفه‌ای <span class="muted">۱۰ مهارت معامله‌گری، برای تست‌های تازه</span></h3>
        ${sw('on', 'میز حرفه‌ای', 'خاموش = مثل نسخه‌ی قبل', !!st.pro, 'data-pro')}
        ${st.pro ? `<div class="field"><div class="lbl"><b>تایم‌فریم سیگنال</b><span>کندل بزرگ‌تر = حد ضرر بزرگ‌تر و سهم کمتر کارمزد. خروج‌ها همچنان هر ۵ دقیقه بررسی می‌شوند.</span></div><div class="seg">${[5, 15, 30, 60].map(m => `<button data-tf="${m}" class="${st.pro.tf === m ? 'active' : ''}">${faNum(m)}د</button>`).join('')}</div></div>
        ${sw('regime', 'حالت بازار', 'ستاپ‌های روندی فقط در روند، برگشتی فقط در رنج؛ بیت‌کوین رهبر بازار رمزارز', st.pro.regime, 'data-pro')}
        ${sw('risk', 'ریسک پرتفوی', 'سقف پوزیشن هم‌جهت در هر گروه، سقف ریسک باز، ترمز افت سرمایه و نصف کردن ریسک بعد از باخت‌های پشت سر هم', !!st.pro.risk, 'data-pro')}
        ${sw('exits', 'خروج مدیریت‌شده', 'نیمی از سود در ۱R، حد ضرر به نقطه‌ی ورود، حد ضرر متحرک', !!st.pro.exits, 'data-pro')}
        ${sw('costs', 'هزینه‌ی واقعی اجرا', 'لغزش بیشتر برای ارزهای کم‌حجم، فاندینگ برای فیوچرز', st.pro.costs, 'data-pro')}
        ${sw('shorts', 'شورت روی فیوچرز', 'در روند نزولی هم معامله می‌کند (فقط بازار فیوچرز)', st.pro.shorts, 'data-pro')}
        ${sw('deriv', 'داده‌ی فیوچرز', 'نرخ فاندینگ و Open Interest در تحلیل هر سیگنال', st.pro.deriv, 'data-pro')}
        ${sw('calendar', 'تقویم و ساعت', 'بدون ورود نزدیک CPI، اشتغال و فدرال رزرو و وقتی بازار اصلی طلا و نفت بسته است', st.pro.calendar, 'data-pro')}` : ''}
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
  main.querySelectorAll('input[data-pro]').forEach(inp => inp.onchange = () => {
    const k = inp.dataset.pro;
    if (k === 'on') S.settings.pro = inp.checked ? deep(PRO_DEFAULTS) : null;
    else if (k === 'risk' || k === 'exits') S.settings.pro[k] = inp.checked ? deep(PRO_DEFAULTS[k]) : null;
    else S.settings.pro[k] = inp.checked;
    persist(); render(); toast('ذخیره شد');
  });
  main.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { S.settings.pro.tf = +b.dataset.tf; persist(); render(); });
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
