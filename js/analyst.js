// The analyst (chart-analyst skill, section 2): before every entry it reads the chart
// around the signal the way the skill's checklist does and scores it. Only data up
// to the signal bar's close is used. Each factor is +1 (helps), 0 (neutral) or -1
// (hurts) for the trade's direction; the experience memory later learns how much
// each factor is really worth.
import { STRATEGIES } from './config.js';
import { lastPivots } from './strategies.js';

export const FACTORS = {
  htf: 'روند ساعتی',
  trend: 'روند بلند (EMA200)',
  structure: 'ساختار بازار',
  momentum: 'مومنتوم (RSI)',
  volume: 'حجم',
  room: 'فضا تا مقاومت',
  regime: 'حالت بازار',
  agree: 'تأیید ستاپ‌های دیگر',
};
const REVERSAL = new Set(['meanrev', 'reversal']);

export function analyze(p, i, sig, S) {
  const dir = sig.dir;
  const fam = STRATEGIES[sig.setup]?.family || 'trend';
  const contrarian = REVERSAL.has(fam) || sig.setup === 'engulfing';
  const c = p.c[i];
  const f = {}, note = {};

  // 1) higher timeframe: price against the hourly EMA 20 and its slope
  if (isNaN(p.htf[i]) || isNaN(p.htfSlope[i])) { f.htf = 0; note.htf = 'داده‌ی ساعتی کافی نیست'; }
  else {
    const side = Math.sign(c - p.htf[i]) * dir, slope = Math.sign(p.htfSlope[i]) * dir;
    f.htf = side > 0 && slope > 0 ? 1 : side < 0 && slope < 0 ? -1 : 0;
    note.htf = f.htf > 0 ? 'روند ساعتی هم‌جهت' : f.htf < 0 ? 'خلاف روند ساعتی' : 'روند ساعتی نامشخص';
  }
  // 2) long trend: EMA 200 on 5-minute bars
  if (isNaN(p.ema200[i])) { f.trend = 0; note.trend = 'EMA200 آماده نیست'; }
  else { f.trend = (c - p.ema200[i]) * dir > 0 ? 1 : -1; note.trend = f.trend > 0 ? 'هم‌جهت با EMA200' : 'خلاف EMA200'; }
  // 3) structure: the last two confirmed swing highs and lows
  const lows = lastPivots(p.lowIdx, i, p.pk, 2), highs = lastPivots(p.highIdx, i, p.pk, 2);
  if (lows.length < 2 || highs.length < 2) { f.structure = 0; note.structure = 'سوئینگ کافی نیست'; }
  else {
    const hl = p.l[lows[1]] > p.l[lows[0]], hh = p.h[highs[1]] > p.h[highs[0]];
    const up = hl && hh, down = !hl && !hh;
    f.structure = (up && dir > 0) || (down && dir < 0) ? 1 : (up && dir < 0) || (down && dir > 0) ? -1 : 0;
    note.structure = up ? 'سقف و کف بالاتر' : down ? 'سقف و کف پایین‌تر' : 'ساختار رنج';
  }
  // 4) momentum: RSI 14; a reversal setup wants a stretched RSI, a trend setup a healthy one
  const r = p.rsi14[i], rr = dir > 0 ? r : 100 - r;
  if (isNaN(r)) f.momentum = 0;
  else if (contrarian) f.momentum = rr < 35 ? 1 : rr > 60 ? -1 : 0;
  else f.momentum = rr >= 50 && rr <= 70 ? 1 : rr > 78 || rr < 40 ? -1 : 0;
  note.momentum = isNaN(r) ? 'RSI آماده نیست' : `RSI ${r.toFixed(0)}`;
  // 5) volume against its 20-bar average
  const rv = p.volAvg[i - 1] > 0 ? p.v[i] / p.volAvg[i - 1] : 1;
  f.volume = rv >= 1.3 ? 1 : rv < 0.7 ? -1 : 0;
  note.volume = `حجم ${rv.toFixed(1)}× میانگین`;
  // 6) room: distance to the 100-bar high (low for a short) in R
  const risk = Math.abs(c - sig.stop);
  const wall = dir > 0 ? p.hiH100[i] : p.loL100[i];
  if (!(risk > 0) || isNaN(wall)) { f.room = 0; note.room = 'سطح مقابل نامشخص'; }
  else {
    const roomR = (wall - c) * dir / risk;
    if (roomR <= 0) { f.room = 1; note.room = 'بالای سقف ۱۰۰ کندل (فضای باز)'; }
    else { f.room = roomR >= S.targetR ? 1 : roomR < 1 ? -1 : 0; note.room = `${roomR.toFixed(1)}R تا ${dir > 0 ? 'مقاومت' : 'حمایت'}`; }
  }
  // 7) regime: trending or choppy (efficiency ratio), matched to the setup's family
  const er = p.er20[i];
  if (isNaN(er)) f.regime = 0;
  else if (contrarian) f.regime = er < 0.25 ? 1 : er > 0.5 ? -1 : 0;
  else f.regime = er > 0.3 ? 1 : er < 0.15 ? -1 : 0;
  note.regime = isNaN(er) ? '—' : er > 0.3 ? 'بازار روندی' : er < 0.15 ? 'بازار پرنوسان و بی‌جهت' : 'بازار معمولی';
  // 8) confluence: other setups firing the same way
  const ag = sig.agree?.length || 0;
  f.agree = ag >= 1 ? 1 : 0;
  note.agree = ag ? `${ag} ستاپ دیگر هم‌نظر` : 'ستاپ تنها';

  const score = Object.values(f).reduce((a, x) => a + x, 0);
  const grade = score >= 4 ? 'A' : score >= 2 ? 'B' : score >= 0 ? 'C' : 'D';
  return { score, grade, f, note };
}

// a short Persian line for a trade row: the strongest reasons first
export function analysisLine(a) {
  if (!a) return '';
  const pos = Object.keys(a.f).filter(k => a.f[k] > 0).map(k => a.note[k]);
  const neg = Object.keys(a.f).filter(k => a.f[k] < 0).map(k => a.note[k]);
  return [...pos.slice(0, 3).map(x => '✓ ' + x), ...neg.slice(0, 2).map(x => '✗ ' + x)].join(' · ');
}
