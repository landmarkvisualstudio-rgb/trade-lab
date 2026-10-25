// Market data: Binance public endpoints (spot + USDT-M futures), no key needed.
// Several hosts are tried in turn; the one that works is remembered.
import { assetBySymbol, BAR_MS } from './config.js';
import { idbGet, idbSet } from './store.js';
import { demoKlines, demoTicker, demoPrice } from './demo.js';

// demo = simulated market (see demo.js); set once at startup
export const mode = { demo: false };

const BASES = {
  spot: ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api3.binance.com'],
  futures: ['https://fapi.binance.com'],
};
const PATHS = {
  spot: { klines: '/api/v3/klines', ticker: '/api/v3/ticker/24hr' },
  futures: { klines: '/fapi/v1/klines', ticker: '/fapi/v1/ticker/24hr' },
};
const WS = {
  spot: ['wss://data-stream.binance.vision/stream?streams=', 'wss://stream.binance.com:9443/stream?streams='],
  futures: ['wss://fstream.binance.com/stream?streams='],
};
const working = { spot: 0, futures: 0 };

// one quick check: can this device reach Binance at all?
export async function probe() {
  try { await getJSON('spot', '/api/v3/time', {}); return true; } catch { return false; }
}
export const unavailable = new Set();
export const netState = { ok: true, lastError: '' };

class BadSymbol extends Error {}

async function getJSON(market, path, params) {
  const qs = new URLSearchParams(params).toString();
  const bases = BASES[market];
  let lastErr;
  for (let k = 0; k < bases.length; k++) {
    const b = (working[market] + k) % bases.length;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const res = await fetch(`${bases[b]}${path}?${qs}`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (res.status === 400) { const j = await res.json().catch(() => ({})); throw new BadSymbol(j.msg || 'bad request'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      working[market] = b;
      netState.ok = true;
      return await res.json();
    } catch (e) {
      if (e instanceof BadSymbol) throw e;
      lastErr = e;
    }
  }
  netState.ok = false;
  netState.lastError = String(lastErr?.message || lastErr);
  throw lastErr;
}

const marketOf = s => assetBySymbol[s]?.market || 'spot';

export async function klines(symbol, interval, { startTime, endTime, limit } = {}) {
  if (mode.demo) return demoKlines(symbol, interval, { startTime, endTime, limit: limit || 1000 });
  const m = marketOf(symbol);
  const params = { symbol, interval, limit: limit || (m === 'futures' ? 1500 : 1000) };
  if (startTime != null) params.startTime = startTime;
  if (endTime != null) params.endTime = endTime;
  try {
    const rows = await getJSON(m, PATHS[m].klines, params);
    return rows.map(r => [r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
  } catch (e) {
    if (e instanceof BadSymbol) unavailable.add(symbol);
    throw e;
  }
}

// All closed bars between from and to (paged).
export async function klinesRange(symbol, interval, from, to, barMs) {
  const out = [];
  const m = marketOf(symbol);
  const lim = m === 'futures' ? 1500 : 1000;
  let cur = from;
  for (let guard = 0; guard < 60 && cur < to; guard++) {
    const rows = await klines(symbol, interval, { startTime: cur, endTime: to - 1, limit: lim });
    if (!rows.length) break;
    out.push(...rows);
    const last = rows[rows.length - 1][0];
    if (rows.length < lim) break;
    cur = last + barMs;
  }
  const now = Date.now();
  return out.filter(r => r[0] + barMs <= now); // closed bars only
}

const toSeries = rows => ({ t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]), v: rows.map(r => r[5]) });
const toRows = s => s.t.map((t, i) => [t, s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]]);

// 5-minute history for the bot, cached on the device so only new bars are fetched.
export async function ensureHistory(symbol, from, to) {
  const key = `${mode.demo ? 'demo:' : ''}k5:${symbol}`;
  let rows = (await idbGet(key)) || [];
  const keepFrom = Math.min(from, Date.now() - 40 * 86400000);
  rows = rows.filter(r => r[0] >= keepFrom);
  if (rows.length && rows[0][0] > from + BAR_MS && rows[0][0] - from > 60 * 86400000) rows = [];
  const first = rows.length ? rows[0][0] : Infinity;
  if (first > from + BAR_MS) {
    const head = await klinesRange(symbol, '5m', from, rows.length ? first : to, BAR_MS);
    rows = mergeRows(head, rows);
  }
  const last = rows.length ? rows[rows.length - 1][0] : from - BAR_MS;
  if (last + 2 * BAR_MS <= to) {
    const tail = await klinesRange(symbol, '5m', last + BAR_MS, to, BAR_MS);
    rows = mergeRows(rows, tail);
  }
  await idbSet(key, rows);
  return toSeries(rows.filter(r => r[0] >= from && r[0] < to));
}

function mergeRows(a, b) {
  const m = new Map();
  for (const r of a) m.set(r[0], r);
  for (const r of b) m.set(r[0], r);
  return [...m.values()].sort((x, y) => x[0] - y[0]);
}

// Run tasks with limited concurrency.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let k = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) { const i = k++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = e; } }
  });
  await Promise.all(workers);
  return out;
}

