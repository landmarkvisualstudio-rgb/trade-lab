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
  // added later (keep appending: sync links store assets by position)
  // 20 more large caps: liquid on Binance, best 90-day return when picked (Oct 2026)
  { symbol: 'QNTUSDT', name: 'کوانت', short: 'QNT', group: 'crypto', market: 'futures', color: '#2E3B4E' },
  { symbol: 'NEARUSDT', name: 'نیر', short: 'NEAR', group: 'crypto', market: 'spot', color: '#00C08B' },
  { symbol: 'ZECUSDT', name: 'زی‌کش', short: 'ZEC', group: 'crypto', market: 'spot', color: '#ECB244' },
  { symbol: 'ENAUSDT', name: 'اتنا', short: 'ENA', group: 'crypto', market: 'spot', color: '#7C6CF2' },
  { symbol: 'ARBUSDT', name: 'آربیتروم', short: 'ARB', group: 'crypto', market: 'futures', color: '#28A0F0' },
  { symbol: 'UNIUSDT', name: 'یونی‌سواپ', short: 'UNI', group: 'crypto', market: 'spot', color: '#FF007A' },
  { symbol: 'XMRUSDT', name: 'مونرو', short: 'XMR', group: 'crypto', market: 'futures', color: '#FF6600' },
  { symbol: 'DASHUSDT', name: 'دش', short: 'DASH', group: 'crypto', market: 'futures', color: '#008CE7' },
  { symbol: 'CRVUSDT', name: 'کرو', short: 'CRV', group: 'crypto', market: 'futures', color: '#C9393B' },
  { symbol: 'TIAUSDT', name: 'سلستیا', short: 'TIA', group: 'crypto', market: 'futures', color: '#7B2BF9' },
  { symbol: 'PYTHUSDT', name: 'پیت', short: 'PYTH', group: 'crypto', market: 'futures', color: '#6E57D2' },
  { symbol: 'INJUSDT', name: 'اینجکتیو', short: 'INJ', group: 'crypto', market: 'futures', color: '#0082FA' },
  { symbol: 'JUPUSDT', name: 'ژوپیتر', short: 'JUP', group: 'crypto', market: 'futures', color: '#3DB39E' },
  { symbol: 'WLDUSDT', name: 'ورلدکوین', short: 'WLD', group: 'crypto', market: 'spot', color: '#5A5F6B' },
  { symbol: 'AAVEUSDT', name: 'آوه', short: 'AAVE', group: 'crypto', market: 'spot', color: '#B6509E' },
  { symbol: 'DOTUSDT', name: 'پولکادات', short: 'DOT', group: 'crypto', market: 'futures', color: '#E6007A' },
  { symbol: 'SUIUSDT', name: 'سویی', short: 'SUI', group: 'crypto', market: 'spot', color: '#4DA2FF' },
  { symbol: 'TAOUSDT', name: 'بیتنسور', short: 'TAO', group: 'crypto', market: 'spot', color: '#3A3A3A' },
  { symbol: 'FILUSDT', name: 'فایل‌کوین', short: 'FIL', group: 'crypto', market: 'futures', color: '#0090FF' },
  { symbol: 'PENDLEUSDT', name: 'پندل', short: 'PENDLE', group: 'crypto', market: 'futures', color: '#1BB5C8' },
  // 20 meme coins, picked the same way (futures where that market is the liquid one)
  { symbol: 'MUBARAKUSDT', name: 'مبارک', short: 'MUBARAK', group: 'meme', market: 'futures', color: '#C49A2C' },
  { symbol: 'PUMPUSDT', name: 'پامپ', short: 'PUMP', group: 'meme', market: 'futures', color: '#4CC38A' },
  { symbol: 'PEPEUSDT', name: 'پپه', short: 'PEPE', group: 'meme', market: 'spot', color: '#4C9A2A' },
  { symbol: 'MEWUSDT', name: 'میو', short: 'MEW', group: 'meme', market: 'futures', color: '#E5774B' },
  { symbol: 'PENGUUSDT', name: 'پاجی پنگوئن', short: 'PENGU', group: 'meme', market: 'futures', color: '#6FA8DC' },
  { symbol: 'BOMEUSDT', name: 'بوک آو میم', short: 'BOME', group: 'meme', market: 'futures', color: '#3FA34D' },
  { symbol: 'WIFUSDT', name: 'داگ‌ویف‌هت', short: 'WIF', group: 'meme', market: 'futures', color: '#C59B6D' },
  { symbol: 'NEIROUSDT', name: 'نیرو', short: 'NEIRO', group: 'meme', market: 'futures', color: '#D9A441' },
  { symbol: 'SPXUSDT', name: 'اس‌پی‌ایکس ۶۹۰۰', short: 'SPX', group: 'meme', market: 'futures', color: '#E8443A' },
  { symbol: 'PEOPLEUSDT', name: 'کانستیتوشن', short: 'PEOPLE', group: 'meme', market: 'futures', color: '#5A8DEE' },
  { symbol: '1000FLOKIUSDT', name: 'فلوکی (۱۰۰۰ واحد)', short: 'FLOKI', group: 'meme', market: 'futures', color: '#F2A33A' },
  { symbol: 'TRUMPUSDT', name: 'ترامپ میم', short: 'TRUMP', group: 'meme', market: 'futures', color: '#C8A24A' },
  { symbol: 'MOODENGUSDT', name: 'مودنگ', short: 'MOODENG', group: 'meme', market: 'futures', color: '#8C7B6B' },
  { symbol: 'TURBOUSDT', name: 'توربو', short: 'TURBO', group: 'meme', market: 'futures', color: '#5BD1A6' },
  { symbol: 'DOGSUSDT', name: 'داگز', short: 'DOGS', group: 'meme', market: 'futures', color: '#707070' },
  { symbol: '1000BONKUSDT', name: 'بونک (۱۰۰۰ واحد)', short: 'BONK', group: 'meme', market: 'futures', color: '#F7A325' },
  { symbol: 'POPCATUSDT', name: 'پاپ‌کت', short: 'POPCAT', group: 'meme', market: 'futures', color: '#B9B2A8' },
  { symbol: 'FARTCOINUSDT', name: 'فارت‌کوین', short: 'FART', group: 'meme', market: 'futures', color: '#8FBF3F' },
  { symbol: 'TOSHIUSDT', name: 'توشی', short: 'TOSHI', group: 'meme', market: 'futures', color: '#3D6FD8' },
  { symbol: '1000SHIBUSDT', name: 'شیبا (۱۰۰۰ واحد)', short: 'SHIB', group: 'meme', market: 'futures', color: '#E2462F' },
];

