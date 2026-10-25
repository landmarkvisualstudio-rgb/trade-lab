// The virtual trading desk: scanner -> entry -> exit plan -> time machine ->
// budget -> risk -> virtual broker, run bar by bar over every asset at once.
// Deterministic: the same candles and settings always give the same trades, so a
// live test can be rebuilt exactly after the app was closed.
import { BAR_MS, assetBySymbol } from './config.js';
import { prepare, scan, newScanState, smartRound } from './strategies.js';
import { replay } from './timemachine.js';

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
};

export function runSimulation({ data, settings, start, end, capital }) {
  const S = settings;
  const startCap = capital ?? S.capital;
  const syms = Object.keys(data).filter(s => S.symbols[s] !== false && data[s] && data[s].t.length > 60);
  const preps = {}, scanStates = {};
  for (const s of syms) { preps[s] = prepare(data[s]); scanStates[s] = newScanState(); }

  // every bar time inside the test, across all assets
  const times = new Set();
  for (const s of syms) for (const t of preps[s].t) if (t >= start && t < end) times.add(t);
  const timeline = [...times].sort((a, b) => a - b);

  let cash = startCap, peak = startCap, maxDD = 0, maxDDusd = 0, feesTotal = 0;
  const open = new Map(), pending = new Map(), lastClose = {}, cooldownUntil = {};
  const closed = [], equity = [], events = [], blocked = {};
  const perDay = new Map(); // dayKey -> {trades, realized}
  let nextId = 1, signals = 0;
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

  function tryEnter(s, sig, p, i, t) {
    const dir = sig.dir;
    const fill = p.o[i] * (1 + dir * slip);
    const stop = sig.stop;
    if ((fill - stop) * dir <= 0) return block('gap', s, t);
    const perUnit = Math.abs(fill - stop);
    const stopPct = perUnit / fill * 100;
    if (stopPct < S.minStopPct) return block('tightStop', s, t);
    if (stopPct > S.maxStopPct) return block('wideStop', s, t);
    if (open.size >= S.maxOpen) return block('maxOpen', s, t);
    const d = day(t);
    if (d.trades >= S.maxTradesPerDay) return block('perDay', s, t);
    const dailyLimit = startCap * S.dailyLossPct / 100;
    if (d.realized <= -dailyLimit) return block('dailyLoss', s, t);
    if ((cooldownUntil[s] || 0) > t) return block('cooldown', s, t);
    const target = fill + dir * S.targetR * perUnit;

    if (S.timeMachineFilter) {
      const tm = replay(p, i - 1, { entry: fill, stop, target, dir, horizon: Math.round(S.maxHoldHours * 12), replays: 400, seed: 19 });
      if (!tm || tm.edge < S.tmMinEdge) return block('timeMachine', s, t);
      sig.tm = { pTarget: tm.pTarget, pStop: tm.pStop, edge: tm.edge, verdict: tm.verdict };
    }

    // trader-budget: the smallest of the limits decides the size
    const eq = equityNow();
    let qty = (eq * S.riskPct / 100) / perUnit;
    const cap = Math.min(eq * S.maxPositionPct / 100, cash - eq * S.cashBufferPct / 100);
    let decidedBy = 'risk';
    if (qty * fill > cap) { qty = cap / fill; decidedBy = 'cap'; }
    if (qty <= 0 || qty * fill < S.minOrder) return block('cash', s, t);
    const riskUSDT = qty * perUnit;
    const allowance = dailyLimit + Math.min(0, d.realized);
    if (openRisk() + riskUSDT > allowance) return block('openRisk', s, t);

    const notional = qty * fill;
    const entryFee = notional * feePct(s);
    feesTotal += entryFee;
    if (dir > 0) cash -= notional + entryFee; else cash -= notional + entryFee; // a short ties up its notional as margin
    const pos = {
      id: nextId++, symbol: s, setup: sig.setup, dir, note: sig.note, signalTime: t - BAR_MS,
      entryTime: t, entryIndex: i, entry: fill, stop: smartRound(stop), target: smartRound(target),
      qty, notional, riskUSDT, entryFee, margin: notional, decidedBy, tm: sig.tm || null,
    };
    open.set(s, pos);
    d.trades++;
    events.push({ t, type: 'entry', symbol: s, id: pos.id, setup: sig.setup, dir });
  }

  const maxHold = Math.max(1, Math.round(S.maxHoldHours * 12));

  for (const t of timeline) {
    for (const s of syms) {
      const p = preps[s];
      const i = p.idx.get(t);
      if (i === undefined) continue;

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
      const hit = scan(p, i, S, scanStates[s]);
      if (hit) {
        signals++;
        if (!open.has(s) && t + BAR_MS < end) pending.set(s, { ...hit, time: t });
      }
    }
    const e = equityNow();
    if (e > peak) peak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDusd = peak - e; }
    equity.push([t + BAR_MS, e]);
  }

  const lastT = timeline.length ? timeline[timeline.length - 1] + BAR_MS : start;
  return {
    start, end, lastTime: lastT, capital: startCap, cash, feesTotal, maxDD, maxDDusd, signals,
    closed, open: [...open.values()], equity, events, blocked, lastClose,
    symbols: syms, bars: timeline.length,
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
