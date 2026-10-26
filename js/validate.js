// Strategy validation (skill 1). Two questions before trusting any result:
//  1. Is it luck? Bootstrap the trade results and replay them in random orders
//     (Monte Carlo) to see the range of outcomes the same edge could have given.
//  2. Is it overfitting? Walk-forward: choose the settings on the first part of the
//     history only, then judge them on the last part, which played no part in the choice.
import { runSimulation, closeAllAtEnd, computeStats } from './engine.js';
import { rng } from './indicators.js';
import { PRO_DEFAULTS, OPTIMIZED, STRATEGIES } from './config.js';

const DAY = 86400000;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// resample the trades' R many times: how sure are we that the average is above zero?
export function bootstrap(Rs, n = 2000, seed = 7) {
  if (Rs.length < 2) return null;
  const rand = rng(seed), m = Rs.length, means = new Float64Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let j = 0; j < m; j++) s += Rs[Math.floor(rand() * m)]; means[k] = s / m; }
  means.sort();
  let pos = 0; for (const x of means) if (x > 0) pos++;
  return { mean: mean(Rs), lo: means[Math.floor(n * 0.05)], hi: means[Math.floor(n * 0.95)], pPos: pos / n };
}

// the same trades in random order: how deep could the drawdown have been?
export function monteCarlo(Rs, riskPct, n = 1000, seed = 11) {
  if (Rs.length < 2) return null;
  const rand = rng(seed), dds = new Float64Array(n), ends = new Float64Array(n), m = Rs.length;
  for (let k = 0; k < n; k++) {
    let eq = 1, peak = 1, dd = 0;
    for (let j = 0; j < m; j++) {
      const R = Rs[Math.floor(rand() * m)];
      eq *= 1 + R * riskPct / 100;
      if (eq > peak) peak = eq;
      dd = Math.max(dd, (peak - eq) / peak);
    }
    dds[k] = dd * 100; ends[k] = (eq - 1) * 100;
  }
  dds.sort(); ends.sort();
  let loss = 0; for (const x of ends) if (x < 0) loss++;
  return { dd50: dds[n >> 1], dd95: dds[Math.floor(n * 0.95)], ret5: ends[Math.floor(n * 0.05)], ret50: ends[n >> 1], ret95: ends[Math.floor(n * 0.95)], pLoss: loss / n };
}

// a plain verdict from the trade list
export function confidence(trades, riskPct) {
  const Rs = trades.map(x => x.R);
  const n = Rs.length;
  const b = bootstrap(Rs), mc = monteCarlo(Rs, riskPct);
  let level, text;
  if (n < 30) { level = 'low'; text = `فقط ${n} معامله: هنوز هیچ نتیجه‌ای قابل اعتماد نیست. دست‌کم ۳۰ معامله لازم است، ۱۰۰ بهتر.`; }
  else if (b.pPos >= 0.95) { level = 'good'; text = 'با ۹۵٪ اطمینان، میانگین معامله‌ها بالای صفر است. این نتیجه احتمالاً شانسی نیست (ولی بازار عوض می‌شود).'; }
  else if (b.pPos >= 0.75) { level = 'mid'; text = 'نشانه‌ی برتری هست ولی هنوز می‌تواند شانسی باشد. نمونه‌ی بیشتری لازم است.'; }
  else if (b.pPos <= 0.25) { level = 'bad'; text = 'به احتمال زیاد این روش در این بازه واقعاً زیان‌ده است، نه بدشانس.'; }
  else { level = 'mid'; text = 'نتیجه با صفر فرقی ندارد؛ نه برتری ثابت‌شده‌ای هست نه ضرر ثابت‌شده‌ای.'; }
  return { n, level, text, b, mc };
}

/* ---------------- walk-forward ---------------- */
const TF_GRID = [5, 15, 30];
const HOLD = { 5: 4, 15: 8, 30: 12 };
const TR_GRID = [2, 3];
const EXIT_GRID = [['fixed', null], ['managed', PRO_DEFAULTS.exits]];
const MIN_N = 12, MIN_R = 0.05;
export const WF_GROUPS = ['crypto', 'meme', 'metal', 'energy'];

export function wfCandidates() {
  const out = [];
  for (const tf of TF_GRID) for (const tR of TR_GRID) for (const [ek, ex] of EXIT_GRID) out.push({ tf, tR, ek, ex, hold: HOLD[tf] });
  return out;
}
export const wfWarmupBars = () => Math.round(300 * Math.max(...TF_GRID) / 5);

