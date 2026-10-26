// The setups. The first five come from the trader-scanner / trader-entry skills;
// the rest come from the chart-analyst skill (classic published rules, adapted to
// closed 5-minute bars). dir = 1 for a long, -1 for a short.
// Nothing here looks ahead: a bar only uses data up to its own close, and swing
// points only count once they are confirmed k bars later.
import { sma, ema, rsi, atr, priorMax, priorMin, stdev, macd, supertrend, vwapDaily, pivots } from './indicators.js';
import { SESSIONS_UTC_MIN, BAR_MS } from './config.js';

const DAY = 86400000;
const cache = new WeakMap();

export function prepare(series) {
  if (cache.has(series)) return cache.get(series);
  const { t, o, h, l, c, v } = series;
  // 5-minute bars unless the series was resampled to a higher timeframe (see resample)
  const barMs = series.barMs || BAR_MS, htfMs = series.htfMs || 3600000;
  const idx = new Map();
  for (let i = 0; i < t.length; i++) idx.set(t[i], i);
  const sma20 = sma(c, 20), sd20 = stdev(c, 20);
  const bbU = sma20.map((m, i) => m + 2 * sd20[i]), bbL = sma20.map((m, i) => m - 2 * sd20[i]);
  const bw = sma20.map((m, i) => (4 * sd20[i]) / m);
  const piv = pivots(h, l, 3);
  const lowIdx = [], highIdx = [];
  piv.lo.forEach((x, i) => x && lowIdx.push(i));
  piv.hi.forEach((x, i) => x && highIdx.push(i));
  const p = {
    ...series, idx,
    sma20, sma50: sma(c, 50), rsi14: rsi(c, 14), atr14: atr(h, l, c, 14),
    volAvg: sma(v, 20), hiC20: priorMax(c, 20), loC20: priorMin(c, 20),
    ema9: ema(c, 9), ema21: ema(c, 21), ema200: ema(c, 200),
    macd: macd(c), st: supertrend(h, l, c, 10, 3), vw: vwapDaily(t, h, l, c, v),
    bbU, bbL, bw, hiH55: priorMax(h, 55), loL55: priorMin(l, 55),
    lowIdx, highIdx, pk: piv.k,
    // for the analyst: hourly trend, trend efficiency, room to the 100-bar extremes
    ...hourlyEma(t, c, 20, barMs, htfMs), er20: effRatio(c, 20), hiH100: priorMax(h, 100), loL100: priorMin(l, 100),
    barMs,
  };
  cache.set(series, p);
  return p;
}

// EMA of hourly closes (built from the 5-minute bars), known only once the hour closed
function hourlyEma(t, c, n, barMs = BAR_MS, htfMs = 3600000) {
  const htf = new Array(c.length).fill(NaN), htfSlope = new Array(c.length).fill(NaN);
  const k = 2 / (n + 1), hist = [];
  let e = NaN, cnt = 0, sum = 0;
  for (let i = 0; i < c.length; i++) {
    if ((t[i] + barMs) % htfMs === 0) {
      cnt++;
      if (cnt <= n) { sum += c[i]; if (cnt === n) e = sum / n; } else e = c[i] * k + e * (1 - k);
      if (!isNaN(e)) hist.push(e);
    }
    htf[i] = e;
    htfSlope[i] = hist.length > 3 ? e - hist[hist.length - 4] : NaN;
  }
  return { htf, htfSlope };
}
// Kaufman efficiency ratio: 1 = straight trend, 0 = pure chop
function effRatio(c, n) {
  const out = new Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) {
    let path = 0; for (let j = i - n + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
    out[i] = path > 0 ? Math.abs(c[i] - c[i - n]) / path : 0;
  }
  return out;
}

