// Small canvas charts with no outside library: candles + volume + averages,
// pan / zoom / crosshair (mouse and touch), trade markers and price lines.
import { sma } from './indicators.js';

const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
const fmtTime = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { month: 'short', day: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function priceDecimals(p) {
  const a = Math.abs(p);
  return a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
}
const fmtP = (p, d) => p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function setupCanvas(container) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const size = { w: 0, h: 0, dpr: 1 };
  const resize = () => {
    const r = container.getBoundingClientRect();
    size.dpr = window.devicePixelRatio || 1;
    size.w = Math.max(50, r.width); size.h = Math.max(50, r.height);
    canvas.width = Math.round(size.w * size.dpr); canvas.height = Math.round(size.h * size.dpr);
  };
  resize();
  return { canvas, ctx, size, resize };
}

export function createCandleChart(container, opts = {}) {
  const { canvas, ctx, size, resize } = setupCanvas(container);
  let rows = [], markers = [], lines = [], ma20 = [], ma50 = [];
  let barW = opts.barWidth || 8;           // px per bar
  let rightIndex = null;                   // index at the right edge (float); null = follow the last bar
  let hover = null;
  const showMA = opts.showMA !== false;

  const P = { top: 12, bottom: 26, right: 70, left: 8 };

  function visible() {
    const n = rows.length;
    const plotW = size.w - P.left - P.right;
    const count = plotW / barW;
    const right = rightIndex == null ? n - 1 + 2 : rightIndex;
    return { from: Math.max(0, Math.floor(right - count)), to: Math.min(n - 1, Math.ceil(right)), right, count, plotW };
  }
  const xOf = (i, v) => P.left + v.plotW - (v.right - i) * barW;

  function draw() {
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const C = {
      grid: css(container, '--chart-grid') || 'rgba(128,128,128,.12)', text: css(container, '--muted') || '#889',
      up: css(container, '--up') || '#22c38e', down: css(container, '--down') || '#f0506e',
      fg: css(container, '--fg') || '#fff', accent: css(container, '--accent') || '#7aa2ff',
      ma1: css(container, '--ma1') || '#f5b942', ma2: css(container, '--ma2') || '#9b8cff', panel: css(container, '--chart-label') || 'rgba(20,30,60,.9)',
    };
    if (!rows.length) {
      ctx.fillStyle = C.text; ctx.font = '13px Vazirmatn, Tahoma, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(opts.emptyText || 'در حال بارگذاری…', w / 2, h / 2); return;
    }
    const v = visible();
    const volH = (h - P.top - P.bottom) * 0.18;
    const priceH = h - P.top - P.bottom - volH - 6;
    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (let i = v.from; i <= v.to; i++) { const r = rows[i]; if (r[3] < lo) lo = r[3]; if (r[2] > hi) hi = r[2]; if (r[5] > vmax) vmax = r[5]; }
    for (const ln of lines) { if (ln.price < lo && ln.price > lo - (hi - lo)) lo = ln.price; if (ln.price > hi && ln.price < hi + (hi - lo)) hi = ln.price; }
    const pad = (hi - lo) * 0.08 || hi * 0.001 || 1; lo -= pad; hi += pad;
    const yOf = p => P.top + (hi - p) / (hi - lo) * priceH;
    const dec = priceDecimals(rows[rows.length - 1][4]);

    // grid + price axis
    ctx.font = '11px Vazirmatn, Tahoma, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const step = niceStep((hi - lo) / 5);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text;
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(w - P.right, y); ctx.stroke();
      ctx.fillText(fmtP(p, dec), w - P.right + 6, y);
    }
    // time axis
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.max(1, Math.round(90 / barW));
    const spanMs = rows.length > 1 ? rows[rows.length - 1][0] - rows[0][0] : 0;
    const perBar = rows.length > 1 ? spanMs / (rows.length - 1) : 300000;
    for (let i = v.from; i <= v.to; i++) {
      if (i % every) continue;
      const x = xOf(i, v);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, P.top); ctx.lineTo(Math.round(x) + 0.5, h - P.bottom); ctx.stroke();
      const d = new Date(rows[i][0]);
      ctx.fillText(perBar >= 3600000 * 4 ? fmtDay.format(d) : fmtTime.format(d), x, h - P.bottom + 7);
    }
    // candles + volume
    const bw = Math.max(1, barW * 0.68);
    for (let i = v.from; i <= v.to; i++) {
      const [, o, hh, ll, c, vol] = rows[i];
      const x = xOf(i, v);
      const col = c >= o ? C.up : C.down;
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.globalAlpha = 0.28;
      const vh = vmax ? vol / vmax * volH : 0;
      ctx.fillRect(x - bw / 2, h - P.bottom - vh, bw, vh);
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yOf(hh)); ctx.lineTo(Math.round(x) + 0.5, yOf(ll)); ctx.stroke();
      const y1 = yOf(Math.max(o, c)), y2 = yOf(Math.min(o, c));
      ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }
    // moving averages
    if (showMA) for (const [arr, col] of [[ma20, C.ma1], [ma50, C.ma2]]) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
      for (let i = v.from; i <= v.to; i++) { if (isNaN(arr[i])) continue; const x = xOf(i, v), y = yOf(arr[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // price lines (open position: entry / stop / target)
    ctx.textBaseline = 'middle';
    for (const ln of lines) {
      const y = Math.round(yOf(ln.price)) + 0.5;
      if (y < P.top || y > P.top + priceH) continue;
      ctx.strokeStyle = ln.color; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(w - P.right, y); ctx.stroke(); ctx.setLineDash([]);
      label(w - P.right + 2, y, fmtP(ln.price, dec), ln.color, '#fff');
      if (ln.text) { ctx.fillStyle = ln.color; ctx.textAlign = 'left'; ctx.font = '11px Vazirmatn, Tahoma, sans-serif'; ctx.fillText(ln.text, P.left + 6, y - 9); }
    }
    // last price
    const last = rows[rows.length - 1];
    const ly = Math.round(yOf(last[4])) + 0.5;
    const lc = last[4] >= last[1] ? C.up : C.down;
    ctx.strokeStyle = lc; ctx.globalAlpha = 0.6; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(P.left, ly); ctx.lineTo(w - P.right, ly); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    label(w - P.right + 2, ly, fmtP(last[4], dec), lc, '#fff');
    // trade markers
    for (const m of markers) {
      const i = indexAt(m.time);
      if (i < v.from || i > v.to) continue;
      const x = xOf(i, v), y = yOf(m.price);
      ctx.fillStyle = m.color; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (m.shape === 'up') { ctx.moveTo(x, y + 3); ctx.lineTo(x - 6, y + 13); ctx.lineTo(x + 6, y + 13); }
      else if (m.shape === 'down') { ctx.moveTo(x, y - 3); ctx.lineTo(x - 6, y - 13); ctx.lineTo(x + 6, y - 13); }
      else ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // crosshair
    if (hover && hover.x > P.left && hover.x < w - P.right && hover.y > P.top && hover.y < h - P.bottom) {
      const i = Math.round(v.right - (P.left + v.plotW - hover.x) / barW);
      if (i >= 0 && i < rows.length) {
        const x = xOf(i, v);
        ctx.strokeStyle = C.text; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, P.top); ctx.lineTo(x, h - P.bottom); ctx.moveTo(P.left, hover.y); ctx.lineTo(w - P.right, hover.y); ctx.stroke(); ctx.setLineDash([]);
        const p = hi - (hover.y - P.top) / priceH * (hi - lo);
        if (hover.y < P.top + priceH) label(w - P.right + 2, hover.y, fmtP(p, dec), C.panel, C.fg);
        const r = rows[i];
        const chg = (r[4] / r[1] - 1) * 100;
        const txt = `${fmtFull.format(new Date(r[0]))}   O ${fmtP(r[1], dec)}  H ${fmtP(r[2], dec)}  L ${fmtP(r[3], dec)}  C ${fmtP(r[4], dec)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
        ctx.font = '11px Vazirmatn, Tahoma, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const tw = Math.min(ctx.measureText(txt).width + 14, w - P.right - P.left);
        ctx.fillStyle = C.panel; roundRect(P.left + 2, P.top, tw, 20, 6); ctx.fill();
        ctx.fillStyle = C.fg; ctx.fillText(txt, P.left + 9, P.top + 4, tw - 14);
      }
    }
    function label(x, y, text, bg, fg) {
      ctx.font = '11px Vazirmatn, Tahoma, sans-serif';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = bg; roundRect(x, y - 9, Math.max(tw, P.right - 4), 18, 5); ctx.fill();
      ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 5, y);
    }
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function indexAt(t) {
    let a = 0, b = rows.length - 1;
    while (a < b) { const m = (a + b + 1) >> 1; if (rows[m][0] <= t) a = m; else b = m - 1; }
    return a;
  }

  // interaction
  let drag = null, pinch = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pointers = new Map();
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, pos(e));
    if (pointers.size === 1) { const v = visible(); drag = { x: pos(e).x, right: v.right }; }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.abs(a.x - b.x) || 1, barW }; drag = null; }
  });
  canvas.addEventListener('pointermove', e => {
    const p = pos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      barW = clamp(pinch.barW * (Math.abs(a.x - b.x) || 1) / pinch.d, 2, 40);
    } else if (drag) {
      const dx = p.x - drag.x;
      if (Math.abs(dx) > 3 || e.pointerType === 'mouse') rightIndex = clamp(drag.right - dx / barW, 10, rows.length + 20);
      if (e.pointerType !== 'mouse') hover = null; else hover = p;
    } else hover = p;
    schedule();
  });
  const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) drag = null; };
  canvas.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse' && drag && Math.abs(pos(e).x - drag.x) < 4) hover = pos(e); up(e); schedule(); });
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hover = null; schedule(); } });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const v = visible(); rightIndex = clamp(v.right + e.deltaX / barW, 10, rows.length + 20); }
    else barW = clamp(barW * (e.deltaY > 0 ? 0.9 : 1.1), 2, 40);
    schedule();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { rightIndex = null; barW = opts.barWidth || 8; schedule(); });

  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(container);

  return {
    setData(r) { rows = r; const c = r.map(x => x[4]); ma20 = sma(c, 20); ma50 = sma(c, 50); schedule(); },
    updateLast(price) {
      if (!rows.length) return; const r = rows[rows.length - 1];
      r[4] = price; if (price > r[2]) r[2] = price; if (price < r[3]) r[3] = price; schedule();
    },
    setMarkers(m) { markers = m; schedule(); },
    setLines(l) { lines = l; schedule(); },
    reset() { rightIndex = null; schedule(); },
    redraw: schedule,
    destroy() { ro.disconnect(); canvas.remove(); },
  };
}

// Area chart for the equity curve, with the starting capital as a baseline.
export function createAreaChart(container, opts = {}) {
  const { canvas, ctx, size, resize } = setupCanvas(container);
  canvas.style.cursor = 'default';
  let pts = [], base = opts.base ?? 0, hover = null;
  const P = { top: 10, bottom: 22, right: 58, left: 6 };
  function draw() {
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const C = { grid: css(container, '--chart-grid'), text: css(container, '--muted'), up: css(container, '--up'), down: css(container, '--down'), fg: css(container, '--fg'), panel: css(container, '--chart-label') };
    if (pts.length < 2) {
      ctx.fillStyle = C.text; ctx.font = '13px Vazirmatn, Tahoma, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(opts.emptyText || 'هنوز داده‌ای نیست', w / 2, h / 2); return;
    }
    let lo = base, hi = base;
    for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    const pad = (hi - lo) * 0.12 || Math.max(1, base * 0.002); lo -= pad; hi += pad;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const xOf = t => P.left + (t - t0) / (t1 - t0 || 1) * (w - P.left - P.right);
    const yOf = v => P.top + (hi - v) / (hi - lo) * (h - P.top - P.bottom);
    ctx.font = '10.5px Vazirmatn, Tahoma, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const step = niceStep((hi - lo) / 4);
    ctx.strokeStyle = C.grid; ctx.fillStyle = C.text; ctx.lineWidth = 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = Math.round(yOf(v)) + 0.5; ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(w - P.right, y); ctx.stroke();
      ctx.fillText(v.toLocaleString('en-US', { maximumFractionDigits: step < 1 ? 2 : 0 }), w - P.right + 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const days = (t1 - t0) / 86400000;
    for (let k = 0; k <= 4; k++) { const t = t0 + (t1 - t0) * k / 4; ctx.fillText((days > 1.5 ? fmtDay : fmtTime).format(new Date(t)), clamp(xOf(t), 24, w - P.right - 20), h - P.bottom + 6); }
    const last = pts[pts.length - 1][1];
    const col = last >= base ? C.up : C.down;
    const yb = yOf(base);
    const grad = ctx.createLinearGradient(0, P.top, 0, h - P.bottom);
    grad.addColorStop(0, hexA(col, 0.35)); grad.addColorStop(1, hexA(col, 0.02));
    ctx.beginPath(); ctx.moveTo(xOf(pts[0][0]), yb);
    for (const p of pts) ctx.lineTo(xOf(p[0]), yOf(p[1]));
    ctx.lineTo(xOf(t1), yb); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((p, k) => k ? ctx.lineTo(xOf(p[0]), yOf(p[1])) : ctx.moveTo(xOf(p[0]), yOf(p[1])));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = C.text; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(P.left, Math.round(yb) + .5); ctx.lineTo(w - P.right, Math.round(yb) + .5); ctx.stroke(); ctx.setLineDash([]);
    if (hover) {
      let a = 0, b = pts.length - 1; const tt = t0 + (hover.x - P.left) / (w - P.left - P.right) * (t1 - t0);
      while (a < b) { const m = (a + b) >> 1; if (pts[m][0] < tt) a = m + 1; else b = m; }
      const p = pts[a]; const x = xOf(p[0]), y = yOf(p[1]);
      ctx.strokeStyle = C.text; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, P.top); ctx.lineTo(x, h - P.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
      const txt = `${fmtFull.format(new Date(p[0]))}  ·  ${p[1].toFixed(2)} USDT`;
      ctx.font = '11px Vazirmatn, Tahoma, sans-serif'; const tw = ctx.measureText(txt).width + 14;
      const bx = clamp(x - tw / 2, P.left, w - P.right - tw);
      ctx.fillStyle = C.panel; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, P.top, tw, 20, 6) : ctx.rect(bx, P.top, tw, 20); ctx.fill();
      ctx.fillStyle = C.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, bx + 7, P.top + 10);
    }
  }
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointermove', e => { hover = pos(e); draw(); });
  canvas.addEventListener('pointerdown', e => { hover = pos(e); draw(); });
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  const ro = new ResizeObserver(() => { resize(); draw(); }); ro.observe(container);
  return { setData(p, b) { pts = p; if (b != null) base = b; draw(); }, redraw: draw, destroy() { ro.disconnect(); canvas.remove(); } };
}

function hexA(color, a) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// tiny sparkline as an SVG path string
export function sparkPath(values, w = 80, h = 26) {
  if (!values || values.length < 2) return '';
  let lo = Math.min(...values), hi = Math.max(...values); if (hi === lo) hi = lo + 1;
  return values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / (hi - lo) * (h - 4)).toFixed(1)}`).join('');
}
