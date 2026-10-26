// The virtual trading desk: scanner -> entry -> exit plan -> time machine ->
// budget -> risk -> virtual broker, run bar by bar over every asset at once.
// Deterministic: the same candles and settings always give the same trades, so a
// live test can be rebuilt exactly after the app was closed.
//
// settings.pro holds the "pro desk" (skills added in version 7): a higher signal
// timeframe, market regimes, portfolio risk, managed exits, realistic costs,
// shorts on futures, derivatives data and the news calendar. Tests made before it
// existed have no settings.pro and run exactly as they always did.
import { BAR_MS, assetBySymbol } from './config.js';
import { prepare, scan, newScanState, smartRound, resample } from './strategies.js';
import { replay } from './timemachine.js';
import { analyze } from './analyst.js';
import { newLearner, learn, judge, summary } from './learner.js';
import { regimes, regimeAllows, leaderAllows } from './regime.js';
import { calendarBlock, sessionOf } from './calendar.js';

const TEHRAN_OFFSET = 3.5 * 3600000;
export const dayKey = t => Math.floor((t + TEHRAN_OFFSET) / 86400000);
const HOUR = 3600000, FUND_EVERY = 8 * HOUR, DEFAULT_FUNDING = 0.0001;

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
  regime: 'حالت بازار با این ستاپ نمی‌خواند',
  leader: 'بیت‌کوین خلاف جهت این معامله است',
  news: 'نزدیک خبر مهم اقتصادی آمریکا',
  closed: 'بازار اصلی این دارایی تعطیل است',
  cluster: 'پوزیشن هم‌جهت زیاد در یک گروه (همبستگی)',
  riskCap: 'سقف ریسک باز کل حساب پر است',
  ddStop: 'ترمز افت سرمایه فعال است',
};
const clusterOf = s => { const g = assetBySymbol[s]?.group; return g === 'meme' ? 'crypto' : g || 'crypto'; };

// the last value of [time, value] rows known at time t (rows sorted by time)
function lastAt(rows, t) {
  if (!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, pos = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) { pos = m; lo = m + 1; } else hi = m - 1; }
  return pos < 0 ? null : rows[pos];
}

