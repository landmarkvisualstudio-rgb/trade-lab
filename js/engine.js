// The virtual trading desk: scanner -> entry -> exit plan -> time machine ->
// budget -> risk -> virtual broker, run bar by bar over every asset at once.
// Deterministic: the same candles and settings always give the same trades, so a
// live test can be rebuilt exactly after the app was closed.
import { BAR_MS, assetBySymbol } from './config.js';
import { prepare, scan, newScanState, smartRound } from './strategies.js';
import { replay } from './timemachine.js';
import { analyze } from './analyst.js';
import { newLearner, learn, judge, summary } from './learner.js';

const TEHRAN_OFFSET = 3.5 * 3600000;
export const dayKey = t => Math.floor((t + TEHRAN_OFFSET) / 86400000);

export const BLOCK_REASONS = {
  maxOpen: 'سقف پوزیشن‌های باز',
  perDay: 'سقف تعداد معامله در روز',
  dailyLoss: 'حد ضرر روزانه',
  tightStop: 'حد ضرر خیلی نزدیک (اسپرد)',
  wideStop: 'حد ضرر خیلی دور',
  gap: 'قیمت از حد ضرر رد شده بود',
  cash: 'موجودی نقد کافی نیست',
  openRisk: 'ریسک باز روزانه پر است',
  cooldown: 'استراحت بعد از ضرر روی همین نماد',
  timeMachine: 'ماشین زمان: شانس کافی نبود',
  analyst: 'تحلیل‌گر: نشانه‌های چارت ضعیف بود',
  learned: 'تجربه: این نوع معامله اخیراً ضرر داده',
  costly: 'کارمزد نسبت به ریسک زیاد بود',
};

