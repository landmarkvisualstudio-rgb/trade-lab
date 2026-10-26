// Experience memory: the robot learns from what actually happened, like a trader
// keeping a journal. Every scanner signal, traded or not, is followed until it
// hits its target, its stop or the time limit; only then (never earlier) its result,
// net of fees and slippage, goes into memory. Before each new entry the memory is
// asked: "what happened the last times I saw something like this?"
//
// - Recent experience counts more: a lesson's weight halves every 2 days of market time.
// - Small samples are shrunk toward zero, so a few lucky trades don't fool it.
// - A setup it gave up on is still watched, so it comes back if it starts working.
// Everything is deterministic: the same candles give the same memory on any device.
import { FACTORS } from './analyst.js';
import { GROUPS } from './config.js';

const HALF_LIFE = 2 * 86400000; // a lesson's weight halves every 2 days of market time
const SHRINK = 6;           // pseudo-lessons at 0R added to every estimate
const READY = 25;           // lessons before the memory starts to decide
export const LEARN_DEFAULTS = { avoidBelow: -0.12, boostAbove: 0.15, maxMult: 1.5, minMult: 0.5 };

export function newLearner() { return { stats: {}, n: 0, now: 0, lessons: 0, history: [] }; }

const fade = (L, s) => Math.pow(0.5, Math.max(0, L.now - s.last) / HALF_LIFE);
function bump(L, key, R) {
  const s = L.stats[key] ??= { w: 0, r: 0, wv: 0, cnt: 0, last: L.now };
  const d = fade(L, s);
  s.w = s.w * d + 1; s.r = s.r * d + R; s.wv = s.wv * d + (R > 0 ? 1 : 0); s.cnt++; s.last = L.now;
}
function read(L, key) {
  const s = L.stats[key];
  if (!s) return { w: 0, mean: 0, raw: 0, cnt: 0, winRate: 0 };
  const d = fade(L, s);
  const w = s.w * d, r = s.r * d;
  return { w, mean: r / (w + SHRINK), raw: w > 0 ? r / w : 0, cnt: s.cnt, winRate: w > 0 ? s.wv * d / w * 100 : 0 };
}
const keysOf = o => {
  const k = { setup: `S|${o.setup}`, group: `G|${o.setup}|${o.group}`, grade: `A|${o.grade}`, symbol: `Y|${o.symbol}` };
  // newer tests also remember the market regime and the trading session (skills 2 and 9)
  if (o.reg) k.reg = `Q|${o.setup}|${o.reg}`;
  if (o.session) k.session = `T|${o.group}|${o.session}`;
  return k;
};

// a resolved signal becomes a lesson
export function learn(L, o) {
  L.n++; L.lessons++; L.now = Math.max(L.now, o.tRes);
  const k = keysOf(o);
  for (const key of Object.values(k)) bump(L, key, o.R);
  bump(L, 'ALL', o.R);
  if (o.ana) for (const [f, v] of Object.entries(o.ana.f)) bump(L, `F|${f}|${v}`, o.R);
  if (L.lessons % 10 === 0) L.history.push([o.tRes, read(L, 'ALL').raw]);
}

// how much is each analyst factor worth, in R, from experience
export function factorWeights(L) {
  const w = {};
  for (const f of Object.keys(FACTORS)) {
    const plus = read(L, `F|${f}|1`), minus = read(L, `F|${f}|-1`);
    w[f] = (plus.mean - minus.mean) / 2;
  }
  return w;
}

// the question before an entry
export function judge(L, o, opts = LEARN_DEFAULTS) {
  if (L.lessons < READY) return { ready: false, mult: 1, est: 0, why: `هنوز در حال تجربه (${L.lessons}/${READY} درس)` };
  const k = keysOf(o);
  const g = read(L, k.group), s = read(L, k.setup), a = read(L, k.grade), y = read(L, k.symbol), all = read(L, 'ALL');
  // a weighted blend: the most specific context counts most once it has enough lessons
  const wg = Math.min(1, g.w / 12) * 0.45, ws = 0.25, wa = 0.15, wy = Math.min(1, y.w / 10) * 0.15;
  let num = g.mean * wg + s.mean * ws + a.mean * wa + y.mean * wy, den = wg + ws + wa + wy;
  if (k.reg) { const q = read(L, k.reg), wq = Math.min(1, q.w / 12) * 0.3; num += q.mean * wq; den += wq; }
  if (k.session) { const z = read(L, k.session), wz = Math.min(1, z.w / 15) * 0.15; num += z.mean * wz; den += wz; }
  const base = num / den;
  let fx = 0;
  if (o.ana) { const fw = factorWeights(L); for (const [f, v] of Object.entries(o.ana.f)) fx += (fw[f] || 0) * v; }
  // factor weights are learned one by one and overlap, so their sum is damped and capped
  const est = base + Math.max(-0.4, Math.min(0.4, 0.3 * fx));
  const avoid = est < opts.avoidBelow || (g.w >= 10 && g.mean < opts.avoidBelow * 1.5);
  const mult = avoid ? 0 : Math.max(opts.minMult, Math.min(opts.maxMult, 1 + est * 1.5));
  const why = `${Math.round(g.cnt)} نمونه‌ی مشابه (${GROUPS[o.group] || o.group})، میانگین ${g.raw >= 0 ? '+' : ''}${(g.raw || 0).toFixed(2)}R · برآورد ${est >= 0 ? '+' : ''}${est.toFixed(2)}R`;
  return { ready: true, est, mult, avoid, why, overall: all.raw };
}

// what the memory holds, for the app
export function summary(L, setups, groups) {
  const rows = [];
  for (const s of setups) for (const g of groups) {
    const r = read(L, `G|${s}|${g}`);
    if (!r.cnt) continue;
    rows.push({ setup: s, group: g, n: r.cnt, w: r.w, avgR: r.raw, est: r.mean, winRate: r.winRate });
  }
  const ctx = [];
  for (const key of Object.keys(L.stats)) {
    if (key[0] !== 'Q' && key[0] !== 'T') continue;
    const r = read(L, key), [, a, b] = key.split('|');
    if (r.cnt >= 8) ctx.push({ kind: key[0] === 'Q' ? 'regime' : 'session', a, b, n: r.cnt, avgR: r.raw, est: r.mean, winRate: r.winRate });
  }
  const weights = factorWeights(L);
  for (const f of Object.keys(weights)) if (!L.stats[`F|${f}|1`] && !L.stats[`F|${f}|-1`] && !L.stats[`F|${f}|0`]) delete weights[f];
  return { lessons: L.lessons, ready: L.lessons >= READY, weights, rows, ctx, overall: read(L, 'ALL').raw, history: L.history };
}
