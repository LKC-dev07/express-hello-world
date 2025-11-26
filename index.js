import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIG ---
const {
  CN_ADMIN_TOKEN,
  PAPER_TRADING = 'true',
  MAX_TRADE_USD = '100',
  ALLOWED_PRODUCTS = 'BTC-USD,ETH-USD',

  // Strategy
  STRAT_ENABLED = 'false',

  // Coinbase (live trading later)
  COINBASE_API_KEY,
  COINBASE_API_SECRET,
  COINBASE_API_PASSPHRASE
} = process.env;

const allowed = new Set(ALLOWED_PRODUCTS.split(',').map(x => x.trim().toUpperCase()));
const isPaper = PAPER_TRADING === 'true';

// --- AUTH ---
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!CN_ADMIN_TOKEN || tok !== CN_ADMIN_TOKEN)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- HELPERS ---
async function getPublicTicker(product = 'BTC-USD') {
  const url = `https://api.exchange.coinbase.com/products/${product}/ticker`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
  if (!r.ok) throw new Error(`ticker failed: ${r.status}`);
  const j = await r.json();
  return { price: Number(j.price), bid: Number(j.bid), ask: Number(j.ask) };
}

async function getHistoricPrice(product = 'BTC-USD', hours = 12) {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
    if (!r.ok) throw new Error(`historic failed: ${r.status}`);
    const candles = await r.json();
    if (!Array.isArray(candles) || !candles.length) throw new Error('no candle data');
    const closes = candles.map(c => c[4]);
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  } catch (err) {
    console.log(`[WARN historic] ${err.message}`);
    const { price } = await getPublicTicker(product);
    return price;
  }
}

// ATR function
async function getATR(product = 'BTC-USD', hours = 12) {
  try {
    const gran = 3600;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
    const candles = await r.json();
    if (!Array.isArray(candles) || candles.length < hours + 1)
      throw new Error('not enough candles');
    const sorted = candles.slice(0, hours + 1).reverse();
    let trs = [];
    for (let i = 1; i < sorted.length; i++) {
      const [t, low, high, open, close] = sorted[i];
      const prevClose = sorted[i - 1][4];
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  } catch (err) {
    console.log(`[ATR WARN] ${err.message}`);
    return 0;
  }
}
// --- COINBASE ADVANCED TRADE SIGNER ---
function signAdvancedTrade(method, requestPath, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const prehash = timestamp + method.toUpperCase() + requestPath + body;

  const key = Buffer.from(COINBASE_API_SECRET, 'base64');
  const hmac = crypto.createHmac('sha256', key);
  const signature = hmac.update(prehash).digest('base64');

  return { timestamp, signature };
}

// --- PAPER ORDER HELPER ---
let virtualBtc = 0;
let virtualUsd = 0;

async function placePaperOrder(product = 'BTC-USD', side = 'buy', usd = 5) {
  const t = await getPublicTicker(product);
  let qty;

  if (side === 'buy') {
    qty = Number((usd / t.price).toFixed(6));
    virtualBtc += qty;
    virtualUsd -= usd;
  } else if (side === 'sell') {
    const targetQty = usd / t.price;
    qty = Math.min(targetQty, virtualBtc);
    virtualBtc -= qty;
    virtualUsd += qty * t.price;
  } else {
    throw new Error(`bad side ${side}`);
  }

  console.log(
    `[AUTO PAPER] ${side.toUpperCase()} $${usd} @ ${t.price.toFixed(
      2
    )} qty=${qty}, balances: BTC=${virtualBtc.toFixed(6)}, USD=${virtualUsd.toFixed(2)}`
  );
}

// --- API ROUTES ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, paper: isPaper, time: new Date().toISOString() });
});