// data: 5-minute series from (end - days - warmup) to end
export async function walkForward({ data, deriv, base, end, days = 30, oosDays = 10, onProgress = () => {} }) {
  const start = end - days * DAY, split = end - oosDays * DAY;
  const keys = Object.keys(STRATEGIES).filter(k => base.strategies[k]);
  const plain = { ...base, analyst: false, learn: false, groupStrategies: null, timeMachineFilter: false };
  const cands = wfCandidates();
  const pause = () => new Promise(r => setTimeout(r, 0));
  let step = 0;
  const total = cands.length + 6;
  for (const c of cands) {
    onProgress(++step, total, `ارزیابی تایم‌فریم ${c.tf} دقیقه، هدف ${c.tR}R، خروج ${c.ek === 'fixed' ? 'ثابت' : 'مدیریت‌شده'}`);
    await pause();
    const S = { ...plain, targetR: c.tR, maxHoldHours: c.hold, pro: { ...PRO_DEFAULTS, tf: c.tf, exits: c.ex } };
    const r = runSimulation({ data, settings: S, start, end, deriv, evalOnly: true });
    const cells = {};
    for (const o of r.observed) {
      if (o.dec.startsWith('filtered')) continue;
      const half = o.t < split ? 'in' : 'out';
      const k = o.setup + '|' + o.group, x = cells[k] ??= { setup: o.setup, group: o.group, in: [], out: [] };
      x[half].push(o.R);
    }
    const gsel = {}; let score = 0, nIn = 0, sumOut = 0, nOut = 0;
    for (const x of Object.values(cells)) {
      if (x.in.length >= MIN_N && mean(x.in) >= MIN_R && keys.includes(x.setup)) {
        (gsel[x.group] ??= []).push(x.setup);
        score += x.in.reduce((a, b) => a + b, 0); nIn += x.in.length;
        sumOut += x.out.reduce((a, b) => a + b, 0); nOut += x.out.length;
      }
    }
    Object.assign(c, { gsel, score, nIn, inR: nIn ? score / nIn : 0, nOut, outR: nOut ? sumOut / nOut : 0, cells: Object.values(cells).map(x => ({ setup: x.setup, group: x.group, nIn: x.in.length, inR: mean(x.in), nOut: x.out.length, outR: mean(x.out), picked: !!gsel[x.group]?.includes(x.setup) })) });
  }
  // the choice uses the first part only
  const best = cands.reduce((a, c) => (c.score > (a?.score ?? -Infinity) ? c : a), null);
  for (const g of WF_GROUPS) best.gsel[g] ??= [];
  const set = profileFrom(best);
  const run = (S, a, b, label) => {
    onProgress(++step, total, label);
    const r = closeAllAtEnd(runSimulation({ data, settings: S, start: a, end: b, deriv }), S);
    const st = computeStats(r);
    return { n: st.n, win: st.winRate, pnlPct: st.pnlPct, pf: st.profitFactor, dd: st.maxDD, fees: st.fees, avgR: st.avgR, conf: confidence(r.closed, S.riskPct) };
  };
  const now = { ...plain, pro: null };
  const proAll = { ...plain, pro: { ...PRO_DEFAULTS } };
  const opt = { ...plain, ...set };
  const optLearn = { ...opt, analyst: true, learn: true };
  const port = {};
  port.now = { out: run(now, split, end, 'سیستم قبلی روی ۱۰ روز آخر') }; await pause();
  port.pro = { out: run(proAll, split, end, 'میز حرفه‌ای با همه‌ی ستاپ‌ها') }; await pause();
  port.opt = { out: run(opt, split, end, 'پروفایل انتخاب‌شده روی ۱۰ روز آخر') }; await pause();
  port.optLearn = { out: run(optLearn, split, end, 'همان پروفایل با تحلیل‌گر و خودآموز') }; await pause();
  port.opt.in = run(opt, start, split, 'همان پروفایل روی ۲۰ روز اول'); await pause();
  port.now.in = run(now, start, split, 'سیستم قبلی روی ۲۰ روز اول');
  return { at: Date.now(), start, split, end, days, oosDays, best: { tf: best.tf, tR: best.tR, ek: best.ek, hold: best.hold, gsel: best.gsel, nIn: best.nIn, inR: best.inR, nOut: best.nOut, outR: best.outR, cells: best.cells }, cands: cands.map(c => ({ tf: c.tf, tR: c.tR, ek: c.ek, nIn: c.nIn, inR: c.inR, nOut: c.nOut, outR: c.outR, score: c.score })), port, set };
}

// the settings a walk-forward choice becomes
export function profileFrom(best) {
  return {
    ...JSON.parse(JSON.stringify(OPTIMIZED.set)),
    targetR: best.tR, maxHoldHours: best.hold,
    groupStrategies: best.gsel,
    pro: { ...JSON.parse(JSON.stringify(PRO_DEFAULTS)), tf: best.tf, exits: best.ex === undefined ? (best.ek === 'fixed' ? null : PRO_DEFAULTS.exits) : best.ex },
  };
}
