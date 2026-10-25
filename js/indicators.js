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