function minOf(a, from, to) { let m = Infinity; for (let j = Math.max(0, from); j <= to; j++) if (a[j] < m) m = a[j]; return m; }
function maxOf(a, from, to) { let m = -Infinity; for (let j = Math.max(0, from); j <= to; j++) if (a[j] > m) m = a[j]; return m; }
// confirmed pivots up to bar i (a pivot at j is known at j + k)
export function lastPivots(arr, i, k, n) {
  let lo = 0, hi = arr.length - 1, pos = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= i - k) { pos = m; lo = m + 1; } else hi = m - 1; }
  return pos < 0 ? [] : arr.slice(Math.max(0, pos - n + 1), pos + 1);
}
// the first half hour of the UTC day (the daily VWAP is still settling)
const earlyInDay = (p, i) => p.t[i] % DAY < 30 * 60000;

// Higher timeframe bars built from 5-minute bars (skill 5). A bar is kept only once
// its last 5-minute bar exists, so an unfinished bar is never traded on. htfMs is
// the timeframe the analyst uses as "the trend above".
const rsCache = new WeakMap();
export function resample(s, tfMs, htfMs) {
  let m = rsCache.get(s);
  if (!m) { m = new Map(); rsCache.set(s, m); }
  const key = tfMs + ':' + htfMs;
  if (m.has(key)) return m.get(key);
  const out = { t: [], o: [], h: [], l: [], c: [], v: [], barMs: tfMs, htfMs };
  let cur = null;
  const flush = () => { if (cur && cur.last === cur.T + tfMs - BAR_MS) { out.t.push(cur.T); out.o.push(cur.o); out.h.push(cur.h); out.l.push(cur.l); out.c.push(cur.c); out.v.push(cur.v); } };
  for (let i = 0; i < s.t.length; i++) {
    const T = Math.floor(s.t[i] / tfMs) * tfMs;
    if (!cur || cur.T !== T) { flush(); cur = { T, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i], last: s.t[i] }; }
    else { cur.h = Math.max(cur.h, s.h[i]); cur.l = Math.min(cur.l, s.l[i]); cur.c = s.c[i]; cur.v += s.v[i]; cur.last = s.t[i]; }
  }
  flush();
  m.set(key, out);
  return out;
}

/* ---------- from the trader skills ---------- */

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
  // the opening range is the first 15 minutes (one bar on a higher timeframe)
  const bm = p.barMs || BAR_MS, nb = Math.max(1, Math.round(15 * 60000 / bm));
  const rangeEnd = s.start + nb * bm;
  if (ti < rangeEnd || ti >= rangeEnd + 2 * 3600000) return null;
  const key = `${s.start}:${dir}`;
  if (state.orbDone.has(key)) return null;
  const ids = Array.from({ length: nb }, (_, k) => p.idx.get(s.start + k * bm));
  if (ids.some(x => x === undefined)) return null;
  const rh = Math.max(...ids.map(x => p.h[x])), rl = Math.min(...ids.map(x => p.l[x]));
  const broke = dir > 0 ? p.c[i] > rh : p.c[i] < rl;
  if (!broke) return null;
  state.orbDone.add(key);
  return { setup: 'orb', dir, stop: (rh + rl) / 2, note: `سشن ${s.name}، محدوده ${fmt(rl)} تا ${fmt(rh)}` };
}

// trader-scanner breakout_20d on bars: a fresh close beyond the last 20 closes with volume.
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

/* ---------- from the chart-analyst skill ---------- */

// Trend: EMA 9/21 cross in the direction of the EMA 200.
function emaCross(p, i, dir) {
  if (i < 205 || isNaN(p.ema200[i])) return null;
  const cross = dir > 0 ? p.ema9[i - 1] <= p.ema21[i - 1] && p.ema9[i] > p.ema21[i]
                        : p.ema9[i - 1] >= p.ema21[i - 1] && p.ema9[i] < p.ema21[i];
  if (!cross || (p.c[i] - p.ema200[i]) * dir <= 0) return null;
  const stop = dir > 0 ? minOf(p.l, i - 6, i) - 0.2 * p.atr14[i] : maxOf(p.h, i - 6, i) + 0.2 * p.atr14[i];
  return { setup: 'ema_cross', dir, stop, note: `EMA9 ${fmt(p.ema9[i])} / EMA21 ${fmt(p.ema21[i])}` };
}

