// Plain indicator math on arrays. NaN until there is enough data.

export function sma(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === n - 1) {
      let s = 0; for (let j = 0; j < n; j++) s += values[j];
      prev = s / n; out[i] = prev;
    } else if (i >= n) {
      prev = values[i] * k + prev * (1 - k); out[i] = prev;
    }
  }
  return out;
}

// Wilder RSI
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// Wilder ATR
export function atr(highs, lows, closes, n = 14) {
  const len = closes.length;
  const out = new Array(len).fill(NaN);
  const tr = new Array(len);
  for (let i = 0; i < len; i++) {
    tr[i] = i === 0 ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  if (len < n) return out;
  let s = 0; for (let i = 0; i < n; i++) s += tr[i];
  let prev = s / n; out[n - 1] = prev;
  for (let i = n; i < len; i++) { prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev; }
  return out;
}

// highest / lowest of values[i-n .. i-1] (excludes bar i)
export function priorMax(values, n) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let m = -Infinity; for (let j = i - n; j < i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}
export function priorMin(values, n) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let m = Infinity; for (let j = i - n; j < i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

// Seeded RNG (mulberry32): same seed, same numbers, on any device.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Population standard deviation over n bars
export function stdev(values, n) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0, q = 0;
    for (let j = i - n + 1; j <= i; j++) { s += values[j]; q += values[j] * values[j]; }
    const m = s / n; out[i] = Math.sqrt(Math.max(0, q / n - m * m));
  }
  return out;
}

// MACD 12/26/9
export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const start = line.findIndex(x => !isNaN(x));
  const signal = new Array(closes.length).fill(NaN);
  if (start >= 0) { const e = ema(line.slice(start), sig); for (let i = 0; i < e.length; i++) signal[start + i] = e[i]; }
  return { line, signal, hist: line.map((x, i) => x - signal[i]) };
}

// Supertrend (ATR 10, x3): returns line and direction (+1 up, -1 down)
export function supertrend(h, l, c, n = 10, mult = 3) {
  const a = atr(h, l, c, n);
  const len = c.length, line = new Array(len).fill(NaN), dir = new Array(len).fill(0);
  let upper = NaN, lower = NaN, d = 1;
  for (let i = 0; i < len; i++) {
    if (isNaN(a[i])) continue;
    const mid = (h[i] + l[i]) / 2;
    const bu = mid + mult * a[i], bl = mid - mult * a[i];
    upper = isNaN(upper) || bu < upper || c[i - 1] > upper ? bu : upper;
    lower = isNaN(lower) || bl > lower || c[i - 1] < lower ? bl : lower;
    if (d === 1 && c[i] < lower) d = -1; else if (d === -1 && c[i] > upper) d = 1;
    dir[i] = d; line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

// VWAP that resets every UTC day, with the volume-weighted standard deviation
export function vwapDaily(t, h, l, c, v) {
  const len = c.length, vw = new Array(len).fill(NaN), sd = new Array(len).fill(NaN);
  let day = -1, pv = 0, vv = 0, p2v = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.floor(t[i] / 86400000);
    if (d !== day) { day = d; pv = 0; vv = 0; p2v = 0; }
    const tp = (h[i] + l[i] + c[i]) / 3;
    pv += tp * v[i]; vv += v[i]; p2v += tp * tp * v[i];
    if (vv > 0) { vw[i] = pv / vv; sd[i] = Math.sqrt(Math.max(0, p2v / vv - vw[i] * vw[i])); }
  }
  return { vwap: vw, sd };
}

// Confirmed swing points: a pivot needs k lower highs (or higher lows) on each side
export function pivots(h, l, k = 3) {
  const hi = new Array(h.length).fill(false), lo = new Array(l.length).fill(false);
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(h[i] > h[i - j] && h[i] >= h[i + j])) isH = false;
      if (!(l[i] < l[i - j] && l[i] <= l[i + j])) isL = false;
    }
    hi[i] = isH; lo[i] = isL;
  }
  return { hi, lo, k };
}
