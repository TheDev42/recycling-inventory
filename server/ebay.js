import { XMLParser } from 'fast-xml-parser';
import { getSetting, setSetting, HttpError } from './db.js';

/*
 * eBay API client. Signing in uses eBay's OAuth "authorization code" flow; after that:
 *   - what you bought comes from the Trading API (GetOrders with OrderRole = Buyer) — eBay has no newer API for purchases;
 *   - what you sold comes from the Sell Fulfillment API (getOrders), which also reports the fees.
 * Both only ever read from the account.
 */

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
].join(' ');
const TRADING_VERSION = '1193';
const TIMEOUT_MS = 30000;
export const MAX_DAYS = 90; // eBay only hands out the last 90 days of orders

// Keys typed into the Settings page win; the EBAY_* environment variables are the fallback.
export function config() {
  return {
    env: getSetting('ebay_env') || process.env.EBAY_ENV || 'production',
    siteId: getSetting('ebay_site_id') || process.env.EBAY_SITE_ID || '3', // 3 = eBay UK
    clientId: getSetting('ebay_client_id') || process.env.EBAY_CLIENT_ID || '',
    clientSecret: getSetting('ebay_client_secret') || process.env.EBAY_CLIENT_SECRET || '',
    ruName: getSetting('ebay_runame') || process.env.EBAY_RUNAME || '',
  };
}
export const isConfigured = (cfg = config()) => !!(cfg.clientId && cfg.clientSecret && cfg.ruName);
export const isConnected = () => !!getSetting('ebay_refresh_token');

const hosts = (cfg) => (cfg.env === 'sandbox'
  ? { auth: 'https://auth.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com' }
  : { auth: 'https://auth.ebay.com', api: 'https://api.ebay.com' });

async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new HttpError(502, `Could not reach eBay: ${err.cause?.message || err.message}`);
  }
}

/* ---------- signing in ---------- */

export function consentUrl() {
  const cfg = config();
  if (!isConfigured(cfg)) throw new HttpError(409, 'Enter the eBay App ID, Cert ID and RuName first');
  const query = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.ruName, response_type: 'code', scope: SCOPES });
  return `${hosts(cfg).auth}/oauth2/authorize?${query}`;
}

async function tokenRequest(cfg, params) {
  const res = await request(`${hosts(cfg).api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new HttpError(502, `eBay sign-in failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  setSetting('ebay_access_token', body.access_token);
  setSetting('ebay_access_expires', Date.now() + (Number(body.expires_in) || 0) * 1000);
  if (body.refresh_token) setSetting('ebay_refresh_token', body.refresh_token);
  return body.access_token;
}

// Takes either the code itself or the whole address eBay sent the browser to after you agreed
export function codeFrom(pasted) {
  const s = String(pasted ?? '').trim();
  if (!s) throw new HttpError(400, 'Paste the address of the page eBay sent you to');
  if (/^https?:\/\//i.test(s)) {
    let code = null;
    try { code = new URL(s).searchParams.get('code'); } catch { /* not a usable address */ }
    if (!code) throw new HttpError(400, 'That address has no eBay code in it. Copy the whole address, starting with https://');
    return code;
  }
  try { return decodeURIComponent(s); } catch { return s; }
}

export async function connect(pasted) {
  const cfg = config();
  if (!isConfigured(cfg)) throw new HttpError(409, 'Enter the eBay App ID, Cert ID and RuName first');
  await tokenRequest(cfg, { grant_type: 'authorization_code', code: codeFrom(pasted), redirect_uri: cfg.ruName });
  if (!isConnected()) throw new HttpError(502, 'eBay did not return a long-lived token. Try signing in again');
}

export function disconnect() {
  for (const key of ['ebay_access_token', 'ebay_access_expires', 'ebay_refresh_token']) setSetting(key, '');
}

async function accessToken() {
  const cfg = config();
  if (!isConfigured(cfg) || !isConnected()) throw new HttpError(409, 'eBay is not connected yet. Set it up on the Settings page');
  if (getSetting('ebay_access_token') && Number(getSetting('ebay_access_expires')) > Date.now() + 60000) return getSetting('ebay_access_token');
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: getSetting('ebay_refresh_token'), scope: SCOPES });
}

/* ---------- purchases (Trading API, XML) ---------- */