// Trend: Supertrend (ATR 10 × 3) flips, RSI 50-70 (30-50 for a short).
function superTrend(p, i, dir) {
  if (i < 30 || !p.st.dir[i - 1]) return null;
  const flip = p.st.dir[i - 1] === -dir && p.st.dir[i] === dir;
  const r = p.rsi14[i];
  const rsiOk = dir > 0 ? r > 50 && r < 70 : r < 50 && r > 30;
  if (!flip || !rsiOk) return null;
  return { setup: 'supertrend', dir, stop: p.st.line[i] - dir * 0.1 * p.atr14[i], note: `خط سوپرترند ${fmt(p.st.line[i])}` };
}

// Momentum: MACD crosses its signal on the far side of zero, with the EMA 200 trend.
function macdCross(p, i, dir) {
  if (i < 205 || isNaN(p.macd.signal[i - 1]) || isNaN(p.ema200[i])) return null;
  const m = p.macd;
  const cross = dir > 0 ? m.line[i - 1] <= m.signal[i - 1] && m.line[i] > m.signal[i] && m.line[i] < 0
                        : m.line[i - 1] >= m.signal[i - 1] && m.line[i] < m.signal[i] && m.line[i] > 0;
  if (!cross || (p.c[i] - p.ema200[i]) * dir <= 0) return null;
  const piv = lastPivots(dir > 0 ? p.lowIdx : p.highIdx, i, p.pk, 1)[0];
  const swing = piv !== undefined && i - piv < 40 ? (dir > 0 ? p.l[piv] : p.h[piv]) : (dir > 0 ? minOf(p.l, i - 10, i) : maxOf(p.h, i - 10, i));
  return { setup: 'macd', dir, stop: swing - dir * 0.1 * p.atr14[i], note: `MACD ${p.macd.line[i].toPrecision(3)}` };
}

// Volatility: Bollinger squeeze. Band width was at its lowest in 120 bars within the
// last 10 bars, then a close outside the band.
function bbSqueeze(p, i, dir) {
  if (i < 150 || isNaN(p.bw[i - 130])) return null;
  const recent = minOf(p.bw, i - 10, i - 1), before = minOf(p.bw, i - 130, i - 11);
  if (!(recent <= before)) return null;
  const out = dir > 0 ? p.c[i] > p.bbU[i] && p.c[i - 1] <= p.bbU[i - 1] : p.c[i] < p.bbL[i] && p.c[i - 1] >= p.bbL[i - 1];
  if (!out) return null;
  return { setup: 'bb_squeeze', dir, stop: p.sma20[i], note: `پهنای باند ${(p.bw[i] * 100).toFixed(2)}٪` };
}

// Intraday: VWAP reclaim. Below VWAP for 15 minutes, then a strong close above it
// on volume, with at least half the body above VWAP.
function vwapReclaim(p, i, dir) {
  if (dir < 0 || i < 30 || earlyInDay(p, i)) return null;
  const vw = p.vw.vwap;
  if (!(p.c[i - 3] < vw[i - 3] && p.c[i - 2] < vw[i - 2] && p.c[i - 1] < vw[i - 1])) return null;
  const body = p.c[i] - p.o[i];
  if (!(p.c[i] > vw[i] && body > 0 && (p.c[i] - vw[i]) / body >= 0.5 && p.v[i] > p.volAvg[i - 1])) return null;
  return { setup: 'vwap_reclaim', dir, stop: Math.min(p.l[i], vw[i] * (1 - 0.0015)), note: `VWAP ${fmt(vw[i])}` };
}

