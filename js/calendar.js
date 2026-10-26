// Time and calendar (skill 9). Big scheduled US releases move every market at
// once, and gold/oil tokens trade on while their real markets are closed, on thin
// volume. Dates are from the official calendars (bls.gov, federalreserve.gov),
// checked in October 2026; times are US Eastern and converted to UTC with US
// daylight-saving rules.
const ET = [
  // US CPI, 8:30 ET
  ...['2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10']
    .map(d => [d, 8, 30, 'cpi']),
  // US jobs report (nonfarm payrolls), 8:30 ET
  ...['2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04']
    .map(d => [d, 8, 30, 'nfp']),
  // FOMC statement, 14:00 ET on the last day of the meeting
  ...['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
      '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08']
    .map(d => [d, 14, 0, 'fomc']),
];
export const EVENT_NAMES = { cpi: 'تورم آمریکا (CPI)', nfp: 'اشتغال آمریکا (NFP)', fomc: 'تصمیم نرخ بهره (FOMC)' };

// US daylight saving: second Sunday of March to first Sunday of November
function nthSunday(y, m, n) { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7; return 1 + first + (n - 1) * 7; }
function etToUtc(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  const guess = Date.UTC(y, mo - 1, d, hh + 5, mm);           // EST = UTC-5
  return guess >= start && guess < end ? guess - 3600000 : guess; // EDT = UTC-4
}
export const EVENTS = ET.map(([d, h, m, k]) => ({ t: etToUtc(d, h, m), kind: k })).sort((a, b) => a.t - b.t);

// the scheduled release within `minutes` of t (before or after), if any
export function nearEvent(t, minutes = 30) {
  const w = minutes * 60000;
  let lo = 0, hi = EVENTS.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (EVENTS[m].t < t - w) lo = m + 1; else hi = m - 1; }
  const e = EVENTS[lo];
  return e && e.t <= t + w ? e : null;
}

// trading sessions (UTC hours), used as a context the memory learns from
export function sessionOf(t) {
  const h = new Date(t).getUTCHours();
  return h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'ny' : 'late';
}
export const SESSION_NAMES = { asia: 'سشن آسیا', london: 'سشن لندن', ny: 'سشن نیویورک', late: 'ساعت‌های کم‌حجم شب' };
const isWeekend = t => { const d = new Date(t); const wd = d.getUTCDay(), h = d.getUTCHours(); return wd === 6 || (wd === 5 && h >= 21) || (wd === 0 && h < 22); };

// may a new trade open at t on this asset group?
export function calendarBlock(t, group, minutes = 30) {
  const e = nearEvent(t, minutes);
  if (e) return { reason: 'news', why: EVENT_NAMES[e.kind] };
  if (group === 'metal' || group === 'energy') {
    // the real gold/oil markets are shut on weekends and for an hour each day (21-22 UTC)
    if (isWeekend(t)) return { reason: 'closed', why: 'بازار اصلی تعطیل (آخر هفته)' };
    if (new Date(t).getUTCHours() === 21) return { reason: 'closed', why: 'وقفه‌ی روزانه‌ی بازار اصلی' };
  }
  return null;
}
