import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';

const app = express();
app.use(express.json());
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// --- config ---
const {
  CN_ADMIN_TOKEN,
  PAPER_TRADING = 'true',
  MAX_TRADE_USD = '100',
  ALLOWED_PRODUCTS = 'BTC-USD,ETH-USD',

  // Strategy
  STRAT_ENABLED = 'false',
  STRAT_TYPE = 'simple-dip',
  STRAT_SYMBOL = 'BTC-USD',
  STRAT_MAX_POSITION_USD = '300',
  STRAT_BUY_ON_DIP_PCT = '1.5',
  STRAT_COOLDOWN_SEC = '900',

  // Coinbase (fill when ready)
  COINBASE_API_KEY,
  COINBASE_API_SECRET,
  COINBASE_API_PASSPHRASE
} = process.env;

const allowed = new Set(ALLOWED_PRODUCTS.split(',').map(s => s.trim().toUpperCase()));
const isPaper = PAPER_TRADING === 'true';

// --- tiny auth middleware ---
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!CN_ADMIN_TOKEN || token !== CN_ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- helpers ---
const nowSec = () => Math.floor(Date.now() / 1000);

// Coinbase public price (no auth, safe to use for display/strategy checks)
// Uses Coinbase Exchange public ticker (works for BTC-USD, ETH-USD, etc.)
async function getPublicTicker(product = 'BTC-USD') {
  const url = `https://api.exchange.coinbase.com/products/${product}/ticker`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
  if (!r.ok) throw new Error(`ticker ${product} failed: ${r.status}`);
  const j = await r.json();
  return { price: parseFloat(j.price), bid: parseFloat(j.bid), ask: parseFloat(j.ask), time: new Date().toISOString() };
}
// --- fetch approximate historic price (12h lookback) ---
// For now this just reuses the current price as a placeholder.
// Later you can swap in a real historical data call.
async function getHistoricPrice(product = 'BTC-USD', hours = 12) {
  try {
    // Coinbase doesn't offer a simple "12h ago" endpoint in the public API,
    // so we could simulate by pulling recent candles.
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
    if (!r.ok) throw new Error(`historic ${product} failed: ${r.status}`);
    const candles = await r.json();
    if (!Array.isArray(candles) || !candles.length) throw new Error('no candle data');
    // Each candle = [time, low, high, open, close, volume]
    const closes = candles.map(c => c[4]);
    const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
    return avg;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] WARN: getHistoricPrice failed for ${product} – ${err.message}`);
    // Fallback to current price if data fetch fails
    const { price } = await getPublicTicker(product);
    return price;
  }
}
let virtualBtc = 0;
let virtualUsd = 0;

// --- ATR calculation ---
// ATR uses recent candles to measure volatility.
// granularity: 3600 = 1 hour candles (12 candles for 12h)
async function getATR(product = 'BTC-USD', hours = 12) {
  try {
    const granularity = 3600; // 1 hour
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
    const candles = await r.json();

    if (!Array.isArray(candles) || candles.length < hours + 1)
      throw new Error('not enough candle data');

    // Candles come newest-first; reverse so oldest-first
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

    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    return atr;
  } catch (err) {
    console.log(`[ATR WARN] ${err.message}`);
    return 0;
  }
}

// NOTE: Trading requires Coinbase **Advanced Trade API**.
// The signing details can change. We stub a signer so you can drop in the exact spec from Coinbase docs.
// Replace `signAdvancedTrade` body once you have the official details in front of you.
function signAdvancedTrade(method, path, body = '') {
  // PSEUDOCODE: consult Coinbase Advanced Trade docs for exact prehash & header names.
  const timestamp = String(Date.now() / 1000);
  const prehash = timestamp + method.toUpperCase() + path + body;
  const key = Buffer.from((COINBASE_API_SECRET || '').trim(), 'base64'); // some APIs require base64 decode
  const sig = crypto.createHmac('sha256', key).update(prehash).digest('base64');
  return { timestamp, signature: sig };
}

// Minimal brokerage request wrapper (fill in when you’re ready to trade live)
async function coinbaseRequest(method, path, bodyObj) {
  const base = 'https://api.coinbase.com'; // Advanced Trade base (confirm in docs)
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const { timestamp, signature } = signAdvancedTrade(method, path, body);

  const headers = {
    'Content-Type': 'application/json',
    'CB-ACCESS-KEY': COINBASE_API_KEY || '',
    'CB-ACCESS-SIGN': signature,
    'CB-ACCESS-TIMESTAMP': timestamp,
    // Some versions also require a passphrase (older “Pro”). If your key shows a passphrase, include it:
    ...(COINBASE_API_PASSPHRASE ? { 'CB-ACCESS-PASSPHRASE': COINBASE_API_PASSPHRASE } : {})
  };

  const r = await fetch(base + path, { method, headers, body: body || undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`coinbase ${method} ${path} failed: ${r.status} ${text}`);
  return j;
}

// --- routes ---
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), paper: isPaper }));

app.get('/api/price/:product', async (req, res) => {
  try {
    const product = (req.params.product || 'BTC-USD').toUpperCase();
    if (!allowed.has(product)) return res.status(400).json({ error: 'symbol not allowed' });
    const t = await getPublicTicker(product);
    res.json({ product, ...t });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Paper trade endpoint (no real order sent)
app.post('/api/paper-order', requireAdmin, async (req, res) => {
  try {
    const { product = 'BTC-USD', side = 'buy', usd = 50 } = req.body || {};
    if (!allowed.has(product.toUpperCase())) return res.status(400).json({ error: 'symbol not allowed' });
    const max = Number(MAX_TRADE_USD);
    if (usd > max) return res.status(400).json({ error: `usd > MAX_TRADE_USD (${max})` });
    const t = await getPublicTicker(product);
    const qty = Number((usd / t.price).toFixed(6));
    res.json({
      mode: 'paper',
      product,
      side,
      usd,
      est_price: t.price,
      est_qty: qty,
      time: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Live order (DISABLED if PAPER_TRADING=true)
app.post('/api/order', requireAdmin, async (req, res) => {
  try {
    if (isPaper) return res.status(400).json({ error: 'paper mode enabled; set PAPER_TRADING=false to place live orders' });
    const { product = 'BTC-USD', side = 'BUY', order_type = 'MARKET', usd = 50 } = req.body || {};
    if (!allowed.has(product.toUpperCase())) return res.status(400).json({ error: 'symbol not allowed' });

    // Build a basic MARKET order body for Advanced Trade brokerage API.
    // Confirm the exact schema in Coinbase docs for your account.
    const path = '/api/v3/brokerage/orders'; // typical AT endpoint path
    const body = {
      product_id: product,
      side: side.toUpperCase(),  // BUY or SELL
      order_configuration: {
        market_market_ioc: { quote_size: String(usd) } // spend amount in quote currency (USD)
      }
    };

    const j = await coinbaseRequest('POST', path, body);
    res.json({ placed: true, response: j });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
async function placePaperOrder(product = 'BTC-USD', side = 'buy', usd = 5) {
  if (!allowed.has(product.toUpperCase())) {
    throw new Error('symbol not allowed');
  }

  const max = Number(MAX_TRADE_USD);
  if (usd > max) {
    throw new Error(`usd > MAX_TRADE_USD (${max})`);
  }

  const t = await getPublicTicker(product);
  let qty;

  if (side === 'buy') {
    // buy qty = usd / price
    qty = Number((usd / t.price).toFixed(6));
    virtualBtc += qty;
    virtualUsd -= usd;
  } else if (side === 'sell') {
    // target qty = usd / price, but cap by what we actually "hold"
    const targetQty = usd / t.price;
    qty = Math.min(targetQty, virtualBtc);
    virtualBtc -= qty;
    virtualUsd += qty * t.price;
  } else {
    throw new Error(`unsupported side: ${side}`);
  }

  const payload = {
    mode: 'paper',
    product,
    side,
    usd,
    est_price: t.price,
    est_qty: qty,
    time: new Date().toISOString()
  };

  console.log(
    `[AUTO PAPER] ${side.toUpperCase()} ${product} for $${usd} @ ${t.price.toFixed(
      2
    )} (~${qty}), balances: BTC=${virtualBtc.toFixed(6)}, USD=${virtualUsd.toFixed(2)}`
  );

  return payload;
}
let virtualBtc = 0;
let virtualUsd = 0;

// --- ultra-light strategy runner (buy small on dips) ---
let lastBuyAt = 0;
async function strategyTick() {
  try {
    if (process.env.STRAT_ENABLED !== 'true') return;

    const symbol = (process.env.STRAT_CURRENCY || 'BTC-USD').toUpperCase();
    const dipPct = Number(process.env.STRAT_BUY_ON_DIP_PCT || '1.5');
    const buyUsd = Number(process.env.STRAT_BUY_AMOUNT_USD || '5');
    const maxUsd = Number(process.env.MAX_TRADE_USD || '35');
    const maWindow = Number(process.env.STRAT_MA_WINDOW_HOURS || '12');

    // --- pull current and historic prices
    const { price: current } = await getPublicTicker(symbol);
    const past = await getHistoricPrice(symbol, maWindow); // you can stub this for now
    const dropPct = ((past - current) / past) * 100;

    const now = new Date().toISOString();


    if (isNaN(past) || past <= 0) {
      console.log(`[${now}] ERROR: could not fetch historic price for ${symbol}`);
      return;
    }
    let virtualBtc = 0;
let virtualUsd = 0;

    // === RANGE ACCUMULATION STRATEGY ===

    // compute ATR-based band %
    const atr = await getATR(symbol, maWindow);
    const atrPct = (atr / past) * 100;

    const multiplier = Number(process.env.STRAT_ATR_MULTIPLIER || '1.2');
    let bandPct = atrPct * multiplier;

    const minPct = Number(process.env.STRAT_MIN_BAND_PCT || '1.0');
    const maxPct = Number(process.env.STRAT_MAX_BAND_PCT || '5.0');
    bandPct = Math.max(minPct, Math.min(maxPct, bandPct));

    // compute range boundaries
    const lowerBand = past * (1 - bandPct / 100);
    const upperBand = past * (1 + bandPct / 100);

    console.log(`[${now}] MA=${past.toFixed(2)}, ATR%=${atrPct.toFixed(2)}, band=${bandPct.toFixed(2)}%`);
    console.log(`[${now}] range: lower=${lowerBand.toFixed(2)}, upper=${upperBand.toFixed(2)}, current=${current}`);

     const sellEnabled = process.env.STRAT_SELL_ENABLED === 'true';
    const maxSellFraction = Number(process.env.STRAT_SELL_MAX_FRACTION || '0.2');
    const extraBandPct = Number(process.env.STRAT_SELL_EXTRA_BAND_PCT || '0.5');
    const minVirtualBtc = Number(process.env.STRAT_MIN_VIRTUAL_BTC || '0.00001');
// === CONSERVATIVE RANGE ACCUMULATION + SELL SKIM ===

const sellEnabled = process.env.STRAT_SELL_ENABLED === 'true';
const maxSellFraction = Number(process.env.STRAT_SELL_MAX_FRACTION || '0.2');
const extraBandPct = Number(process.env.STRAT_SELL_EXTRA_BAND_PCT || '0.5');
const minVirtualBtc = Number(process.env.STRAT_MIN_VIRTUAL_BTC || '0.00001');

// BUY on dips
if (current <= lowerBand) {
  console.log(
    `[${now}] RANGE BUY: price ${current} <= lowerBand ${lowerBand.toFixed(2)}, buying $${buyUsd}`
  );
  await placePaperOrder(symbol, 'buy', buyUsd);
}

// SELL on strong highs (ultra-safe skim)
else if (
  sellEnabled &&
  virtualBtc > minVirtualBtc &&
  current >= upperBand * (1 + extraBandPct / 100)
) {
  const maxSellQty = virtualBtc * maxSellFraction;
  const sellUsd = maxSellQty * current;

  console.log(
    `[${now}] RANGE SELL: price ${current} >= upperBand * (1 + ${extraBandPct}%), selling up to ${(
      maxSellFraction * 100
    ).toFixed(0)}% of virtual BTC (~$${sellUsd.toFixed(2)})`
  );

  if (sellUsd > 0) {
    await placePaperOrder(symbol, 'sell', sellUsd);
  } else {
    console.log(`[${now}] Sell skipped – computed sellUsd <= 0`);
  }
}

// nothing to do
else {
  console.log(`[${now}] No action (range, conservative).`);
}
    // === CONSERVATIVE SELL: skim a small slice only on strong highs ===
    else if (
      sellEnabled &&
      virtualBtc > minVirtualBtc &&
      current >= upperBand * (1 + extraBandPct / 100)
    ) {
      const maxSellQty = virtualBtc * maxSellFraction;
      const sellUsd = maxSellQty * current;

      console.log(
        `[${now}] RANGE SELL: price ${current} >= upperBand * (1+${extraBandPct}%), selling up to ${maxSellFraction *
          100}% of virtual BTC (~$${sellUsd.toFixed(2)})`
      );

      if (sellUsd > 0) {
        await placePaperOrder(symbol, 'sell', sellUsd);
      } else {
        console.log(`[${now}] Sell skipped – computed sellUsd <= 0`);
      }
    }
    // === NEUTRAL ===
    else {
      console.log(`[${now}] No action (range, conservative).`);
    }

  } catch (err) {
    const now = new Date().toISOString();
    console.log(`[${now}] ERROR: ${err.message || err}`);
  }
}
setInterval(strategyTick, 15 * 60 * 1000); // every 15 min

const port = process.env.PORT || 10000;
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(port, () => console.log(`CN listening on :${port}`));