// Mean reversion: a reversal candle at the VWAP −2σ band (+2σ for a short).
function vwapDev(p, i, dir) {
  if (i < 30 || earlyInDay(p, i) || !(p.vw.sd[i] > 0)) return null;
  const band = p.vw.vwap[i] - dir * 2 * p.vw.sd[i];
  const o = p.o[i], c = p.c[i], h = p.h[i], l = p.l[i], body = Math.abs(c - o), range = h - l || 1e-12;
  if (dir > 0) {
    if (l > band) return null;
    const hammer = (Math.min(o, c) - l) >= 2 * body && (c - l) / range >= 0.5;
    const engulf = c > o && p.c[i - 1] < p.o[i - 1] && c >= p.o[i - 1] && o <= p.c[i - 1];
    if (!hammer && !engulf) return null;
    return { setup: 'vwap_dev', dir, stop: l * (1 - 0.0015), note: `باند ۲σ زیر VWAP: ${fmt(band)}` };
  }
  if (h < band) return null;
  const star = (h - Math.max(o, c)) >= 2 * body && (h - c) / range >= 0.5;
  const engulf = c < o && p.c[i - 1] > p.o[i - 1] && c <= p.o[i - 1] && o >= p.c[i - 1];
  if (!star && !engulf) return null;
  return { setup: 'vwap_dev', dir, stop: h * (1 + 0.0015), note: `باند ۲σ بالای VWAP: ${fmt(band)}` };
}

// Reversal: regular RSI divergence on two confirmed swing lows, triggered by a close
// above the high since the second low (mirror for a short).
function rsiDiv(p, i, dir) {
  if (i < 40) return null;
  const arr = dir > 0 ? p.lowIdx : p.highIdx;
  const [j1, j2] = lastPivots(arr, i, p.pk, 2);
  if (j1 === undefined || j2 === undefined || j2 - j1 < 5 || j2 - j1 > 60 || i - j2 > 20) return null;
  const price = dir > 0 ? p.l : p.h;
  const priceOk = dir > 0 ? price[j2] < price[j1] : price[j2] > price[j1];
  const rsiOk = dir > 0 ? p.rsi14[j2] > p.rsi14[j1] && p.rsi14[j2] < 45 : p.rsi14[j2] < p.rsi14[j1] && p.rsi14[j2] > 55;
  if (!priceOk || !rsiOk) return null;
  const trig = dir > 0 ? maxOf(p.h, j2, i - 1) : minOf(p.l, j2, i - 1);
  const fired = dir > 0 ? p.c[i] > trig && p.c[i - 1] <= trig : p.c[i] < trig && p.c[i - 1] >= trig;
  if (!fired) return null;
  return { setup: 'rsi_div', dir, stop: price[j2] - dir * 0.1 * p.atr14[i], note: `RSI ${p.rsi14[j1].toFixed(0)} → ${p.rsi14[j2].toFixed(0)}` };
}

// Price action: engulfing candle after a decline (rally for a short), with volume.
function engulfing(p, i, dir) {
  if (i < 30) return null;
  const o = p.o, c = p.c;
  const prior = dir > 0 ? c[i - 1] < p.sma20[i - 1] && c[i - 1] < c[i - 6] : c[i - 1] > p.sma20[i - 1] && c[i - 1] > c[i - 6];
  if (!prior) return null;
  const ok = dir > 0 ? c[i - 1] < o[i - 1] && c[i] > o[i] && o[i] <= c[i - 1] && c[i] >= o[i - 1]
                     : c[i - 1] > o[i - 1] && c[i] < o[i] && o[i] >= c[i - 1] && c[i] <= o[i - 1];
  if (!ok || Math.abs(c[i] - o[i]) <= Math.abs(c[i - 1] - o[i - 1]) || p.v[i] <= p.v[i - 1]) return null;
  const stop = dir > 0 ? Math.min(p.l[i - 1], p.l[i]) : Math.max(p.h[i - 1], p.h[i]);
  return { setup: 'engulfing', dir, stop, note: 'کندل پوشا بعد از ' + (dir > 0 ? 'افت' : 'رشد') };
}