app.post('/api/paper-order', requireAdmin, async (req, res) => {
  try {
    const { product = 'BTC-USD', side = 'buy', usd = 5 } = req.body;
    const out = await placePaperOrder(product, side, usd);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
let lastBuyTimestamp = 0; // cooldown tracking

// --- STRATEGY TICK ---
async function strategyTick() {
  try {
    if (STRAT_ENABLED !== 'true') return;

    const symbol = (process.env.STRAT_CURRENCY || 'BTC-USD').toUpperCase();
    const buyUsd = Number(process.env.STRAT_BUY_AMOUNT_USD || '5');
    const maWindow = Number(process.env.STRAT_MA_WINDOW_HOURS || '12');

    const { price: current } = await getPublicTicker(symbol);
    const past = await getHistoricPrice(symbol, maWindow);

    const now = new Date().toISOString();
    if (!past || isNaN(past)) {
      console.log(`[${now}] ERROR: bad historic price`);
      return;
    }

    // ATR & bands
    const atr = await getATR(symbol, maWindow);
    const atrPct = (atr / past) * 100;
    const mult = Number(process.env.STRAT_ATR_MULTIPLIER || '1.2');
    let bandPct = atrPct * mult;
    const minPct = Number(process.env.STRAT_MIN_BAND_PCT || '1.0');
    const maxPct = Number(process.env.STRAT_MAX_BAND_PCT || '5.0');
    bandPct = Math.max(minPct, Math.min(maxPct, bandPct));

    const lower = past * (1 - bandPct / 100);
    const upper = past * (1 + bandPct / 100);

    console.log(
      `[${now}] MA=${past.toFixed(2)}, ATR%=${atrPct.toFixed(
        2
      )}, band=${bandPct.toFixed(2)}%`
    );
    console.log(
      `[${now}] range lower=${lower.toFixed(2)}, upper=${upper.toFixed(
        2
      )}, current=${current}`
    );

    // SELL controls
    const sellEnabled = process.env.STRAT_SELL_ENABLED === 'true';
    const maxSellFrac = Number(process.env.STRAT_SELL_MAX_FRACTION || '0.2');
    const extraBand = Number(process.env.STRAT_SELL_EXTRA_BAND_PCT || '0.5');
    const minBtc = Number(process.env.STRAT_MIN_VIRTUAL_BTC || '0.00001');

// BUY on dips (respect cooldown)
const cooldownSec = Number(process.env.STRAT_COOLDOWN_SEC || '1800');
const nowSec = Math.floor(Date.now() / 1000);

// has enough time passed since last buy?
if (current <= lower) {
  if (nowSec - lastBuyTimestamp < cooldownSec) {
    console.log(
      `[${now}] Cooldown active: last buy ${(
        (nowSec - lastBuyTimestamp) / 60
      ).toFixed(0)} min ago, need ${cooldownSec / 60} min`
    );
    return;
  }

  console.log(
    `[${now}] RANGE BUY: ${current} <= ${lower.toFixed(
      2
    )}, buying $${buyUsd}`
  );

  await placePaperOrder(symbol, 'buy', buyUsd);

  // record time of this buy
  lastBuyTimestamp = nowSec;
  return;
}

    // SELL skim only on strong highs
    if (
      sellEnabled &&
      virtualBtc > minBtc &&
      current >= upper * (1 + extraBand / 100)
    ) {
      const qty = virtualBtc * maxSellFrac;
      const usdVal = qty * current;

      console.log(
        `[${now}] RANGE SELL: ${current} >= upper*(1+${extraBand}%), selling ~${(
          maxSellFrac * 100
        ).toFixed(0)}% (~$${usdVal.toFixed(2)})`
      );

      if (usdVal > 0) {
        await placePaperOrder(symbol, 'sell', usdVal);
      }
      return;
    }

    // NEUTRAL
    console.log(`[${now}] No action (conservative).`);
  } catch (err) {
    console.log(`[STRAT ERROR] ${err.message}`);
  }
}

setInterval(strategyTick, 15 * 60 * 1000);

// --- SERVE FRONTEND ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`CN listening on :${port}`));