export function runSimulation({ data, settings, start, end, capital }) {
  const S = settings;
  const startCap = capital ?? S.capital;
  const syms = Object.keys(data).filter(s => S.symbols[s] !== false && data[s] && data[s].t.length > 60);
  // optional: which setups may trade on which asset group (from the optimizer)
  const gs = S.groupStrategies;
  const keys = Object.keys(S.strategies);
  const groupSet = {};
  if (gs) for (const g of ['crypto', 'meme', 'metal', 'energy']) groupSet[g] = { ...S, strategies: Object.fromEntries(keys.map(k => [k, !!S.strategies[k] && (gs[g] || []).includes(k)])) };
  const setFor = s => (gs ? groupSet[assetBySymbol[s]?.group] || groupSet.crypto : S);
  const preps = {}, scanStates = {};
  for (const s of syms) { preps[s] = prepare(data[s]); scanStates[s] = newScanState(); }

  // analyst and experience memory (off for tests made before they existed)
  const LEARN = !!S.learn, ANALYST = !!S.analyst || LEARN;
  const minScore = S.minScore ?? 0;
  // with learning, the robot first watches a few days before the start to gain experience
  const warmFrom = LEARN ? start - (S.learnWarmDays ?? 3) * 86400000 : start;
  const L = LEARN ? newLearner() : null;
  const waiting = [], observed = [];
  let seq = 0;

  // every bar time inside the test, across all assets
  const times = new Set();
  for (const s of syms) for (const t of preps[s].t) if (t >= warmFrom && t < end) times.add(t);
  const timeline = [...times].sort((a, b) => a - b);

  let cash = startCap, peak = startCap, maxDD = 0, maxDDusd = 0, feesTotal = 0;
  const open = new Map(), pending = new Map(), lastClose = {}, cooldownUntil = {};
  const closed = [], equity = [], events = [], blocked = {};
  const perDay = new Map(); // dayKey -> {trades, realized}
  let nextId = 1, signals = 0;
  const sigList = [];
  const day = t => { const k = dayKey(t); if (!perDay.has(k)) perDay.set(k, { trades: 0, realized: 0 }); return perDay.get(k); };
  const feePct = s => (assetBySymbol[s]?.market === 'futures' ? S.feeFuturesPct : S.feeSpotPct) / 100;
  const slip = S.slippagePct / 100;
  const block = (reason, s, t) => { blocked[reason] = (blocked[reason] || 0) + 1; if (events.length < 4000) events.push({ t, type: 'block', symbol: s, reason }); };

  const markValue = (pos, price) => pos.dir > 0 ? pos.qty * price : pos.margin + (pos.entry - price) * pos.qty;
  const equityNow = () => { let e = cash; for (const [s, pos] of open) e += markValue(pos, lastClose[s] ?? pos.entry); return e; };
  const openRisk = () => { let r = 0; for (const pos of open.values()) r += pos.riskUSDT; return r; };

  function closePos(s, pos, price, t, reason, i) {
    const fee = pos.qty * price * feePct(s);
    if (pos.dir > 0) cash += pos.qty * price - fee;
    else cash += pos.margin + (pos.entry - price) * pos.qty - fee;
    const gross = (price - pos.entry) * pos.qty * pos.dir;
    const fees = pos.entryFee + fee;
    feesTotal += fee;
    const pnl = gross - fees;
    const tr = { ...pos, exit: price, exitTime: t, reason, pnl, fees, gross, R: pnl / pos.riskUSDT, bars: i - pos.entryIndex + 1 };
    delete tr.margin; delete tr.entryFee;
    closed.push(tr);
    day(t).realized += pnl;
    if (pnl < 0) cooldownUntil[s] = t + S.cooldownBars * BAR_MS;
    open.delete(s);
    events.push({ t, type: 'exit', symbol: s, id: pos.id, reason, pnl });
  }

  const mark = (sig, d) => { if (sig.obs) sig.obs.dec = d; };
  function tryEnter(s, sig, p, i, t) {
    const dir = sig.dir;
    const blk = reason => { mark(sig, reason === 'analyst' || reason === 'learned' ? reason : 'other'); return block(reason, s, t); };
    const fill = p.o[i] * (1 + dir * slip);
    const stop = sig.stop;
    if ((fill - stop) * dir <= 0) return blk('gap', s, t);
    const perUnit = Math.abs(fill - stop);
    const stopPct = perUnit / fill * 100;
    if (stopPct < S.minStopPct) return blk('tightStop', s, t);
    if (stopPct > S.maxStopPct) return blk('wideStop', s, t);
    // fees and slippage of the round trip, as a share of the risk: a trade they would eat is skipped
    if (S.maxCostR != null && (2 * feePct(s) + 2 * slip) * fill / perUnit > S.maxCostR) return blk('costly');
    if (open.size >= S.maxOpen) return blk('maxOpen', s, t);
    const d = day(t);
    if (d.trades >= S.maxTradesPerDay) return blk('perDay', s, t);
    const dailyLimit = startCap * S.dailyLossPct / 100;
    if (d.realized <= -dailyLimit) return blk('dailyLoss', s, t);
    if ((cooldownUntil[s] || 0) > t) return blk('cooldown', s, t);
    // the analyst and the experience memory have their say
    let mult = 1, lj = null;
    if (LEARN) {
      lj = judge(L, { setup: sig.setup, group: assetBySymbol[s]?.group, grade: sig.ana?.grade, symbol: s, ana: sig.ana });
      if (lj.ready) { if (lj.avoid) return blk('learned'); mult = lj.mult; }
      else if (sig.ana && sig.ana.score < minScore) return blk('analyst');
    } else if (ANALYST && sig.ana && sig.ana.score < minScore) return blk('analyst');
    const target = fill + dir * S.targetR * perUnit;

    if (S.timeMachineFilter) {
      const tm = replay(p, i - 1, { entry: fill, stop, target, dir, horizon: Math.round(S.maxHoldHours * 12), replays: 400, seed: 19 });
      if (!tm || tm.edge < S.tmMinEdge) return blk('timeMachine', s, t);
      sig.tm = { pTarget: tm.pTarget, pStop: tm.pStop, edge: tm.edge, verdict: tm.verdict };
    }

    // trader-budget: the smallest of the limits decides the size
    const eq = equityNow();
    let qty = (eq * S.riskPct * mult / 100) / perUnit;
    const cap = Math.min(eq * S.maxPositionPct / 100, cash - eq * S.cashBufferPct / 100);
    let decidedBy = 'risk';
    if (qty * fill > cap) { qty = cap / fill; decidedBy = 'cap'; }
    if (qty <= 0 || qty * fill < S.minOrder) return blk('cash', s, t);
    const riskUSDT = qty * perUnit;
    const allowance = dailyLimit + Math.min(0, d.realized);
    if (openRisk() + riskUSDT > allowance) return blk('openRisk', s, t);

    const notional = qty * fill;
    const entryFee = notional * feePct(s);
    feesTotal += entryFee;
    if (dir > 0) cash -= notional + entryFee; else cash -= notional + entryFee; // a short ties up its notional as margin
    const pos = {
      id: nextId++, symbol: s, setup: sig.setup, dir, note: sig.note, signalTime: t - BAR_MS,
      entryTime: t, entryIndex: i, entry: fill, stop: smartRound(stop), target: smartRound(target),
      qty, notional, riskUSDT, entryFee, margin: notional, decidedBy, tm: sig.tm || null,
      ana: sig.ana || null, learn: lj && lj.ready ? { est: lj.est, mult, why: lj.why } : lj ? { why: lj.why } : null,
    };
    open.set(s, pos);
    mark(sig, 'taken');
    d.trades++;
    events.push({ t, type: 'entry', symbol: s, id: pos.id, setup: sig.setup, dir });
  }

  const maxHold = Math.max(1, Math.round(S.maxHoldHours * 12));

  // follow a signal forward to the bar where its outcome is decided (net of costs)
  function observe(s, p, i, t, hit) {
    const j = i + 1;
    if (j >= p.t.length) return null;
    const dir = hit.dir, entry = p.o[j], risk = (entry - hit.stop) * dir;
    if (!(risk > 0) || risk / entry * 100 < S.minStopPct || risk / entry * 100 > S.maxStopPct) return null;
    const cost = (2 * feePct(s) + 2 * slip) * entry / risk;
    if (S.maxCostR != null && cost > S.maxCostR) return null; // a trade the robot would never take teaches nothing
    const target = entry + dir * S.targetR * risk;
    let R = null, k = j;
    for (; k < p.t.length && k < j + maxHold; k++) {
      if (dir > 0 ? p.l[k] <= hit.stop : p.h[k] >= hit.stop) { R = -1; break; }
      if (dir > 0 ? p.h[k] >= target : p.l[k] <= target) { R = S.targetR; break; }
      if (k === j + maxHold - 1) { R = (p.c[k] - entry) * dir / risk; break; }
    }
    if (R === null) return null; // not decided yet: nothing to learn
    return { setup: hit.setup, group: assetBySymbol[s]?.group, symbol: s, grade: hit.ana?.grade, ana: hit.ana, R: R - cost, tRes: p.t[k] + BAR_MS, live: t >= start, dec: 'skipped', seq: seq++ };
  }

  for (const t of timeline) {
    const live = t >= start;
    // lessons whose outcome is known by now go into memory, oldest first
    if (LEARN && waiting.length) {
      const ready = [];
      for (let k = waiting.length - 1; k >= 0; k--) if (waiting[k].tRes <= t) { ready.push(waiting[k]); waiting.splice(k, 1); }
      ready.sort((a, b) => a.tRes - b.tRes || a.seq - b.seq).forEach(o => learn(L, o));
    }
    for (const s of syms) {
      const p = preps[s];
      const i = p.idx.get(t);
      if (i === undefined) continue;
      if (!live) { // warm-up: watch and learn, no trading
        const hit = scan(p, i, setFor(s), scanStates[s]);
        if (hit) { if (ANALYST) hit.ana = analyze(p, i, hit, S); const o = observe(s, p, i, t, hit); if (o) waiting.push(o); }
        lastClose[s] = p.c[i];
        continue;
      }

      // 1) fill the signal from the previous bar at this bar's open
      const sig = pending.get(s);
      if (sig) {
        pending.delete(s);
        if (t - sig.time <= 6 * BAR_MS && !open.has(s)) tryEnter(s, sig, p, i, t);
      }

      // 2) manage the open position on this bar (stop first, like trader-timemachine)
      const pos = open.get(s);
      if (pos) {
        const dir = pos.dir;
        const o = p.o[i], h = p.h[i], l = p.l[i], c = p.c[i];
        if ((o - pos.stop) * dir <= 0) closePos(s, pos, o * (1 - dir * slip), t, 'stop', i);
        else if ((dir > 0 ? l <= pos.stop : h >= pos.stop)) closePos(s, pos, pos.stop * (1 - dir * slip), t, 'stop', i);
        else if ((o - pos.target) * dir >= 0) closePos(s, pos, o, t, 'target', i);
        else if ((dir > 0 ? h >= pos.target : l <= pos.target)) closePos(s, pos, pos.target, t, 'target', i);
        else if (i - pos.entryIndex + 1 >= maxHold) closePos(s, pos, c * (1 - dir * slip), t + BAR_MS, 'time', i);
      }
      lastClose[s] = p.c[i];

      // 3) scan the closed bar for a new setup
      const hit = scan(p, i, setFor(s), scanStates[s]);
      if (hit) {
        signals++;
        if (ANALYST) hit.ana = analyze(p, i, hit, S);
        sigList.push({ s, i, t, hit });
        const obs = LEARN || ANALYST ? observe(s, p, i, t, hit) : null;
        if (obs) { observed.push(obs); if (LEARN) waiting.push(obs); }
        if (!open.has(s) && t + BAR_MS < end) pending.set(s, { ...hit, time: t, obs });
      }
    }
    if (!live) continue;
    const e = equityNow();
    if (e > peak) peak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDusd = peak - e; }
    equity.push([t + BAR_MS, e]);
  }

  const lastT = timeline.length ? timeline[timeline.length - 1] + BAR_MS : start;
  // how the decisions turned out: trades taken vs. signals the analyst or the memory refused
  let decisions = null;
  if (ANALYST) {
    decisions = {};
    for (const o of observed) {
      if (o.tRes > lastT) continue;
      const d = decisions[o.dec] ??= { n: 0, sumR: 0, wins: 0 };
      d.n++; d.sumR += o.R; if (o.R > 0) d.wins++;
    }
  }
  const learnSummary = LEARN ? summary(L, Object.keys(S.strategies).filter(k => S.strategies[k]), [...new Set(syms.map(s => assetBySymbol[s]?.group))]) : null;
  return {
    analyst: ANALYST, learn: learnSummary, decisions,
    start, end, lastTime: lastT, capital: startCap, cash, feesTotal, maxDD, maxDDusd, signals,
    closed, open: [...open.values()], equity, events, blocked, lastClose,
    symbols: syms, bars: timeline.length,
    sigEval: evaluateSignals(sigList, preps, S, maxHold, end),
  };
}

