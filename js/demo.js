// Demo market: simulated candles for when Binance can't be reached (for example
// inside the claude.ai page, which blocks outside connections). Deterministic:
// the same bar always has the same prices, so a live demo test stays consistent
// across reloads. It is NOT real market data and the app labels it everywhere.
import { assetBySymbol } from './config.js';

const DAY = 86400000, B5 = 300000;
const BASE = { BTCUSDT: 68000, ETHUSDT: 3400, SOLUSDT: 165, BNBUSDT: 590, XRPUSDT: 0.55, DOGEUSDT: 0.14, ADAUSDT: 0.42, AVAXUSDT: 28, LINKUSDT: 14, TONUSDT: 5.2, PAXGUSDT: 2650, XAUUSDT: 2640, XAGUSDT: 31, COPPERUSDT: 4.4, CLUSDT: 71, BZUSDT: 75, NATGASUSDT: 2.9 };
const VOL = { BTCUSDT: .0021, ETHUSDT: .0027, SOLUSDT: .0038, BNBUSDT: .0022, XRPUSDT: .0034, DOGEUSDT: .0042, ADAUSDT: .0036, AVAXUSDT: .0040, LINKUSDT: .0036, TONUSDT: .0030, PAXGUSDT: .0009, XAUUSDT: .0008, XAGUSDT: .0015, COPPERUSDT: .0012, CLUSDT: .0017, BZUSDT: .0016, NATGASUSDT: .0030 };
const QV = { BTCUSDT: 2.1e9, ETHUSDT: 1.1e9, SOLUSDT: 4.2e8, BNBUSDT: 1.6e8, XRPUSDT: 2.8e8, DOGEUSDT: 2.2e8, ADAUSDT: 9e7, AVAXUSDT: 7e7, LINKUSDT: 6e7, TONUSDT: 4e7, PAXGUSDT: 3e7, XAUUSDT: 1.9e8, XAGUSDT: 6e7, COPPERUSDT: 2e7, CLUSDT: 9e7, BZUSDT: 5e7, NATGASUSDT: 3e7 };

function hash(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519);
  }
  h ^= h >>> 13; h = Math.imul(h, 3266489917); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const symSeed = s => Math.floor(hash(s) * 1e6);

// the open of each day follows slow waves, so days connect smoothly
function dayOpen(sym, d) {
  const k = symSeed(sym) / 1e6 * 6.283;
  const v = VOL[sym] || .003;
  const swing = v * 40;
  return (BASE[sym] || 10) * Math.exp(swing * (0.9 * Math.sin(d / 9.3 + k) + 0.6 * Math.sin(d / 3.1 + 2 * k) + 0.35 * Math.sin(d / 1.37 + 3 * k)));
}

const dayCache = new Map();
// 288 five-minute bars for one UTC day: a random walk bridged to the next day's open
function dayBars(sym, d) {
  const key = sym + ':' + d;
  if (dayCache.has(key)) return dayCache.get(key);
  const v = VOL[sym] || .003;
  const o0 = dayOpen(sym, d), o1 = dayOpen(sym, d + 1);
  const steps = new Float64Array(288);
  let regime = 0;
  for (let i = 0; i < 288; i++) {
    if (i % 36 === 0) regime = (hash(sym, d, 'r', i) - 0.5) * 0.9;
    const u = hash(sym, d, i), w = hash(sym, d, 'b', i);
    const n = Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(6.283 * w); // normal
    const burst = hash(sym, d, 'j', i) > 0.985 ? 3 : 1;                  // occasional fast move
    steps[i] = v * (n * burst + regime * 0.35);
  }
  let total = 0; for (const s of steps) total += s;
  const fix = (Math.log(o1 / o0) - total) / 288;
  const rows = [];
  let p = o0;
  const t0 = d * DAY;
  for (let i = 0; i < 288; i++) {
    const o = p, c = o * Math.exp(steps[i] + fix);
    const wig = v * 0.8;
    const h = Math.max(o, c) * (1 + hash(sym, d, 'h', i) * wig);
    const l = Math.min(o, c) * (1 - hash(sym, d, 'l', i) * wig);
    const vol = (QV[sym] || 5e7) / 288 / ((o + c) / 2) * (0.4 + hash(sym, d, 'v', i) * 1.2) * (1 + Math.abs(steps[i]) / v * 0.5);
    rows.push([t0 + i * B5, o, h, l, c, vol]);
    p = c;
  }
  if (dayCache.size > 400) dayCache.delete(dayCache.keys().next().value);
  dayCache.set(key, rows);
  return rows;
}

