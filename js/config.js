// Assets, strategies and default settings.

export const BAR_MS = 5 * 60 * 1000; // the bot trades closed 5-minute bars

export const ASSETS = [
  // crypto (Binance spot)
  { symbol: 'BTCUSDT', name: 'بیت‌کوین', short: 'BTC', group: 'crypto', market: 'spot', color: '#F7931A' },
  { symbol: 'ETHUSDT', name: 'اتریوم', short: 'ETH', group: 'crypto', market: 'spot', color: '#8A92B2' },
  { symbol: 'SOLUSDT', name: 'سولانا', short: 'SOL', group: 'crypto', market: 'spot', color: '#14F195' },
  { symbol: 'BNBUSDT', name: 'بی‌ان‌بی', short: 'BNB', group: 'crypto', market: 'spot', color: '#F3BA2F' },
  { symbol: 'XRPUSDT', name: 'ریپل', short: 'XRP', group: 'crypto', market: 'spot', color: '#9AA4B5' },
  { symbol: 'DOGEUSDT', name: 'دوج‌کوین', short: 'DOGE', group: 'crypto', market: 'spot', color: '#C2A633' },
  { symbol: 'ADAUSDT', name: 'کاردانو', short: 'ADA', group: 'crypto', market: 'spot', color: '#3468D1' },
  { symbol: 'AVAXUSDT', name: 'آوالانچ', short: 'AVAX', group: 'crypto', market: 'spot', color: '#E84142' },
  { symbol: 'LINKUSDT', name: 'چین‌لینک', short: 'LINK', group: 'crypto', market: 'spot', color: '#2A5ADA' },
  { symbol: 'TONUSDT', name: 'تون‌کوین', short: 'TON', group: 'crypto', market: 'spot', color: '#0098EA' },
  // metals
  { symbol: 'PAXGUSDT', name: 'طلا (توکن PAXG)', short: 'PAXG', group: 'metal', market: 'spot', color: '#E4B94A' },
  { symbol: 'XAUUSDT', name: 'طلا (انس)', short: 'XAU', group: 'metal', market: 'futures', color: '#D4A72C' },
  { symbol: 'XAGUSDT', name: 'نقره', short: 'XAG', group: 'metal', market: 'futures', color: '#B8C2CC' },
  { symbol: 'COPPERUSDT', name: 'مس', short: 'CU', group: 'metal', market: 'futures', color: '#C8713D' },
  // energy
  { symbol: 'CLUSDT', name: 'نفت WTI', short: 'WTI', group: 'energy', market: 'futures', color: '#4A4F5C' },
  { symbol: 'BZUSDT', name: 'نفت برنت', short: 'BRENT', group: 'energy', market: 'futures', color: '#5B6475' },
  { symbol: 'NATGASUSDT', name: 'گاز طبیعی', short: 'GAS', group: 'energy', market: 'futures', color: '#3E8ED0' },
];

export const GROUPS = { crypto: 'رمزارز', metal: 'فلزات', energy: 'انرژی' };

export const assetBySymbol = Object.fromEntries(ASSETS.map(a => [a.symbol, a]));

// The five setups come from the trader-scanner / trader-entry skills, adapted
// to 24/7 markets on 5-minute bars.
export const STRATEGIES = {
  orb: { name: 'شکست محدوده‌ی شروع سشن', skill: 'trader-entry', desc: 'محدوده‌ی ۱۵ دقیقه‌ی اول سشن آسیا، لندن و نیویورک؛ ورود با بسته شدن کندل بالای سقف محدوده، حد ضرر وسط محدوده.' },
  breakout: { name: 'شکست سقف ۲۰ کندل', skill: 'trader-scanner', desc: 'بسته شدن بالای بالاترین کلوز ۲۰ کندل قبل با حجم بالاتر از میانگین؛ حد ضرر ۱.۵ برابر ATR.' },
  flag: { name: 'پرچم صعودی', skill: 'trader-scanner', desc: 'یک حرکت تند (میله) و بعد ۵ کندل فشرده؛ ورود با شکست سقف پرچم، حد ضرر کف پرچم.' },
  reclaim: { name: 'بازپس‌گیری میانگین ۲۰', skill: 'trader-scanner', desc: 'کلوز از زیر میانگین ۲۰ به بالای آن، وقتی میانگین ۵۰ رو به بالاست.' },
  bounce: { name: 'برگشت از اشباع فروش', skill: 'trader-scanner', desc: 'RSI(14) زیر ۳۰ و بعد کندل صعودی؛ حد ضرر زیر کف ۶ کندل اخیر.' },
};

export const SESSIONS_UTC_MIN = [
  { key: 'asia', name: 'آسیا', min: 0 },
  { key: 'london', name: 'لندن', min: 7 * 60 },
  { key: 'ny', name: 'نیویورک', min: 13 * 60 + 30 },
];

export const DEFAULT_SETTINGS = {
  capital: 1000,              // USDT
  testDays: 7,
  riskPct: 1.0,               // trader-budget: max loss per trade, % of equity
  targetR: 2,                 // trader-exit: target as a multiple of the risk
  maxHoldHours: 4,            // time stop (24/7 markets have no closing bell)
  maxOpen: 6,                 // open positions at once
  maxPositionPct: 30,         // biggest position, % of equity
  cashBufferPct: 5,           // always kept in cash
  minOrder: 5,                // USDT
  dailyLossPct: 6,            // trader-risk: daily loss limit, % of starting capital
  maxTradesPerDay: 60,
  cooldownBars: 6,            // after a stop on the same symbol
  minStopPct: 0.08,           // stops tighter than this are refused (spread)
  maxStopPct: 4,
  feeSpotPct: 0.1,            // taker fee per side
  feeFuturesPct: 0.05,
  slippagePct: 0.02,          // per fill, against you
  allowShort: false,          // the skills plan longs only
  timeMachineFilter: false,   // trader-timemachine as a filter
  tmMinEdge: 0,               // percentage points over break-even required
  strategies: { orb: true, breakout: true, flag: true, reclaim: true, bounce: true },
  symbols: Object.fromEntries(ASSETS.map(a => [a.symbol, true])),
  notifications: false,
};

export const WARMUP_BARS = 200;
