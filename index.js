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
  const p = (product || '').toUpperCase();
  if (p === 'BTC-USDC') return 'BTC-USD';
  if (p === 'ETH-USDC') return 'ETH-USD';
  return p;
}

// --- HELPERS ---
async function getPublicTicker(product = 'BTC-USD') {
  const exProduct = normalizeProductForExchange(product);
  const url = `https://api.exchange.coinbase.com/products/${exProduct}/ticker`;
  const r = await fetch(ur
