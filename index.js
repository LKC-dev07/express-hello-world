import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
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
  MAX_TRADE_USD = '500',
  ALLOWED_PRODUCTS = 'BTC-USDC,ETH-USDC',

  // Strategy
  STRAT_ENABLED = 'false',

  // Coinbase (live trading – Coinbase App / Advanced Trade)
  COINBASE_API_KEY,   // organizations/.../apiKeys/...
  COINBASE_API_SECRET // full EC PRIVATE KEY PEM
} = process.env;

const allowed = new Set(
  ALLOWED_PRODUCTS.split(',').map(x => x.trim().toUpperCase())
);
const isPaper = PAPER_TRADING === 'true';

let stratOverrideEnabled = null; // null = use env, boolean = override

// --- AUTH (our own admin token) ---
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!CN_ADMIN_TOKEN || tok !== CN_ADMIN_TOKEN)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- PRODUCT NORMALIZATION FOR EXCHANGE TICKER ---
// Coinbase Exchange API may not know BTC-USDC directly, but does know BTC-USD.
// For pricing only, we can safely map BTC-USDC -> BTC-USD, ETH-USDC -> ETH-USD.
function normalizeProductForExchange(product) {
  const p = String(product || '').trim().toUpperCase();
  if (p === 'BTC-USDC') return 'BTC-USD';
  if (p === 'ETH-USDC') return 'ETH-USD';
  return p;
}

// --- HELPERS ---
async function getPublicTicker(product = 'BTC-USD') {
  const exProduct = normalizeProductForExchange(product);
  const url = `https://api.exchange.coinbase.com/products/${exProduct}/ticker`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
  if (!r.ok) {
    console.log(`[TICKER ERROR] ${exProduct} -> ${r.status}`);
    throw new Error(`ticker failed: ${r.status}`);
  }
  const j = await r.json();
  return { price: Number(j.price), bid: Number(j.bid), ask: Number(j.ask) };
}