// Close whatever is still open at the last close (end of the test).
export function closeAllAtEnd(res, settings) {
  const fee = s => (assetBySymbol[s]?.market === 'futures' ? settings.feeFuturesPct : settings.feeSpotPct) / 100;
  for (const pos of res.open) {
    const price = res.lastClose[pos.symbol] ?? pos.entry;
    const exitFee = pos.qty * price * fee(pos.symbol);
    const gross = (price - pos.entry) * pos.qty * pos.dir;
    const fees = pos.entryFee + exitFee;
    res.cash += pos.dir > 0 ? pos.qty * price - exitFee : pos.margin + (pos.entry - price) * pos.qty - exitFee;
    res.feesTotal += exitFee;
    const tr = { ...pos, exit: price, exitTime: res.lastTime, reason: 'end', pnl: gross - fees, fees, gross, R: (gross - fees) / pos.riskUSDT };
    delete tr.margin; delete tr.entryFee;
    res.closed.push(tr);
  }
  res.open = [];
  return res;
}

// Unrealized P&L of an open position at a price.
export function unrealized(pos, price) { return (price - pos.entry) * pos.qty * pos.dir - pos.entryFee; }

export function computeStats(res, prices = {}) {
  const tr = res.closed;
  const wins = tr.filter(x => x.pnl > 0), losses = tr.filter(x => x.pnl <= 0);
  const realized = tr.reduce((a, x) => a + x.pnl, 0);
  let unreal = 0, openValue = 0;
  for (const pos of res.open) {
    const px = prices[pos.symbol] ?? res.lastClose[pos.symbol] ?? pos.entry;
    unreal += (px - pos.entry) * pos.qty * pos.dir;
    openValue += pos.dir > 0 ? pos.qty * px : pos.margin + (pos.entry - px) * pos.qty;
  }
  const equityNow = res.cash + openValue;
  const grossWin = wins.reduce((a, x) => a + x.pnl, 0);
  const grossLoss = -losses.reduce((a, x) => a + x.pnl, 0);
  const by = key => {
    const m = {};
    for (const x of tr) {
      const k = x[key];
      m[k] ??= { n: 0, wins: 0, pnl: 0 };
      m[k].n++; m[k].pnl += x.pnl; if (x.pnl > 0) m[k].wins++;
    }
    return m;
  };
  return {
    equity: equityNow, pnl: equityNow - res.capital, pnlPct: (equityNow / res.capital - 1) * 100,
    realized, unrealized: unreal, n: tr.length, wins: wins.length, losses: losses.length,
    winRate: tr.length ? wins.length / tr.length * 100 : 0,
    avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgR: tr.length ? tr.reduce((a, x) => a + x.R, 0) / tr.length : 0,
    best: tr.reduce((m, x) => (!m || x.pnl > m.pnl ? x : m), null),
    worst: tr.reduce((m, x) => (!m || x.pnl < m.pnl ? x : m), null),
    fees: res.feesTotal, maxDD: res.maxDD, maxDDusd: res.maxDDusd,
    bySetup: by('setup'), bySymbol: by('symbol'),
    byReason: by('reason'), openCount: res.open.length,
  };
}

