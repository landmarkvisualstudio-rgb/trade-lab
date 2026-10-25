// The setups from trader-scanner / trader-entry, on closed 5-minute bars.
// dir = 1 for a long, -1 for a short (shorts are the mirror image, off by default).
import { sma, rsi, atr, priorMax, priorMin } from './indicators.js';
import { SESSIONS_UTC_MIN, BAR_MS } from './config.js';

const DAY = 86400000;

export function prepare(series) {
  const { t, o, h, l, c, v } = series;
  const idx = new Map();
  for (let i = 0; i < t.length; i++) idx.set(t[i], i);
  return {
    ...series, idx,
    sma20: sma(c, 20), sma50: sma(c, 50), rsi14: rsi(c, 14), atr14: atr(h, l, c, 14),
    volAvg: sma(v, 20), hiC20: priorMax(c, 20), loC20: priorMin(c, 20),
  };
}

function minOf(a, from, to) { let m = Infinity; for (let j = from; j <= to; j++) if (a[j] < m) m = a[j]; return m; }
function maxOf(a, from, to) { let m = -Infinity; for (let j = from; j <= to; j++) if (a[j] > m) m = a[j]; return m; }

// trader-entry: opening-range breakout, one per session per direction.
function orb(p, i, dir, state) {
  const ti = p.t[i];
  const day0 = Math.floor(ti / DAY) * DAY;
  let s = null;
  for (let k = SESSIONS_UTC_MIN.length - 1; k >= 0; k--) {
    const start = day0 + SESSIONS_UTC_MIN[k].min * 60000;
    if (ti >= start) { s = { ...SESSIONS_UTC_MIN[k], start }; break; }
  }
  if (!s) return null;
  const rangeEnd = s.start + 3 * BAR_MS;           // 15-minute range: 3 bars
  if (ti < rangeEnd || ti >= rangeEnd + 2 * 3600000) return null; // 2-hour window
  const key = `${s.start}:${dir}`;
  if (state.orbDone.has(key)) return null;
  const ids = [0, 1, 2].map(k => p.idx.get(s.start + k * BAR_MS));
  if (ids.some(x => x === undefined)) return null;  // a missing bar: no range
  const rh = Math.max(...ids.map(x => p.h[x])), rl = Math.min(...ids.map(x => p.l[x]));
  const broke = dir > 0 ? p.c[i] > rh : p.c[i] < rl;
  if (!broke) return null;
  state.orbDone.add(key);                            // first close beyond the range only
  return { setup: 'orb', dir, stop: (rh + rl) / 2, note: `سشن ${s.name}، محدوده ${fmt(rl)} تا ${fmt(rh)}` };
}

// trader-scanner breakout_20d, on bars: a fresh close beyond the last 20 closes with volume.
function breakout(p, i, dir) {
  if (i < 22 || isNaN(p.atr14[i]) || isNaN(p.volAvg[i - 1])) return null;
  const lvl = dir > 0 ? p.hiC20[i] : p.loC20[i];
  const prevLvl = dir > 0 ? p.hiC20[i - 1] : p.loC20[i - 1];
  const fresh = dir > 0 ? p.c[i] > lvl && p.c[i - 1] <= prevLvl : p.c[i] < lvl && p.c[i - 1] >= prevLvl;
  if (!fresh || p.v[i] < 1.2 * p.volAvg[i - 1]) return null;
  return { setup: 'breakout', dir, stop: p.c[i] - dir * 1.5 * p.atr14[i], note: `سطح ۲۰ کندل ${fmt(lvl)}` };
}

// trader-scanner bull_flag, scaled to each asset's own volatility (ATR).
function flag(p, i, dir) {
  if (i < 20 || isNaN(p.atr14[i])) return null;
  const a = p.atr14[i];
  const pole = (p.c[i - 6] - p.c[i - 16]) * dir;
  if (pole < 4 * a) return null;
  const fr = maxOf(p.c, i - 6, i - 1) - minOf(p.c, i - 6, i - 1);
  if (fr > 1.5 * a) return null;
  if (dir > 0) {
    const top = maxOf(p.h, i - 6, i - 1);
    if (p.c[i] <= top) return null;
    return { setup: 'flag', dir, stop: minOf(p.l, i - 6, i - 1), note: `سقف پرچم ${fmt(top)}` };
  }
  const bot = minOf(p.l, i - 6, i - 1);
  if (p.c[i] >= bot) return null;
  return { setup: 'flag', dir, stop: maxOf(p.h, i - 6, i - 1), note: `کف پرچم ${fmt(bot)}` };
}

// trader-scanner reclaim_ma20, with the 50-bar average pointing the same way.
function reclaim(p, i, dir) {
  if (i < 60 || isNaN(p.sma50[i - 6])) return null;
  const crossed = dir > 0 ? p.c[i - 1] < p.sma20[i - 1] && p.c[i] > p.sma20[i]
                          : p.c[i - 1] > p.sma20[i - 1] && p.c[i] < p.sma20[i];
  const trend = (p.sma50[i] - p.sma50[i - 6]) * dir > 0;
  if (!crossed || !trend) return null;
  const stop = dir > 0 ? minOf(p.l, i - 3, i) - 0.2 * p.atr14[i] : maxOf(p.h, i - 3, i) + 0.2 * p.atr14[i];
  return { setup: 'reclaim', dir, stop, note: `میانگین ۲۰: ${fmt(p.sma20[i])}` };
}

// trader-scanner oversold_bounce (overbought drop for a short).
function bounce(p, i, dir) {
  if (i < 20 || isNaN(p.rsi14[i - 1])) return null;
  const ok = dir > 0 ? p.rsi14[i - 1] < 30 && p.c[i] > p.c[i - 1] && p.c[i] > p.o[i]
                     : p.rsi14[i - 1] > 70 && p.c[i] < p.c[i - 1] && p.c[i] < p.o[i];
  if (!ok) return null;
  const stop = dir > 0 ? minOf(p.l, i - 5, i) - 0.2 * p.atr14[i] : maxOf(p.h, i - 5, i) + 0.2 * p.atr14[i];
  return { setup: 'bounce', dir, stop, note: `RSI قبلی ${p.rsi14[i - 1].toFixed(1)}` };
}

const FNS = { orb, breakout, flag, reclaim, bounce };

// Every bar is scanned (so one-per-session state stays right); the first enabled hit wins.
export function scan(p, i, settings, state) {
  const dirs = settings.allowShort ? [1, -1] : [1];
  let hit = null;
  for (const key of Object.keys(FNS)) {
    for (const d of dirs) {
      const s = FNS[key](p, i, d, state);
      if (s && settings.strategies[key] && !hit) hit = s;
    }
  }
  return hit;
}

export function newScanState() { return { orbDone: new Set() }; }

function fmt(x) { return smartRound(x).toString(); }
export function smartRound(x) {
  if (!isFinite(x)) return x;
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return Number(x.toFixed(d));
}
