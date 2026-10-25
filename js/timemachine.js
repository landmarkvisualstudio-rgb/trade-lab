// trader-timemachine: replay the rest of a trade many times from the asset's own
// recent bars (bootstrap of bar shapes), seeded so every run can be repeated.
import { rng } from './indicators.js';

export function replay(p, i, { entry, stop, target, dir, horizon, replays = 1000, seed = 19, pool = 1000 }) {
  const from = Math.max(1, i - pool + 1);
  const n = i - from + 1;
  if (n < 100 || horizon < 1) return null;
  const rand = rng(seed);
  const risk = Math.abs(entry - stop);
  let tHit = 0, sHit = 0, neither = 0, sumR = 0;
  const finals = new Float64Array(replays);
  for (let r = 0; r < replays; r++) {
    let price = entry, out = 0, R = 0;
    for (let k = 0; k < horizon; k++) {
      const j = from + Math.floor(rand() * n);
      const pc = p.c[j - 1];
      const hi = price * p.h[j] / pc, lo = price * p.l[j] / pc, cl = price * p.c[j] / pc;
      // stop first, like the skill: a bar that touches both counts as the stop
      if (dir > 0 ? lo <= stop : hi >= stop) { out = -1; R = -1; break; }
      if (dir > 0 ? hi >= target : lo <= target) { out = 1; R = Math.abs(target - entry) / risk; break; }
      price = cl;
    }
    if (out === 0) { neither++; R = (price - entry) * dir / risk; finals[r] = price; }
    else { finals[r] = out > 0 ? target : stop; if (out > 0) tHit++; else sHit++; }
    sumR += R;
  }
  finals.sort();
  const targetR = Math.abs(target - entry) / risk;
  return {
    replays, seed, horizon,
    pTarget: tHit / replays, pStop: sHit / replays, pNeither: neither / replays,
    avgR: sumR / replays,
    median: finals[Math.floor(replays / 2)], p5: finals[Math.floor(replays * 0.05)], p95: finals[Math.floor(replays * 0.95)],
    ...verdict(tHit, sHit, targetR),
  };
}

// Same rule as the skill: how often the target came first among replays that hit
// a side, against break-even 1 / (1 + R).
export function verdict(t, s, R) {
  const be = 1 / (1 + R);
  if (t + s === 0) return { edge: 0, verdict: 'هیچ‌کدام از دو طرف لمس نشد', lean: 0 };
  const share = t / (t + s);
  const edge = (share - be) * 100;
  const a = Math.abs(edge);
  let text;
  if (a < 5) text = R === 1 ? 'تقریباً شیر یا خط' : 'نزدیک نقطه‌ی سربه‌سر';
  else if (a < 15) text = edge > 0 ? 'متمایل به هدف' : 'متمایل به حد ضرر';
  else text = edge > 0 ? 'به‌شدت متمایل به هدف' : 'به‌شدت متمایل به حد ضرر';
  return { edge, verdict: text, share, breakeven: be };
}