export function runSimulation({ data, settings, start, end, capital, deriv, evalOnly = false }) {
  const S = settings;
  const P = S.pro || null;
  const startCap = capital ?? S.capital;
  const syms = Object.keys(data).filter(s => S.symbols[s] !== false && data[s] && data[s].t.length > 60);
  const feePct = s => (assetBySymbol[s]?.market === 'futures' ? S.feeFuturesPct : S.feeSpotPct) / 100;
  // optional: which setups may trade on which asset group (from the validator)
  const gs = S.groupStrategies;
  const keys = Object.keys(S.strategies);
  const shortsFor = s => (P ? !!P.shorts && assetBySymbol[s]?.market === 'futures' : S.allowShort);
  const setCache = {};
  const setFor = s => {
    const g = assetBySymbol[s]?.group || 'crypto', sh = shortsFor(s), k = g + sh;
    if (!setCache[k]) setCache[k] = { ...S, allowShort: sh, strategies: gs ? Object.fromEntries(keys.map(x => [x, !!S.strategies[x] && (gs[g] || []).includes(x)])) : S.strategies };
    return setCache[k];
  };

  // signal timeframe (skill 5): exits are still managed on 5-minute bars
  const TF = P && P.tf > 5 ? P.tf * 60000 : BAR_MS;
  const HTF = TF >= HOUR ? 4 * HOUR : HOUR;
  const tfSeries = s => (TF === BAR_MS ? data[s] : resample(data[s], TF, HTF));
  const preps = {}, prepT = {}, scanStates = {}, turn = {};
  for (const s of syms) {
    preps[s] = prepare(data[s]); prepT[s] = TF === BAR_MS ? preps[s] : prepare(tfSeries(s)); scanStates[s] = newScanState();
    if (P?.costs) turn[s] = turnover(data[s]);
  }
  // bitcoin leads the crypto market (skill 2)
  const lead = P?.regime && data.BTCUSDT && data.BTCUSDT.t.length > 60 ? prepare(tfSeries('BTCUSDT')) : null;
  const leadReg = lead ? regimes(lead) : null;
  let leadIdx = -1;

  // analyst and experience memory (off for tests made before they existed)
  const LEARN = !!S.learn, ANALYST = !!S.analyst || LEARN;
  const minScore = S.minScore ?? 0;
  const warmFrom = LEARN ? start - (S.learnWarmDays ?? 3) * 86400000 : start;
  const L = LEARN ? newLearner() : null;
  const waiting = [], observed = [];
  let seq = 0;

  const times = new Set();
  for (const s of syms) for (const t of preps[s].t) if (t >= warmFrom && t < end) times.add(t);
  const timeline = [...times].sort((a, b) => a - b);

  let cash = startCap, peak = startCap, maxDD = 0, maxDDusd = 0, feesTotal = 0, fundingTotal = 0, lossStreak = 0;
  let brakePeak = startCap, pauseUntil = 0; // the drawdown brake (skill 3) has its own peak: a pause resets it
  const open = new Map(), pending = new Map(), lastClose = {}, cooldownUntil = {};
  const closed = [], equity = [], events = [], blocked = {};
  const perDay = new Map();
  let nextId = 1, signals = 0;
  const sigList = [];
  const day = t => { const k = dayKey(t); if (!perDay.has(k)) perDay.set(k, { trades: 0, realized: 0 }); return perDay.get(k); };
  const slip = S.slippagePct / 100;
  // skill 6: slippage grows as an asset's trading volume shrinks
  const slipOf = (s, i) => {
    if (!P?.costs) return slip;
    const tv = turn[s][Math.max(0, i - 1)];
    return !(tv > 0) ? slip * 3 : Math.min(0.003, Math.max(slip, slip * Math.sqrt(2e6 / tv)));
  };
  const block = (reason, s, t) => { blocked[reason] = (blocked[reason] || 0) + 1; if (events.length < 4000) events.push({ t, type: 'block', symbol: s, reason }); };

  const markValue = (pos, price) => pos.dir > 0 ? pos.qty * price : pos.margin + (pos.entry - price) * pos.qty;
  const equityNow = () => { let e = cash; for (const [s, pos] of open) e += markValue(pos, lastClose[s] ?? pos.entry); return e; };
  const openRisk = () => { let r = 0; for (const pos of open.values()) r += pos.riskLeft ?? pos.riskUSDT; return r; };
  const X = P?.exits || null; // skill 4: managed exits

  function closePos(s, pos, price, t, reason, i) {
    const fee = pos.qty * price * feePct(s);
    if (pos.dir > 0) cash += pos.qty * price - fee;
    else cash += pos.margin + (pos.entry - price) * pos.qty - fee;
    const gross = (price - pos.entry) * pos.qty * pos.dir + (pos.pGross || 0);
    const fees = pos.entryFee + fee + (pos.pFees || 0) + (pos.funding || 0);
    feesTotal += fee;
    const pnl = gross - fees;
    const tr = { ...pos, exit: price, exitTime: t, reason, pnl, fees, gross, R: pnl / pos.riskUSDT, bars: i - pos.entryIndex + 1 };
    if (pos.qty0) tr.qty = pos.qty0;
    delete tr.margin; delete tr.entryFee; delete tr.riskLeft; delete tr.best; delete tr.qty0;
    closed.push(tr);
    day(t).realized += pnl;
    if (pnl < 0) { cooldownUntil[s] = t + S.cooldownBars * BAR_MS; lossStreak++; } else lossStreak = 0;
    open.delete(s);
    events.push({ t, type: 'exit', symbol: s, id: pos.id, reason, pnl });
  }
  // take part of the position off (skill 4)
  function partial(s, pos, price, t, frac) {
    const q = pos.qty * frac, fee = q * price * feePct(s);
    if (pos.dir > 0) cash += q * price - fee;
    else cash += q * pos.entry + (pos.entry - price) * q - fee;
    pos.pGross = (pos.pGross || 0) + (price - pos.entry) * q * pos.dir;
    pos.pFees = (pos.pFees || 0) + fee;
    feesTotal += fee;
    pos.qty0 ??= pos.qty;
    pos.qty -= q; pos.margin -= q * pos.entry; pos.notionalLeft = pos.qty * pos.entry;
    pos.riskLeft = Math.max(0, pos.qty * (pos.entry - pos.stop) * pos.dir);
    pos.partialDone = true;
    events.push({ t, type: 'partial', symbol: s, id: pos.id });
  }

  // filters that don't depend on the account (the same for every signal)
  function gate(s, hit, t, pT, iT) {
    if (!P) return null;
    if (P.calendar) { const c = calendarBlock(t + BAR_MS, assetBySymbol[s]?.group, P.newsMin ?? 30); if (c) return c.reason; }
    if (P.regime) {
      if (!regimeAllows(hit.setup, hit.dir, hit.reg)) return 'regime';
      const g = assetBySymbol[s]?.group;
      if (lead && (g === 'crypto' || g === 'meme') && s !== 'BTCUSDT' && !leaderAllows(hit.dir, leadReg[leadIdx])) return 'leader';
    }
    return null;
  }

  const mark = (sig, d) => { if (sig.obs) sig.obs.dec = d; };
  function tryEnter(s, sig, p, i, t) {
    const dir = sig.dir;
    const blk = reason => { mark(sig, reason === 'analyst' || reason === 'learned' ? reason : 'other'); return block(reason, s, t); };
    const sl = slipOf(s, i);
    const fill = p.o[i] * (1 + dir * sl);
    const stop = sig.stop;
    if ((fill - stop) * dir <= 0) return blk('gap', s, t);
    const perUnit = Math.abs(fill - stop);
    const stopPct = perUnit / fill * 100;
    if (stopPct < S.minStopPct) return blk('tightStop', s, t);
    if (stopPct > S.maxStopPct) return blk('wideStop', s, t);
    // fees and slippage of the round trip, as a share of the risk: a trade they would eat is skipped
    if (S.maxCostR != null && (2 * feePct(s) + 2 * sl) * fill / perUnit > S.maxCostR) return blk('costly');
    if (open.size >= S.maxOpen) return blk('maxOpen', s, t);
    const d = day(t);
    if (d.trades >= S.maxTradesPerDay) return blk('perDay', s, t);
    const dailyLimit = startCap * S.dailyLossPct / 100;
    if (d.realized <= -dailyLimit) return blk('dailyLoss', s, t);
    if ((cooldownUntil[s] || 0) > t) return blk('cooldown', s, t);
    const eq = equityNow();
    // skill 3: portfolio risk. Correlated positions, drawdown brake, losing streaks.
    let riskMult = 1;
    const R3 = P?.risk;
    if (R3) {
      const cl = clusterOf(s);
      let same = 0; for (const [s2, pos] of open) if (pos.dir === dir && clusterOf(s2) === cl) same++;
      if (same >= R3.maxCluster) return blk('cluster');
      if (t < pauseUntil) return blk('ddStop');
      const dd = (brakePeak - eq) / brakePeak * 100;
      // a deep drawdown: stop for a day, like a trader stepping away, then start fresh
      if (dd >= R3.ddStop) { pauseUntil = t + 86400000; brakePeak = eq; return blk('ddStop'); }
      if (dd >= R3.ddHalf) riskMult *= 0.5;
      if (lossStreak >= R3.streak) riskMult *= 0.5;
    }
    // the analyst and the experience memory have their say
    let mult = 1, lj = null;
    if (LEARN) {
      lj = judge(L, { setup: sig.setup, group: assetBySymbol[s]?.group, grade: sig.ana?.grade, symbol: s, ana: sig.ana, reg: sig.obs?.reg, session: sig.obs?.session });
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
    let qty = (eq * S.riskPct * mult * riskMult / 100) / perUnit;
    const cap = Math.min(eq * S.maxPositionPct / 100, cash - eq * S.cashBufferPct / 100);
    let decidedBy = riskMult < 1 ? 'brake' : 'risk';
    if (qty * fill > cap) { qty = cap / fill; decidedBy = 'cap'; }
    if (qty <= 0 || qty * fill < S.minOrder) return blk('cash', s, t);
    const riskUSDT = qty * perUnit;
    const allowance = dailyLimit + Math.min(0, d.realized);
    if (openRisk() + riskUSDT > allowance) return blk('openRisk', s, t);
    if (R3 && openRisk() + riskUSDT > eq * R3.maxRiskPct / 100) return blk('riskCap');

    const notional = qty * fill;
    const entryFee = notional * feePct(s);
    feesTotal += entryFee;
    cash -= notional + entryFee; // a short ties up its notional as margin
    const pos = {
      id: nextId++, symbol: s, setup: sig.setup, dir, note: sig.note, signalTime: t - BAR_MS,
      entryTime: t, entryIndex: i, entry: fill, stop: smartRound(stop), target: smartRound(target),
      qty, notional, riskUSDT, entryFee, margin: notional, decidedBy, tm: sig.tm || null,
      ana: sig.ana || null, learn: lj && lj.ready ? { est: lj.est, mult, why: lj.why } : lj ? { why: lj.why } : null,
    };
    if (P) Object.assign(pos, { stop0: pos.stop, mae: 0, mfe: 0, best: fill, atr: sig.atr, reg: sig.obs?.reg ?? sig.reg ?? null, slip: sl, tf: P.tf || 5, brake: riskMult < 1 ? riskMult : null });
    open.set(s, pos);
    mark(sig, 'taken');
    d.trades++;
    events.push({ t, type: 'entry', symbol: s, id: pos.id, setup: sig.setup, dir });
  }

  const maxHold = Math.max(1, Math.round(S.maxHoldHours * 12));

  // the exit plan of one unit, followed bar by bar (the same rules the live desk uses)
  function simUnit(s, p, j, dir, entry, stop0, atrv) {
    const risk = (entry - stop0) * dir;
    const target = entry + dir * S.targetR * risk;
    const sl = slipOf(s, j);
    let stop = stop0, rem = 1, got = 0, part = false, best = entry, mae = 0, mfe = 0, k = j;
    for (; k < p.t.length && k < j + maxHold; k++) {
      const o = p.o[k], h = p.h[k], l = p.l[k], c = p.c[k];
      const fav = dir > 0 ? h : l, adv = dir > 0 ? l : h;
      mfe = Math.max(mfe, (fav - entry) * dir / risk); mae = Math.max(mae, (entry - adv) * dir / risk);
      if ((o - stop) * dir <= 0) return { R: got + rem * ((o * (1 - dir * sl) - entry) * dir / risk), k, mae, mfe, how: 'stop' };
      if (dir > 0 ? l <= stop : h >= stop) return { R: got + rem * ((stop * (1 - dir * sl) - entry) * dir / risk), k, mae, mfe, how: stop === stop0 ? 'stop' : 'trail' };
      if ((o - target) * dir >= 0) return { R: got + rem * ((o - entry) * dir / risk), k, mae, mfe, how: 'target' };
      if (dir > 0 ? h >= target : l <= target) return { R: got + rem * S.targetR, k, mae, mfe, how: 'target' };
      if (X && X.partial && !part && (fav - entry) * dir >= X.partial * risk) { const f = X.partialPct / 100; got += f * X.partial; rem -= f; part = true; }
      if (k === j + maxHold - 1) return { R: got + rem * ((c * (1 - dir * sl) - entry) * dir / risk), k, mae, mfe, how: 'time' };
      if (X) {
        if ((fav - best) * dir > 0) best = fav;
        stop = nextStop(stop, dir, entry, risk, best, atrv, s);
      }
    }
    return null; // not decided yet
  }
  // where the stop goes after a bar (skill 4)
  function nextStop(stop, dir, entry, risk, best, atrv, s) {
    const run = (best - entry) * dir / risk;
    let ns = stop;
    if (X.be != null && run >= X.be) { const be = entry + dir * entry * (2 * feePct(s)); ns = dir > 0 ? Math.max(ns, be) : Math.min(ns, be); }
    if (X.trail && run >= (X.trailFrom ?? 1) && atrv > 0) { const tr = best - dir * X.trail * atrv; ns = dir > 0 ? Math.max(ns, tr) : Math.min(ns, tr); }
    return ns;
  }

  // follow a signal forward to the bar where its outcome is decided (net of costs)
  function observe(s, p, i, t, hit) {
    const j = i + 1;
    if (j >= p.t.length) return null;
    const dir = hit.dir, entry = p.o[j], risk = (entry - hit.stop) * dir;
    if (!(risk > 0) || risk / entry * 100 < S.minStopPct || risk / entry * 100 > S.maxStopPct) return null;
    const sl = slipOf(s, j);
    const cost = (2 * feePct(s) + 2 * sl) * entry / risk;
    if (S.maxCostR != null && cost > S.maxCostR) return null; // a trade the robot would never take teaches nothing
    let R = null, k = j, extra = null;
    if (P) {
      const u = simUnit(s, p, j, dir, entry, hit.stop, hit.atr);
      if (!u) return null;
      R = u.R; k = u.k; extra = { reg: hit.reg || null, session: P.calendar ? sessionOf(t) : null, mae: u.mae, mfe: u.mfe };
    } else {
      const target = entry + dir * S.targetR * risk;
      for (; k < p.t.length && k < j + maxHold; k++) {
        if (dir > 0 ? p.l[k] <= hit.stop : p.h[k] >= hit.stop) { R = -1; break; }
        if (dir > 0 ? p.h[k] >= target : p.l[k] <= target) { R = S.targetR; break; }
        if (k === j + maxHold - 1) { R = (p.c[k] - entry) * dir / risk; break; }
      }
      if (R === null) return null; // not decided yet: nothing to learn
    }
    const o = { setup: hit.setup, group: assetBySymbol[s]?.group, symbol: s, grade: hit.ana?.grade, ana: hit.ana, R: R - cost, tRes: p.t[k] + BAR_MS, live: t >= start, dec: 'skipped', seq: seq++, t, dir };
    return extra ? Object.assign(o, extra) : o;
  }

  // derivatives context for the analyst (skill 8)
  const dxOf = (s, t) => {
    const d = deriv?.[s];
    if (!P?.deriv || !d) return P?.deriv ? {} : undefined;
    const f = lastAt(d.fund, t), oiNow = lastAt(d.oi, t - HOUR), oiBefore = lastAt(d.oi, t - 7 * HOUR);
    const p5 = preps[s], i = p5.idx.get(t - BAR_MS), i0 = p5.idx.get(t - BAR_MS - 6 * HOUR);
    return {
      fund: f && t - f[0] < 9 * HOUR ? f[1] : null,
      oiChg: oiNow && oiBefore && oiBefore[1] > 0 && t - oiNow[0] < 3 * HOUR ? oiNow[1] / oiBefore[1] - 1 : null,
      pxChg: i !== undefined && i0 !== undefined ? p5.c[i] / p5.c[i0] - 1 : 0,
    };
  };

  // one closed signal bar: scan, read the chart, filter, remember
  function signalAt(s, i, t, live) {
    let hit, pT = preps[s], iT = i;
    if (TF === BAR_MS) hit = scan(pT, i, setFor(s), scanStates[s]);
    else {
      if ((t + BAR_MS) % TF !== 0) return null;
      pT = prepT[s]; iT = pT.idx.get(t + BAR_MS - TF);
      if (iT === undefined) return null;
      hit = scan(pT, iT, setFor(s), scanStates[s]);
    }
    if (!hit) return null;
    if (P) { hit.atr = pT.atr14[iT]; if (P.regime) hit.reg = regimes(pT)[iT]; }
    if (ANALYST) hit.ana = analyze(pT, iT, hit, S, P?.deriv ? dxOf(s, t + BAR_MS) : undefined);
    hit.gate = gate(s, hit, t, pT, iT);
    return hit;
  }

  const FUND = P?.costs;
  for (const t of timeline) {
    const live = t >= start;
    if (lead) { const T = t + BAR_MS - TF, li = lead.idx.get(T); if (li !== undefined && (TF === BAR_MS || (t + BAR_MS) % TF === 0)) leadIdx = li; }
    if (LEARN && waiting.length) {
      const ready = [];
      for (let k = waiting.length - 1; k >= 0; k--) if (waiting[k].tRes <= t) { ready.push(waiting[k]); waiting.splice(k, 1); }
      ready.sort((a, b) => a.tRes - b.tRes || a.seq - b.seq).forEach(o => learn(L, o));
    }
    for (const s of syms) {
      const p = preps[s];
      const i = p.idx.get(t);
      if (i === undefined) continue;
      if (!live || evalOnly) { // warm-up (or validation): watch and learn, no trading
        const hit = signalAt(s, i, t, live);
        if (hit) {
          const o = observe(s, p, i, t, hit);
          if (o) { if (hit.gate) o.dec = 'filtered:' + hit.gate; if (evalOnly && live) observed.push(o); if (LEARN && !hit.gate) waiting.push(o); }
        }
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
        if (!P) {
          if ((o - pos.stop) * dir <= 0) closePos(s, pos, o * (1 - dir * slip), t, 'stop', i);
          else if ((dir > 0 ? l <= pos.stop : h >= pos.stop)) closePos(s, pos, pos.stop * (1 - dir * slip), t, 'stop', i);
          else if ((o - pos.target) * dir >= 0) closePos(s, pos, o, t, 'target', i);
          else if ((dir > 0 ? h >= pos.target : l <= pos.target)) closePos(s, pos, pos.target, t, 'target', i);
          else if (i - pos.entryIndex + 1 >= maxHold) closePos(s, pos, c * (1 - dir * slip), t + BAR_MS, 'time', i);
        } else managePro(s, pos, p, i, t, o, h, l, c);
      }
      lastClose[s] = p.c[i];

      // 3) scan the closed bar for a new setup
      const hit = signalAt(s, i, t, live);
      if (hit) {
        signals++;
        sigList.push({ s, i, t, hit });
        const obs = LEARN || ANALYST || P ? observe(s, p, i, t, hit) : null;
        if (obs) { if (hit.gate) obs.dec = 'filtered:' + hit.gate; observed.push(obs); if (LEARN && !hit.gate) waiting.push(obs); }
        if (hit.gate) { block(hit.gate, s, t); continue; }
        if (!open.has(s) && t + BAR_MS < end) pending.set(s, { ...hit, time: t, obs });
      }
    }
    if (!live || evalOnly) continue;
    const e = equityNow();
    if (e > peak) peak = e;
    if (e > brakePeak) brakePeak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDusd = peak - e; }
    equity.push([t + BAR_MS, e]);
  }

  // the pro desk manages a position like a trader: funding, part profit, break-even, trailing stop
  function managePro(s, pos, p, i, t, o, h, l, c) {
    const dir = pos.dir, risk0 = Math.abs(pos.entry - pos.stop0), sl = pos.slip;
    if (FUND && assetBySymbol[s]?.market === 'futures' && t % FUND_EVERY === 0 && t > pos.entryTime) {
      const fr = lastAt(deriv?.[s]?.fund, t);
      const rate = fr && t - fr[0] < HOUR ? fr[1] : DEFAULT_FUNDING;
      const pay = pos.qty * o * rate * dir; // longs pay a positive rate, shorts receive it
      cash -= pay; pos.funding = (pos.funding || 0) + pay; fundingTotal += pay; feesTotal += pay;
    }
    const fav = dir > 0 ? h : l, adv = dir > 0 ? l : h;
    pos.mfe = Math.max(pos.mfe, (fav - pos.entry) * dir / risk0); pos.mae = Math.max(pos.mae, (pos.entry - adv) * dir / risk0);
    if ((o - pos.stop) * dir <= 0) return closePos(s, pos, o * (1 - dir * sl), t, pos.stop === pos.stop0 ? 'stop' : 'trail', i);
    if (dir > 0 ? l <= pos.stop : h >= pos.stop) return closePos(s, pos, pos.stop * (1 - dir * sl), t, pos.stop === pos.stop0 ? 'stop' : 'trail', i);
    if ((o - pos.target) * dir >= 0) return closePos(s, pos, o, t, 'target', i);
    if (dir > 0 ? h >= pos.target : l <= pos.target) return closePos(s, pos, pos.target, t, 'target', i);
    if (X && X.partial && !pos.partialDone && (fav - pos.entry) * dir >= X.partial * risk0) partial(s, pos, pos.entry + dir * X.partial * risk0, t, X.partialPct / 100);
    if (i - pos.entryIndex + 1 >= maxHold) return closePos(s, pos, c * (1 - dir * sl), t + BAR_MS, 'time', i);
    if (X) {
      if ((fav - pos.best) * dir > 0) pos.best = fav;
      const ns = nextStop(pos.stop, dir, pos.entry, risk0, pos.best, pos.atr, s);
      if (ns !== pos.stop) { pos.stop = smartRound(ns); pos.riskLeft = Math.max(0, pos.qty * (pos.entry - pos.stop) * dir); }
    }
  }

  const lastT = timeline.length ? timeline[timeline.length - 1] + BAR_MS : start;
  if (evalOnly) return { observed: observed.filter(o => o.tRes <= lastT), start, end, lastTime: lastT };
  // how the decisions turned out: trades taken vs. signals the filters, analyst or memory refused
  let decisions = null;
  if (ANALYST || P) {
    decisions = {};
    for (const o of observed) {
      if (o.tRes > lastT) continue;
      const k = o.dec.startsWith('filtered') ? 'filtered' : o.dec;
      const d = decisions[k] ??= { n: 0, sumR: 0, wins: 0 };
      d.n++; d.sumR += o.R; if (o.R > 0) d.wins++;
    }
  }
  const learnSummary = LEARN ? summary(L, Object.keys(S.strategies).filter(k => S.strategies[k]), [...new Set(syms.map(s => assetBySymbol[s]?.group))]) : null;
  return {
    analyst: ANALYST, learn: learnSummary, decisions, pro: !!P,
    start, end, lastTime: lastT, capital: startCap, cash, feesTotal, fundingTotal, maxDD, maxDDusd, signals,
    closed, open: [...open.values()], equity, events, blocked, lastClose,
    symbols: syms, bars: timeline.length,
    sigEval: evaluateSignals(sigList, preps, S, maxHold, end, P ? (s, p, j, dir, entry, stop, atrv) => simUnit(s, p, j, dir, entry, stop, atrv) : null),
  };
}

