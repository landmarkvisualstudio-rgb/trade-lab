// Market regime (skill 2): is this market trending up, trending down, ranging, or
// wild? Each setup family only trades in the regimes it was built for, and crypto
// trades also look at bitcoin, which leads the whole market. Only data up to the
// bar's close is used.
import { STRATEGIES } from './config.js';

export const REGIME_NAMES = { up: 'روند صعودی', down: 'روند نزولی', range: 'رنج', mixed: 'نامشخص', wild: 'پرنوسان و خطرناک' };
const cache = new WeakMap();

function sma(a, n) {
  const out = new Array(a.length).fill(NaN); let s = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (isFinite(x)) { s += x; k++; }
    if (i >= n) { const y = a[i - n]; if (isFinite(y)) { s -= y; k--; } }
    if (i >= n - 1 && k > n * 0.8) out[i] = s / k;
  }
  return out;
}

// one label per bar of a prepared series
export function regimes(p) {
  if (cache.has(p)) return cache.get(p);
  const n = p.c.length, out = new Array(n).fill('mixed');
  const atrPct = p.atr14.map((a, i) => a / p.c[i]);
  const base = sma(atrPct, 200);
  for (let i = 0; i < n; i++) {
    const c = p.c[i], er = p.er20[i], e = p.htf[i], sl = p.htfSlope[i], e200 = p.ema200[i];
    if (isFinite(base[i]) && atrPct[i] > 2.2 * base[i]) { out[i] = 'wild'; continue; }
    if (!isFinite(er) || !isFinite(e) || !isFinite(sl)) continue;
    const longOk = !isFinite(e200) || c > e200, shortOk = !isFinite(e200) || c < e200;
    if (c > e && sl > 0 && er >= 0.2 && longOk) out[i] = 'up';
    else if (c < e && sl < 0 && er >= 0.2 && shortOk) out[i] = 'down';
    else if (er < 0.2) out[i] = 'range';
  }
  cache.set(p, out);
  return out;
}

// does this setup suit this regime? (null = yes, otherwise the reason it doesn't)
export function regimeAllows(setup, dir, reg) {
  if (reg === 'wild') return false;
  const fam = STRATEGIES[setup]?.family || 'trend';
  const withT = (dir > 0 && reg === 'up') || (dir < 0 && reg === 'down');
  const against = (dir > 0 && reg === 'down') || (dir < 0 && reg === 'up');
  if (fam === 'trend' || fam === 'momentum') return withT;
  if (fam === 'meanrev' || fam === 'reversal') return reg === 'range' || reg === 'mixed';
  return !against; // breakout, volatility, price action, intraday
}

// bitcoin as the market leader for crypto and meme coins
export function leaderAllows(dir, leaderReg) {
  if (!leaderReg) return true;
  if (leaderReg === 'wild') return false;
  return dir > 0 ? leaderReg !== 'down' : leaderReg !== 'up';
}
