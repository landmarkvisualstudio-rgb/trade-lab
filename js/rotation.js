// Momentum rotation: a slower way to trade many coins at once.
// Every few hours the coins are ranked by how strongly they have risen over a
// lookback window; the robot holds the strongest few, each with a trailing stop,
// and swaps out the ones that fall out of the leading group. Optionally bitcoin is
// the market filter: when bitcoin is below its 20-day average the robot stays in cash.
// Hourly bars, no lookahead: decisions use closed bars only and fill at the next open.
// Deterministic: the same candles and settings give the same trades on any device.
const H = 3600000;

export const ROT_DEFAULTS = { lookH: 168, top: 10, rebH: 24, keepMult: 2, trail: 0.15, btcFilter: true, minVolH: 150000, riskCash: 0.02 };
// what the robot tries when a test starts (it keeps the best of the last 60 days)
export const ROT_GRID = (() => {
  const g = [];
  for (const lookH of [72, 168, 336]) for (const top of [5, 10]) for (const trail of [0.08, 0.15]) for (const btcFilter of [true, false]) g.push({ lookH, top, rebH: 24, trail, btcFilter });
  return g;
})();
export const ROT_WARM_H = 672 + 48; // hourly bars needed before the start (the longest lookback plus margin)

function sma(a, n) {
  const out = new Float64Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}