const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false,
  isArray: (name) => name === 'Order' || name === 'Transaction' || name === 'Errors',
});
const str = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();
// <TransactionPrice currencyID="GBP">12.50</TransactionPrice>
const amount = (node) => {
  const n = parseFloat(str(node));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

// A GetOrders response -> { purchases, hasMore }. price and postage are per unit.
export function parsePurchases(xmlText) {
  const root = xml.parse(xmlText)?.GetOrdersResponse;
  if (!root) throw new HttpError(502, 'eBay sent back something unexpected');
  if (!['Success', 'Warning'].includes(str(root.Ack))) {
    const e = root.Errors?.[0];
    throw new HttpError(502, `eBay returned an error: ${str(e?.LongMessage) || str(e?.ShortMessage) || 'unknown error'}`);
  }
  const purchases = [];
  for (const order of root.OrderArray?.Order || []) {
    if (['Cancelled', 'Inactive'].includes(str(order.OrderStatus))) continue;
    const lines = order.TransactionArray?.Transaction || [];
    const qty = (t) => Math.max(parseInt(str(t.QuantityPurchased), 10) || 1, 1);
    const units = lines.reduce((n, t) => n + qty(t), 0) || 1;
    const postage = amount(order.ShippingServiceSelected?.ShippingServiceCost) || 0;
    for (const t of lines) {
      purchases.push({
        order_id: str(order.OrderID),
        ebay_item_id: str(t.Item?.ItemID),
        transaction_id: str(t.TransactionID),
        title: str(t.Item?.Title),
        price: amount(t.TransactionPrice),
        postage: round2(postage / units),
        currency: (typeof t.TransactionPrice === 'object' && t.TransactionPrice?.['@_currencyID']) || '',
        quantity: qty(t),
        seller: str(order.SellerUserID),
        purchased_at: str(t.CreatedDate) || str(order.CreatedTime),
      });
    }
  }
  return { purchases, hasMore: str(root.HasMoreOrders) === 'true' };
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
const clampDays = (days) => Math.min(Math.max(parseInt(days, 10) || MAX_DAYS, 1), MAX_DAYS);

export async function fetchPurchases(days) {
  const token = await accessToken();
  const cfg = config();
  const now = new Date();
  const start = new Date(now.getTime() - clampDays(days) * 86400000);
  const purchases = [];
  for (let page = 1; page <= 50; page++) {
    const res = await request(`${hosts(cfg).api}/ws/api.dll`, {
      method: 'POST',
      headers: {
        'X-EBAY-API-SITEID': cfg.siteId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_VERSION,
        'X-EBAY-API-CALL-NAME': 'GetOrders',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: '<?xml version="1.0" encoding="utf-8"?>'
        + '<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        + `<CreateTimeFrom>${iso(start)}</CreateTimeFrom><CreateTimeTo>${iso(now)}</CreateTimeTo>`
        + '<OrderRole>Buyer</OrderRole><OrderStatus>All</OrderStatus>'
        + `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`
        + '</GetOrdersRequest>',
    });
    const body = await res.text();
    if (!res.ok) throw new HttpError(502, `eBay returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    const parsed = parsePurchases(body);
    purchases.push(...parsed.purchases);
    if (!parsed.hasMore) break;
  }
  return purchases;
}

/* ---------- sales (Sell Fulfillment API, JSON) ---------- */

const value = (node) => {
  const n = parseFloat(node?.value);
  return Number.isFinite(n) ? n : 0;
};

// A getOrders response -> sold order lines. price, postage_charged and fee are totals for the line.
export function parseSales(payload) {
  const sales = [];
  for (const order of payload?.orders || []) {
    if (order.cancelStatus?.cancelState === 'CANCELED') continue;
    const lines = order.lineItems || [];
    const orderFee = value(order.totalMarketplaceFee);
    const orderCost = lines.reduce((n, l) => n + value(l.lineItemCost), 0);
    for (const line of lines) {
      const cost = value(line.lineItemCost);
      // eBay reports its fees per order, so they are shared across the lines by value
      const share = orderCost ? cost / orderCost : 1 / lines.length;
      sales.push({
        order_id: order.orderId || '',
        line_item_id: line.lineItemId || '',
        ebay_item_id: line.legacyItemId || '',
        title: line.title || '',
        price: cost,
        postage_charged: value(line.deliveryCost?.shippingCost),
        fee: round2(orderFee * share),
        currency: line.lineItemCost?.currency || '',
        quantity: Math.max(parseInt(line.quantity, 10) || 1, 1),
        buyer: order.buyer?.username || '',
        sold_at: order.creationDate || '',
      });
    }
  }
  return sales;
}

export async function fetchSales(days) {
  const token = await accessToken();
  const cfg = config();
  const start = new Date(Date.now() - clampDays(days) * 86400000);
  const sales = [];
  const limit = 200;
  for (let offset = 0; offset < 10000; offset += limit) {
    const query = new URLSearchParams({ filter: `creationdate:[${iso(start)}..]`, limit, offset });
    const res = await request(`${hosts(cfg).api}/sell/fulfillment/v1/order?${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = payload.errors?.[0] || {};
      throw new HttpError(502, `eBay returned an error: ${e.longMessage || e.message || `HTTP ${res.status}`}`);
    }
    sales.push(...parseSales(payload));
    if (offset + limit >= (Number(payload.total) || 0)) break;
  }
  return sales;
}
