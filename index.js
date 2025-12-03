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
  ALLOWED_PRODUCTS = 'BTC-USD,ETH-USD',

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
    if (!Array.isArray(candles) || !candles.length)
      throw new Error('no candle data');
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

// --- JWT BUILDER (Coinbase App API Key Auth, JS snippet style) ---
function buildCoinbaseJwt(method, path) {
  if (!COINBASE_API_KEY || !COINBASE_API_SECRET) {
    throw new Error('Missing Coinbase API credentials');
  }

  const keyName = COINBASE_API_KEY;      // organizations/.../apiKeys/...
  const keySecret = COINBASE_API_SECRET; // full PEM private key

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

  const token = jwt.sign(payload, keySecret, {
    algorithm: 'ES256',
    header
  });

  return token;
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
async function placeLiveOrder(product = 'BTC-USD', side = 'buy', usd = 5) {
  const path = '/api/v3/brokerage/orders';

  const body = {
    product_id: product,
    side: side.toUpperCase(), // BUY or SELL
    order_configuration: {
      market_market_ioc: {
        quote_size: String(usd)
      }
    }
  };

  const response = await coinbaseRequest('POST', path, body);

  recordOrder({
    mode: 'live',
    product,
    side,
    usd,
    responseSummary: {
      success: response.success,
      order_id: response.success ? response.order_id : undefined
    }
  });

  console.log(`[LIVE ORDER] ${side.toUpperCase()} $${usd} ${product}`);
  console.log('[LIVE ORDER RESPONSE]', response);

  return response;
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

// --- LIVE ORDER ROUTE ---
app.post('/api/live-order', requireAdmin, async (req, res) => {
  try {
    if (isPaper) {
      return res.status(400).json({
        error:
          'paper mode enabled — set PAPER_TRADING=false to place live orders'
      });
    }

    const { product = 'BTC-USD', side = 'BUY', usd = 5 } = req.body;

    if (usd <= 0) {
      return res.status(400).json({ error: 'usd must be > 0' });
    }

    if (usd > Number(MAX_TRADE_USD)) {
      return res.status(400).json({
        error: 'usd exceeds MAX_TRADE_USD',
        maxTradeUsd: Number(MAX_TRADE_USD)
      });
    }

    if (!allowed.has(product.toUpperCase())) {
      return res.status(400).json({ error: 'symbol not allowed' });
    }

    const out = await placeLiveOrder(product, side, usd);

    console.log(
      `[LIVE ORDER] ${side.toUpperCase()} ${product} for $${usd} placed successfully.`
    );
    res.json({ ok: true, placed: true, response: out });
  } catch (err) {
    console.log(`[LIVE ORDER ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// --- STATUS ROUTE ---
app.get('/api/status', requireAdmin, (_req, res) => {
  const strategyEnabled =
    stratOverrideEnabled !== null
      ? stratOverrideEnabled
      : STRAT_ENABLED === 'true';

  res.json({
    paper: isPaper,
    strategyEnabled,
    allowedProducts: [...allowed],
    maxTradeUsd: Number(MAX_TRADE_USD),
    virtualBalances: {
      virtualBtc,
      virtualUsd
    },
    recentOrders
  });
});

// --- STRATEGY TICK ---
async function strategyTick(trigger = 'auto') {
  try {
    const stratIsEnabled =
      stratOverrideEnabled !== null
        ? stratOverrideEnabled
        : STRAT_ENABLED === 'true';

    if (!stratIsEnabled) return;

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

    const sellEnabled = process.env.STRAT_SELL_ENABLED === 'true';
    const maxSellFrac = Number(process.env.STRAT_SELL_MAX_FRACTION || '0.2');
    const extraBand = Number(process.env.STRAT_SELL_EXTRA_BAND_PCT || '0.5');
    const minBtc = Number(process.env.STRAT_MIN_VIRTUAL_BTC || '0.00001');

    const cooldownSec = Number(process.env.STRAT_COOLDOWN_SEC || '1800');
    const nowSec = Math.floor(Date.now() / 1000);

    // BUY on dips (paper-only)
    if (current <= lower) {
      if (nowSec - lastBuyTimestamp < cooldownSec) {
        console.log(
          `[${now}] Cooldown active: last buy ${(
            (nowSec - lastBuyTimestamp) /
            60
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

      lastBuyTimestamp = nowSec;
      return;
    }

    // SELL skim only on strong highs (paper)
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

      await placePaperOrder(symbol, 'sell', usdVal);
      return;
    }

    console.log(`[${now}] No action (conservative).`);
  } catch (err) {
    console.log(`[STRAT ERROR] ${err.message}`);
  }
}

setInterval(strategyTick, 15 * 60 * 1000);

// --- STRATEGY CONTROL ROUTES ---
app.post('/api/strategy/enabled', requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  stratOverrideEnabled = Boolean(enabled);
  res.json({
    ok: true,
    strategyEnabled: stratOverrideEnabled
  });
});

app.post('/api/strategy/tick', requireAdmin, async (_req, res) => {
  try {
    await strategyTick('manual');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SERVE FRONTEND ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`CN listening on :${port}`));