// Signal accuracy: every scanner signal is checked on its own, as if taken with
// the exit plan, whether or not the risk rules let the robot trade it. Entry at
// the next bar's open, stop first on a bar that touches both (like trader-timemachine).
export function evaluateSignals(list, preps, S, maxHold, end) {
  const out = [];
  for (const { s, i, t, hit } of list) {
    const p = preps[s];
    const j = i + 1;
    if (j >= p.t.length || p.t[j] >= end) { out.push({ symbol: s, setup: hit.setup, t, outcome: 'pending' }); continue; }
    const dir = hit.dir, entry = p.o[j], stop = hit.stop;
    const risk = (entry - stop) * dir;
    if (!(risk > 0) || risk / entry * 100 < S.minStopPct || risk / entry * 100 > S.maxStopPct) { out.push({ symbol: s, setup: hit.setup, t, outcome: 'invalid' }); continue; }
    const target = entry + dir * S.targetR * risk;
    let outcome = 'pending', R = 0;
    for (let k = j; k < p.t.length && p.t[k] < end && k < j + maxHold; k++) {
      if (dir > 0 ? p.l[k] <= stop : p.h[k] >= stop) { outcome = 'stop'; R = -1; break; }
      if (dir > 0 ? p.h[k] >= target : p.l[k] <= target) { outcome = 'target'; R = S.targetR; break; }
      if (k === j + maxHold - 1) { outcome = 'time'; R = (p.c[k] - entry) * dir / risk; }
    }
    out.push({ symbol: s, setup: hit.setup, t, outcome, R });
  }
  return out;
}

export function signalStats(sigEval) {
  const by = {};
  const tot = { n: 0, target: 0, stop: 0, time: 0, pending: 0, invalid: 0, sumR: 0 };
  for (const e of sigEval || []) {
    const b = by[e.setup] ??= { n: 0, target: 0, stop: 0, time: 0, pending: 0, invalid: 0, sumR: 0 };
    for (const x of [b, tot]) { x.n++; x[e.outcome]++; if (e.outcome === 'target' || e.outcome === 'stop' || e.outcome === 'time') x.sumR += e.R; }
  }
  const fin = x => { const done = x.target + x.stop + x.time; return { ...x, done, accuracy: x.target + x.stop ? x.target / (x.target + x.stop) * 100 : 0, avgR: done ? x.sumR / done : 0 }; };
  return { total: fin(tot), bySetup: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, fin(v)])) };
}
