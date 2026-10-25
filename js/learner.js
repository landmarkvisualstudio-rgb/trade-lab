// Experience memory: the robot learns from what actually happened, like a trader
// keeping a journal. Every scanner signal, traded or not, is followed until it
// hits its target, its stop or the time limit; only then (never earlier) its result,
// net of fees and slippage, goes into memory. Before each new entry the memory is
// asked: "what happened the last times I saw something like this?"
//
// - Recent experience counts more (each new lesson fades older ones a little).
// - Small samples are shrunk toward zero, so a few lucky trades don't fool it.
// - A setup it gave up on is still watched, so it comes back if it starts working.
// Everything is deterministic: the same candles give the same memory on any device.
import { FACTORS } from './analyst.js';
import { GROUPS } from './config.js';

const FADE = 0.992;         // per lesson: ~85 lessons to halve an old one's weight
const SHRINK = 6;           // pseudo-lessons at 0R added to every estimate
const READY = 25;           // lessons before the memory starts to decide
export const LEARN_DEFAULTS = { avoidBelow: -0.12, boostAbove: 0.15, maxMult: 1.5, minMult: 0.5 };

export function newLearner() { return { stats: {}, n: 0, lessons: 0, history: [] }; }

function bump(L, key, R) {
  const s = L.stats[key] ??= { w: 0, r: 0, cnt: 0, last: L.n, wins: 0 };
  const decay = Math.pow(FADE, L.n - s.last);
  s.w = s.w * decay + 1; s.r = s.r * decay + R; s.cnt++; s.last = L.n; if (R > 0) s.wins++;
}
function read(L, key) {
  const s = L.stats[key];
  if (!s) return { w: 0, mean: 0, cnt: 0, wins: 0 };
  const decay = Math.pow(FADE, L.n - s.last);
  const w = s.w * decay, r = s.r * decay;
  return { w, mean: r / (w + SHRINK), raw: w > 0 ? r / w : 0, cnt: s.cnt, wins: s.wins };
}
const keysOf = o => ({
  setup: `S|${o.setup}`, group: `G|${o.setup}|${o.group}`, grade: `A|${o.grade}`, symbol: `Y|${o.symbol}`,
});

// a resolved signal becomes a lesson
export function learn(L, o) {
  L.n++; L.lessons++;
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
  const base = (g.mean * wg + s.mean * ws + a.mean * wa + y.mean * wy) / (wg + ws + wa + wy);
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
    rows.push({ setup: s, group: g, n: r.cnt, w: r.w, avgR: r.raw, est: r.mean, winRate: r.wins / r.cnt * 100 });
  }
  return { lessons: L.lessons, ready: L.lessons >= READY, weights: factorWeights(L), rows, overall: read(L, 'ALL').raw, history: L.history };
}