async function getHistoricPrice(product = 'BTC-USD', hours = 12) {
  const exProduct = normalizeProductForExchange(product);
  try {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const url = `https://api.exchange.coinbase.com/products/${exProduct}/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CN/1.0' } });
    if (!r.ok) throw new Error(`historic failed: ${r.status}`);
    const candles = await r.json();
    if (!Array.isArray(candles) || !candles.length)
      throw new Error('no candle data');
    const closes = candles.map(c => c[4]);
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  } catch (err) {
    console.log(`[WARN historic] ${err.message}`);
    const { price } = await getPublicTicker(exProduct);
    return price;
  }
}

// ATR function
async function getATR(product = 'BTC-USD', hours = 12) {
  const exProduct = normalizeProductForExchange(product);
  try {
    const gran = 3600;
    const url = `https://api.exchange.coinbase.com/products/${exProduct}/candles?granularity=${gran}`;
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

// --- JWT BUILDER (Coinbase App API Key Auth, JS snippet style) ---
function buildCoinbaseJwt(method, path) {
  if (!COINBASE_API_KEY || !COINBASE_API_SECRET) {
    throw new Error('Missing Coinbase API credentials');
  }

  const keyName = COINBASE_API_KEY; // organizations/.../apiKeys/...

  // Handle both multiline PEM and \n-escaped PEM from env
  let keySecret = COINBASE_API_SECRET;
  if (keySecret.includes('\\n')) {
    keySecret = keySecret.replace(/\\n/g, '\n');
  }

  const requestMethod = method.toUpperCase();
  const requestHost = 'api.coinbase.com';
  const requestPath = path;

  const uri = `${requestMethod} ${requestHost}${requestPath}`;
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: 'cdp',
    nbf: now,
    exp: now + 120, // 2 minutes
    sub: keyName,
    uri
  };

  const header = {
    kid: keyName,
    nonce: crypto.randomBytes(16).toString('hex')
  };

  try {
    // Use PEM string directly, like Coinbase’s JS snippet
    const token = jwt.sign(payload, keySecret, {
      algorithm: 'ES256',
      header
    });

    return token;
  } catch (e) {
    console.error('Coinbase JWT sign error:', e.message);
    throw new Error(
      'Failed to sign Coinbase JWT – check that COINBASE_API_SECRET is the exact EC PRIVATE KEY PEM from the portal.'
    );
  }
}

// --- COINBASE REQUEST (uses JWT above) ---
async function coinbaseRequest(method, path, bodyObj) {
  const base = 'https://api.coinbase.com';
  const body = bodyObj ? JSON.stringify(bodyObj) : '';

  const jwtToken = buildCoinbaseJwt(method, path);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${jwtToken}`
  };

  const r = await fetch(base + path, {
    method,
    headers,
    body: body || undefined
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!r.ok) {
    throw new Error(`Coinbase error ${r.status}: ${text}`);
  }

  return json;
}

// --- VIRTUAL BALANCES + ORDER TRACKING ---
let virtualBtc = 0;
let virtualUsd = 0;
let recentOrders = [];

function recordOrder(entry) {
  recentOrders.push({ ...entry, time: new Date().toISOString() });
  if (recentOrders.length > 50) recentOrders.shift();
}

// --- PAPER ORDER HELPER ---
async function placePaperOrder(product = 'BTC-USDC', side = 'buy', usd = 5) {
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

  const payload = {
    mode: 'paper',
    product,
    side,
    usd,
    est_price: t.price,
    est_qty: qty,
    balances: {
      virtualBtc,
      virtualUsd
    },
    time: new Date().toISOString()
  };

  recordOrder({
    mode: 'paper',
    product,
    side,
    usd,
    price: t.price,
    qty
  });

  console.log(
    `[AUTO PAPER] ${side.toUpperCase()} $${usd} @ ${t.price.toFixed(
      2
    )} qty=${qty}, balances: BTC=${virtualBtc.toFixed(
      6
    )}, USD=${virtualUsd.toFixed(2)}`
  );

  return payload;
}

// --- LIVE ORDER HELPER ---
async function placeLiveOrder(
  product = 'BTC-USDC',
  side = 'buy',
  quoteAmount = 5
) {
  const path = '/api/v3/brokerage/orders';
  const upperSide = side.toUpperCase();

  let order_configuration;

  if (upperSide === 'BUY') {
    // For market BUYs, Coinbase allows quote_size (amount in USDC)
    order_configuration = {
      market_market_ioc: {
        quote_size: String(quoteAmount)
      }
    };
  } else if (upperSide === 'SELL') {
    // For market SELLs, Coinbase requires base_size (amount in BTC)
    // We treat quoteAmount as "how much USDC value you want to sell",
    // then convert to BTC using the current ticker price.
    const { price } = await getPublicTicker(product); // price = quote per 1 base
    const baseSize = quoteAmount / price; // BTC = USDC / (USDC per BTC)

    // 8 decimal places is typical for BTC
    const baseSizeStr = baseSize.toFixed(8);

    order_configuration = {
      market_market_ioc: {
        base_size: baseSizeStr
      }
    };
  } else {
    throw new Error(`Unsupported side: ${side}`);
  }

  const body = {
    product_id: product,
    side: upperSide, // BUY or SELL
    order_configuration
  };

  const response = await coinbaseRequest('POST', path, body);

  recordOrder({
    mode: 'live',
    product,
    side: upperSide,
    usd: quoteAmount,
    responseSummary: {
      success: response.success,
      order_id: response.success ? response.order_id : undefined
    }
  });

  console.log(
    `[LIVE ORDER] ${upperSide} ${product} for ~${quoteAmount} quote (USDC)`
  );
  console.log('[LIVE ORDER RESPONSE]', response);

  return response;
}

// --- API ROUTES ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, paper: isPaper, time: new Date().toISOString() });
});

app.post('/api/paper-order', requireAdmin, async (req, res) => {
  try {
    const { product = 'BTC-USDC', side = 'buy', usd = 5 } = req.body;
    const out = await placePaperOrder(product, side, usd);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let lastBuyTimestamp = 0; // cooldown tracking

// --- LIVE ORDER ROUTE ---
app.post('/api/live-order', requireAdmin, async (req, res) => {
  try {
    if (isPaper) {
      return res.status(400).json({
        error:
          'paper mode enabled — set PAPER_TRADING=false to place live orders'
      });
    }

    const { product = 'BTC-USDC', side = 'BUY', usd = 5 } = req.body;

    if (usd <= 0) {
      return res.status(400).json({ error: 'usd must be > 0' });
    }

    if (usd > Number(MAX_TRADE_USD)) {
      return res.status(400).json({
        error: 'usd exceeds MAX_TRADE_USD',
        maxTradeUsd: Number(MAX_TRA_