function bars5(sym, from, to) {
  const out = [];
  for (let d = Math.floor(from / DAY); d * DAY < to; d++) for (const r of dayBars(sym, d)) if (r[0] >= from && r[0] < to) out.push(r);
  return out;
}

const IV = { '1m': 60000, '5m': B5, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': DAY };

// the bar that is still forming, up to now
function partial(sym, ms, now) {
  const start = Math.floor(now / ms) * ms;
  const rows = bars5(sym, start, now - (now % B5));
  const cur = Math.floor(now / B5) * B5;
  const full = dayBars(sym, Math.floor(cur / DAY)).find(r => r[0] === cur);
  if (full) {
    const f = (now - cur) / B5;
    const c = full[1] + (full[4] - full[1]) * f + full[1] * (VOL[sym] || .003) * 0.3 * Math.sin(now / 7000 + symSeed(sym));
    rows.push([cur, full[1], Math.max(full[1], c), Math.min(full[1], c), c, full[5] * f]);
  }
  return rows.length ? agg(rows, start) : null;
}
function agg(rows, t) {
  let h = -Infinity, l = Infinity, v = 0;
  for (const r of rows) { if (r[2] > h) h = r[2]; if (r[3] < l) l = r[3]; v += r[5]; }
  return [t, rows[0][1], h, l, rows[rows.length - 1][4], v];
}

export function demoKlines(symbol, interval, { startTime, endTime, limit = 500 } = {}) {
  if (!assetBySymbol[symbol]) throw new Error('unknown symbol');
  const ms = IV[interval] || B5;
  const now = Date.now();
  const lastOpen = Math.floor(now / ms) * ms;
  let to = endTime != null ? Math.min(endTime + 1, now) : now;
  let from = startTime != null ? Math.floor(startTime / ms) * ms : Math.floor(to / ms) * ms - (limit - 1) * ms;
  const out = [];
  for (let t = from; t < to && out.length < limit; t += ms) {
    if (t >= lastOpen) { const p = partial(symbol, ms, now); if (p) out.push(p); break; }
    if (ms === 60000) { // split a 5-minute bar into five
      const b = dayBars(symbol, Math.floor(t / DAY)).find(r => r[0] === Math.floor(t / B5) * B5);
      const k = (t % B5) / 60000, a = b[1] + (b[4] - b[1]) * k / 5, z = b[1] + (b[4] - b[1]) * (k + 1) / 5;
      const n = (VOL[symbol] || .003) * 0.25 * b[1];
      const o = a + (hash(symbol, t, 'o') - .5) * n, c = z + (hash(symbol, t, 'c') - .5) * n;
      out.push([t, o, Math.max(o, c) + hash(symbol, t, 'h') * n, Math.min(o, c) - hash(symbol, t, 'l') * n, c, b[5] / 5]);
    } else if (ms === B5) {
      out.push(dayBars(symbol, Math.floor(t / DAY)).find(r => r[0] === t));
    } else {
      out.push(agg(bars5(symbol, t, t + ms), t));
    }
  }
  return out.map(r => [...r]);
}

export function demoPrice(symbol, now = Date.now()) {
  const p = partial(symbol, B5, now);
  return p ? p[4] : dayOpen(symbol, Math.floor(now / DAY));
}

export function demoTicker(symbol) {
  const now = Date.now();
  const rows = bars5(symbol, now - DAY, now);
  const last = demoPrice(symbol, now);
  const open = rows.length ? rows[0][1] : last;
  let hi = last, lo = last;
  for (const r of rows) { if (r[2] > hi) hi = r[2]; if (r[3] < lo) lo = r[3]; }
  return { last, open, changePct: (last / open - 1) * 100, high: hi, low: lo, quoteVol: QV[symbol] || 5e7 };
}