// series: {SYM: {t,o,h,l,c,v}} hourly. closeAtEnd: sell what is held at the last close
// (for a finished test or research); otherwise open positions are returned as open.
export function runRotation({ series, start, end, params = {}, capital = 1000, feePct = 0.1, slipBase = 0.0005, closeAtEnd = true }) {
  const P = { ...ROT_DEFAULTS, ...params };
  const fee = feePct / 100;
  const syms = Object.keys(series).filter(s => series[s] && series[s].t.length > Math.min(P.lookH + 30, 200)).sort();
  const idx = {}, turn = {}, trend = {};
  for (const s of syms) {
    const S = series[s], m = new Map();
    for (let i = 0; i < S.t.length; i++) m.set(S.t[i], i);
    idx[s] = m;
    turn[s] = sma(S.v.map((v, i) => v * S.c[i]), 24 * 7);
    trend[s] = sma(S.c, P.lookH);
  }
  const btc = series.BTCUSDT, bIdx = btc ? idx.BTCUSDT || new Map(btc.t.map((t, i) => [t, i])) : null;
  const bSma = btc ? sma(btc.c, 24 * 20) : null;
  const slipOf = (s, i) => Math.min(0.004, Math.max(slipBase, slipBase * Math.sqrt(1e6 / Math.max(1, turn[s][i] || 0))));

  let cash = capital, peak = capital, maxDD = 0, maxDDusd = 0, fees = 0, rebalances = 0, marketOff = 0, nextId = 1;
  const pos = new Map(), closed = [], equity = [], events = [], lastClose = {};
  const markPx = (s, p, t) => { const i = idx[s].get(t); return i !== undefined ? series[s].o[i] : p.last; };
  const value = t => { let e = cash; for (const [s, p] of pos) e += p.qty * markPx(s, p, t); return e; };
  const sell = (s, p, px, t, why) => {
    const gross = p.qty * px, f = gross * fee; cash += gross - f; fees += f;
    const pnl = gross - f - p.cost;
    const risk = p.cost * P.trail;
    closed.push({ id: p.id, symbol: s, setup: 'momentum', dir: 1, entryTime: p.t, exitTime: t, entry: p.entry, exit: px, qty: p.qty, notional: p.cost, riskUSDT: risk, stop: p.high * (1 - P.trail), target: null, pnl, R: pnl / risk, fees: p.fee0 + f, gross: gross - p.cost + p.fee0, reason: why, rank: p.rank, mom: p.mom });
    events.push({ t, type: 'exit', symbol: s, id: p.id, reason: why, pnl });
    pos.delete(s);
  };

  for (let t = Math.ceil(start / H) * H; t < end; t += H) {
    // 1) trailing stops on the bar that opens at t (stop first, at the stop or the gap)
    for (const [s, p] of [...pos]) {
      const i = idx[s].get(t); if (i === undefined) continue;
      const S = series[s];
      const stop = p.high * (1 - P.trail);
      if (S.o[i] <= stop) sell(s, p, S.o[i] * (1 - slipOf(s, i)), t, 'trail');
      else if (S.l[i] <= stop) sell(s, p, stop * (1 - slipOf(s, i)), t, 'trail');
      else { p.high = Math.max(p.high, S.h[i]); p.last = S.c[i]; }
    }
    // 2) rebalance, using bars closed before t, filled at the open of the bar at t
    if (t % (P.rebH * H) === 0) {
      rebalances++;
      let marketOk = true;
      if (P.btcFilter && btc) { const bi = bIdx.get(t - H); marketOk = bi !== undefined && btc.c[bi] > bSma[bi]; }
      if (!marketOk) marketOff++;
      const ranked = [];
      for (const s of syms) {
        const i = idx[s].get(t - H); if (i === undefined || i < P.lookH) continue;
        const S = series[s];
        if (!(turn[s][i] >= P.minVolH)) continue;
        const r = S.c[i] / S.c[i - P.lookH] - 1;
        if (r > 0 && S.c[i] > trend[s][i]) ranked.push([s, r]);
      }
      ranked.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const lead = ranked.slice(0, P.top), keep = new Set(ranked.slice(0, P.top * P.keepMult).map(x => x[0]));
      for (const [s, p] of [...pos]) {
        if (!marketOk || !keep.has(s)) { const i = idx[s].get(t); if (i !== undefined) sell(s, p, series[s].o[i] * (1 - slipOf(s, i)), t, marketOk ? 'rotate' : 'market'); }
      }
      if (marketOk) {
        const eq = value(t), slot = eq / P.top;
        lead.forEach(([s, r], rank) => {
          if (pos.has(s) || pos.size >= P.top) return;
          const i = idx[s].get(t); if (i === undefined) return;
          const px = series[s].o[i] * (1 + slipOf(s, i));
          const spend = Math.min(slot, cash - eq * P.riskCash);
          if (spend < 5) return;
          const f = spend * fee, qty = (spend - f) / px;
          cash -= spend; fees += f;
          const id = nextId++;
          pos.set(s, { id, qty, entry: px, cost: spend, fee0: f, t, high: px, last: px, rank: rank + 1, mom: r });
          events.push({ t, type: 'entry', symbol: s, id, setup: 'momentum', dir: 1 });
        });
      }
    }
    const e = value(t);
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd * 100 > maxDD) { maxDD = dd * 100; maxDDusd = peak - e; }
    equity.push([t + H, e]);
  }
  const last = Math.ceil(start / H) * H <= end - H ? end - H : start;
  for (const s of syms) { const S = series[s]; let i = idx[s].get(last); if (i === undefined) { i = S.t.length - 1; while (i > 0 && S.t[i] > last) i--; } if (i >= 0) lastClose[s] = S.c[i]; }
  if (closeAtEnd) for (const [s, p] of [...pos]) sell(s, p, lastClose[s] ?? p.last, end, 'end');
  const open = [...pos].map(([s, p]) => ({ id: p.id, symbol: s, setup: 'momentum', dir: 1, entryTime: p.t, entry: p.entry, qty: p.qty, notional: p.cost, margin: p.cost, entryFee: p.fee0, riskUSDT: p.cost * P.trail, stop: p.high * (1 - P.trail), target: null, rank: p.rank, mom: p.mom }));
  const wins = closed.filter(x => x.pnl > 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -closed.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  return {
    kind: 'rotation', params: P, start, end, lastTime: end, capital, cash, feesTotal: fees, fundingTotal: 0, maxDD, maxDDusd,
    closed, open, equity, events, lastClose, blocked: {}, signals: rebalances, rebalances, marketOff,
    symbols: syms, ret: (value(last) / capital - 1) * 100, n: closed.length,
    winRate: closed.length ? wins.length / closed.length * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0,
  };
}

// choose settings from recent history only: the best return for its drawdown
export function pickRotation({ series, start, end, capital = 1000 }) {
  let best = null;
  const rows = ROT_GRID.map(p => {
    const r = runRotation({ series, start, end, params: p, capital });
    const score = r.ret / Math.max(5, r.maxDD);
    const row = { p, ret: r.ret, dd: r.maxDD, n: r.n, pf: r.pf, score };
    if (!best || score > best.score) best = row;
    return row;
  });
  return { best, rows };
}