export async function tickers(symbols) {
  const out = {};
  if (mode.demo) { for (const s of symbols) out[s] = demoTicker(s); return out; }
  const spot = symbols.filter(s => marketOf(s) === 'spot' && !unavailable.has(s));
  const fut = symbols.filter(s => marketOf(s) === 'futures' && !unavailable.has(s));
  const put = r => { out[r.symbol] = { last: +r.lastPrice, changePct: +r.priceChangePercent, high: +r.highPrice, low: +r.lowPrice, quoteVol: +r.quoteVolume, open: +r.openPrice }; };
  const jobs = [];
  if (spot.length) jobs.push(getJSON('spot', PATHS.spot.ticker, { symbols: JSON.stringify(spot) }).then(a => a.forEach(put)).catch(async e => {
    // one bad symbol fails the whole call: fall back to one by one
    await pool(spot, 4, async s => { try { put(await getJSON('spot', PATHS.spot.ticker, { symbol: s })); } catch (er) { if (er instanceof BadSymbol) unavailable.add(s); } });
  }));
  if (fut.length) jobs.push(getJSON('futures', PATHS.futures.ticker, {}).then(a => {
    const want = new Set(fut);
    a.forEach(r => want.has(r.symbol) && put(r));
    fut.forEach(s => { if (!out[s]) unavailable.add(s); });
  }).catch(() => {}));
  await Promise.all(jobs);
  return out;
}

// Live prices: websocket mini-tickers, with a polling fallback.
export function liveStream(symbols, onTick) {
  if (mode.demo) {
    const tick = () => { for (const s of symbols) { const t = demoTicker(s); onTick(s, demoPrice(s), t); } };
    tick(); const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }
  const sockets = [];
  let stopped = false, pollTimer = null;
  const byMarket = { spot: [], futures: [] };
  symbols.forEach(s => byMarket[marketOf(s)].push(s));
  const startPoll = () => {
    if (pollTimer || stopped) return;
    pollTimer = setInterval(async () => {
      try { const t = await tickers(symbols); for (const [s, v] of Object.entries(t)) onTick(s, v.last, v); } catch { /* offline */ }
    }, 10000);
  };
  for (const m of ['spot', 'futures']) {
    const list = byMarket[m];
    if (!list.length) continue;
    let attempt = 0;
    const connect = () => {
      if (stopped) return;
      const url = WS[m][attempt % WS[m].length] + list.map(s => `${s.toLowerCase()}@miniTicker`).join('/');
      let ws;
      try { ws = new WebSocket(url); } catch { startPoll(); return; }
      sockets.push(ws);
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onmessage = ev => {
        try {
          const d = JSON.parse(ev.data).data;
          const last = +d.c, open = +d.o;
          onTick(d.s, last, { last, open, changePct: (last / open - 1) * 100, high: +d.h, low: +d.l, quoteVol: +d.q });
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (stopped) return;
        attempt++;
        if (!opened && attempt >= WS[m].length) startPoll();
        setTimeout(connect, Math.min(30000, 2000 * attempt));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    };
    connect();
  }
  return () => { stopped = true; sockets.forEach(w => { try { w.close(); } catch { /* */ } }); clearInterval(pollTimer); };
}

export { toSeries, toRows };