// average traded value per 5-minute bar over the last day (for slippage)
function turnover(s) {
  const n = s.t.length, out = new Float64Array(n), W = 288;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += s.v[i] * s.c[i];
    if (i >= W) sum -= s.v[i - W] * s.c[i - W];
    out[i] = sum / Math.min(i + 1, W);
  }
  return out;
}

// Close whatever is still open at the last close (end of the test).
export function closeAllAtEnd(res, settings) {
  const fee = s => (assetBySymbol[s]?.market === 'futures' ? settings.feeFuturesPct : settings.feeSpotPct) / 100;
  for (const pos of res.open) {
    const price = res.lastClose[pos.symbol] ?? pos.entry;
    const exitFee = pos.qty * price * fee(pos.symbol);
    const gross = (price - pos.entry) * pos.qty * pos.dir + (pos.pGross || 0);
    const fees = pos.entryFee + exitFee + (pos.pFees || 0) + (pos.funding || 0);
    res.cash += pos.dir > 0 ? pos.qty * price - exitFee : pos.margin + (pos.entry - price) * pos.qty - exitFee;
    res.feesTotal += exitFee;
    const tr = { ...pos, exit: price, exitTime: res.lastTime, reason: 'end', pnl: gross - fees, fees, gross, R: (gross - fees) / pos.riskUSDT };
    if (pos.qty0) tr.qty = pos.qty0;
    delete tr.margin; delete tr.entryFee; delete tr.riskLeft; delete tr.best; delete tr.qty0;
    res.closed.push(tr);
  }
  res.open = [];
  return res;
}