export const GROUPS = { crypto: 'رمزارز', meme: 'میم‌کوین', metal: 'فلزات', energy: 'انرژی' };

export const assetBySymbol = Object.fromEntries(ASSETS.map(a => [a.symbol, a]));

// The five setups come from the trader-scanner / trader-entry skills, adapted
// to 24/7 markets on 5-minute bars.
// Setups. src 'trader' = from the trader-scanner / trader-entry skills; src 'chart' =
// from the chart-analyst skill (classic published rules). Keys are only ever appended:
// sync links store them by position.
export const FAMILIES = { breakout: 'شکست', trend: 'روند', momentum: 'مومنتوم', volatility: 'نوسان', meanrev: 'بازگشت به میانگین', reversal: 'برگشتی', price: 'پرایس اکشن', intraday: 'درون‌روزی' };
export const STRATEGIES = {
  orb: { name: 'شکست محدوده‌ی شروع سشن', src: 'trader', family: 'breakout', skill: 'trader-entry', desc: 'محدوده‌ی ۱۵ دقیقه‌ی اول سشن آسیا، لندن و نیویورک؛ ورود با بسته شدن کندل بالای سقف محدوده، حد ضرر وسط محدوده.' },
  breakout: { name: 'شکست سقف ۲۰ کندل', src: 'trader', family: 'breakout', skill: 'trader-scanner', desc: 'بسته شدن بالای بالاترین کلوز ۲۰ کندل قبل با حجم بالاتر از میانگین؛ حد ضرر ۱.۵ برابر ATR.' },
  flag: { name: 'پرچم صعودی', src: 'trader', family: 'price', skill: 'trader-scanner', desc: 'یک حرکت تند (میله) و بعد ۵ کندل فشرده؛ ورود با شکست سقف پرچم، حد ضرر کف پرچم.' },
  reclaim: { name: 'بازپس‌گیری میانگین ۲۰', src: 'trader', family: 'trend', skill: 'trader-scanner', desc: 'کلوز از زیر میانگین ۲۰ به بالای آن، وقتی میانگین ۵۰ رو به بالاست.' },
  bounce: { name: 'برگشت از اشباع فروش', src: 'trader', family: 'meanrev', skill: 'trader-scanner', desc: 'RSI(14) زیر ۳۰ و بعد کندل صعودی؛ حد ضرر زیر کف ۶ کندل اخیر.' },
  ema_cross: { name: 'تقاطع EMA ۹/۲۱', src: 'chart', family: 'trend', skill: 'chart-analyst', desc: 'EMA9 از پایین EMA21 را قطع کند و قیمت بالای EMA200 باشد؛ حد ضرر زیر کف ۶ کندل اخیر.' },
  supertrend: { name: 'چرخش سوپرترند', src: 'chart', family: 'trend', skill: 'chart-analyst', desc: 'سوپرترند (ATR ۱۰ × ۳) صعودی شود و RSI بین ۵۰ و ۷۰ باشد؛ حد ضرر کمی زیر خط سوپرترند.' },
  macd: { name: 'تقاطع MACD زیر صفر', src: 'chart', family: 'momentum', skill: 'chart-analyst', desc: 'خط MACD (۱۲/۲۶/۹) زیر صفر از سیگنال بالا بزند، قیمت بالای EMA200؛ حد ضرر زیر آخرین کف.' },
  bb_squeeze: { name: 'فشردگی بولینجر', src: 'chart', family: 'volatility', skill: 'chart-analyst', desc: 'پهنای باند بولینجر کمترین مقدار ۱۲۰ کندل؛ ورود با بسته شدن بیرون باند بالا، حد ضرر میانگین ۲۰.' },
  vwap_reclaim: { name: 'بازپس‌گیری VWAP', src: 'chart', family: 'intraday', skill: 'chart-analyst', desc: 'دست‌کم ۱۵ دقیقه زیر VWAP و بعد کندل قوی با حجم بالای آن؛ حد ضرر ۰.۱۵٪ زیر VWAP یا کف کندل.' },
  vwap_dev: { name: 'برگشت از باند ۲σ VWAP', src: 'chart', family: 'meanrev', skill: 'chart-analyst', desc: 'برخورد به باند دو انحراف معیار زیر VWAP با کندل چکش یا پوشا؛ حد ضرر ۰.۱۵٪ زیر کف.' },
  rsi_div: { name: 'واگرایی RSI', src: 'chart', family: 'reversal', skill: 'chart-analyst', desc: 'کف پایین‌تر قیمت با کف بالاتر RSI روی دو سوئینگ تأییدشده؛ ورود با شکست سقف بعد از کف دوم.' },
  engulfing: { name: 'پوشای صعودی', src: 'chart', family: 'price', skill: 'chart-analyst', desc: 'کندل صعودی که بدنه‌ی کندل نزولی قبل را بعد از افت کامل بپوشاند، با حجم بیشتر؛ حد ضرر زیر الگو.' },
  structure: { name: 'ساختار بازار (کف بالاتر)', src: 'chart', family: 'price', skill: 'chart-analyst', desc: 'کف‌ها و سقف‌های بالاتر؛ بعد از کف بالاتر تازه، شکست سقف کوچک؛ حد ضرر زیر همان کف.' },
  turtle: { name: 'لاک‌پشت (سقف ۵۵ کندل)', src: 'chart', family: 'breakout', skill: 'chart-analyst', desc: 'سیستم ۲ لاک‌پشت‌ها: شکست بالاترین قیمت ۵۵ کندل؛ حد ضرر ۲N (دو برابر ATR).' },
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
  strategies: Object.fromEntries(Object.keys(STRATEGIES).map(k => [k, true])),
  symbols: Object.fromEntries(ASSETS.map(a => [a.symbol, true])),
  notifications: false,
};

export const WARMUP_BARS = 300;