// Market structure: two higher lows and a higher high, a new confirmed higher low,
// then a close above the high since that low. Stop under the higher low.
function structure(p, i, dir) {
  if (i < 60) return null;
  const lows = lastPivots(dir > 0 ? p.lowIdx : p.highIdx, i, p.pk, 3);
  const highs = lastPivots(dir > 0 ? p.highIdx : p.lowIdx, i, p.pk, 2);
  if (lows.length < 3 || highs.length < 2) return null;
  const [L1, L2, L3] = lows, [H1, H2] = highs;
  const P = dir > 0 ? p.l : p.h, Q = dir > 0 ? p.h : p.l;
  const up = dir > 0 ? P[L1] < P[L2] && P[L2] < P[L3] && Q[H1] < Q[H2] : P[L1] > P[L2] && P[L2] > P[L3] && Q[H1] > Q[H2];
  if (!up || !(H2 < L3) || i - L3 > 15) return null;
  const trig = dir > 0 ? maxOf(p.h, L3, i - 1) : minOf(p.l, L3, i - 1);
  const fired = dir > 0 ? p.c[i] > trig && p.c[i - 1] <= trig : p.c[i] < trig && p.c[i - 1] >= trig;
  if (!fired) return null;
  return { setup: 'structure', dir, stop: P[L3] - dir * 0.1 * p.atr14[i], note: `کف بالاتر ${fmt(P[L3])}` };
}

// Turtle System 2: a break of the 55-bar high (low), stop at 2N (N = ATR).
function turtle(p, i, dir) {
  if (i < 60 || isNaN(p.hiH55[i - 1])) return null;
  const fresh = dir > 0 ? p.c[i] > p.hiH55[i] && p.c[i - 1] <= p.hiH55[i - 1] : p.c[i] < p.loL55[i] && p.c[i - 1] >= p.loL55[i - 1];
  if (!fresh) return null;
  return { setup: 'turtle', dir, stop: p.c[i] - dir * 2 * p.atr14[i], note: `سقف ۵۵ کندل ${fmt(dir > 0 ? p.hiH55[i] : p.loL55[i])}` };
}

const FNS = { orb, breakout, flag, reclaim, bounce, ema_cross: emaCross, supertrend: superTrend, macd: macdCross, bb_squeeze: bbSqueeze, vwap_reclaim: vwapReclaim, vwap_dev: vwapDev, rsi_div: rsiDiv, engulfing, structure, turtle };

// Every bar is scanned by every setup (so one-per-session state stays right); the
// first enabled hit wins. hit.agree counts the other enabled setups that fired the
// same way on this bar (the analyst uses it as confluence).
export function scan(p, i, settings, state) {
  const dirs = settings.allowShort ? [1, -1] : [1];
  let hit = null;
  const fired = [];
  for (const key of Object.keys(FNS)) {
    if (settings.strategies[key] === false && key !== 'orb') continue;
    for (const d of dirs) {
      const s = FNS[key](p, i, d, state);
      if (s && settings.strategies[key]) { fired.push(s); if (!hit) hit = s; }
    }
  }
  if (hit) hit.agree = fired.filter(s => s !== hit && s.dir === hit.dir).map(s => s.setup);
  return hit;
}

export function newScanState() { return { orbDone: new Set() }; }

function fmt(x) { return smartRound(x).toString(); }
export function smartRound(x) {
  if (!isFinite(x)) return x;
  const a = Math.abs(x);
  if (a === 0) return 0;
  // same steps as before for normal prices; tiny meme-coin prices get more digits
  const d = a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 1e-5 ? 8 : Math.min(14, Math.ceil(-Math.log10(a)) + 4);
  return Number(x.toFixed(d));
}