// Unrealized P&L of an open position at a price (including any part already taken).
export function unrealized(pos, price) { return (price - pos.entry) * pos.qty * pos.dir - pos.entryFee + (pos.pGross || 0) - (pos.pFees || 0) - (pos.funding || 0); }

export function computeStats(res, prices = {}) {
  const tr = res.closed;
  const wins = tr.filter(x => x.pnl > 0), losses = tr.filter(x => x.pnl <= 0);
  const realized = tr.reduce((a, x) => a + x.pnl, 0);
  let unreal = 0, openValue = 0;
  for (const pos of res.open) {
    const px = prices[pos.symbol] ?? res.lastClose[pos.symbol] ?? pos.entry;
    unreal += (px - pos.entry) * pos.qty * pos.dir + (pos.pGross || 0) - (pos.pFees || 0) - (pos.funding || 0);
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
    fees: res.feesTotal, funding: res.fundingTotal || 0, maxDD: res.maxDD, maxDDusd: res.maxDDusd,
    bySetup: by('setup'), bySymbol: by('symbol'),
    byReason: by('reason'), openCount: res.open.length,
  };
}

// Signal accuracy: every scanner signal is checked on its own, as if taken with
// the exit plan, whether or not the risk rules let the robot trade it. Entry at
// the next bar's open, stop first on a bar that touches both (like trader-timemachine).
export function evaluateSignals(list, preps, S, maxHold, end, unit = null) {
  const out = [];
  for (const { s, i, t, hit } of list) {
    const p = preps[s];
    const j = i + 1;
    if (j >= p.t.length || p.t[j] >= end) { out.push({ symbol: s, setup: hit.setup, t, outcome: 'pending' }); continue; }
    const dir = hit.dir, entry = p.o[j], stop = hit.stop;
    const risk = (entry - stop) * dir;
    if (!(risk > 0) || risk / entry * 100 < S.minStopPct || risk / entry * 100 > S.maxStopPct) { out.push({ symbol: s, setup: hit.setup, t, outcome: 'invalid' }); continue; }
    if (unit) { // the pro desk: the same managed exits as the live trades
      const u = unit(s, p, j, dir, entry, stop, hit.atr);
      if (!u || p.t[u.k] >= end) { out.push({ symbol: s, setup: hit.setup, t, outcome: 'pending' }); continue; }
      out.push({ symbol: s, setup: hit.setup, t, outcome: u.how === 'trail' ? (u.R > 0 ? 'target' : 'stop') : u.how, R: u.R, gate: hit.gate || null });
      continue;
    }
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
