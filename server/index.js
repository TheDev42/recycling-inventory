import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { all, db, DATA_DIR, HttpError, today, getSetting, setSetting } from './db.js';
import * as items from './items.js';
import * as collections from './collections.js';
import * as ebay from './ebay.js';
import * as ebayData from './ebayData.js';
import { dashboard } from './dashboard.js';
import { writeLabelsPdf, DEFAULT_LABEL } from './label.js';

const app = express();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COMPANY = process.env.COMPANY_NAME || 'Recycling Inventory';
const id = (req, name = 'id') => {
  const n = parseInt(req.params[name], 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id');
  return n;
};
// Express 4 does not catch a rejected promise by itself; the eBay routes are the only async ones
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* Optional basic-auth: set AUTH_USER and AUTH_PASS */
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
  app.use((req, res, next) => {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const decoded = Buffer.from(b64, 'base64').toString();
      const i = decoded.indexOf(':');
      if (i >= 0 && same(decoded.slice(0, i), process.env.AUTH_USER) && same(decoded.slice(i + 1), process.env.AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Inventory"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '1mb' }));

/* ---------- meta ---------- */
const labelSize = () => {
  const mm = (key, fallback) => {
    const n = Number(getSetting(key));
    return n >= 10 && n <= 300 ? n : fallback;
  };
  return { widthMm: mm('label_w', DEFAULT_LABEL.w), heightMm: mm('label_h', DEFAULT_LABEL.h) };
};

app.get('/api/meta', (_req, res) => {
  res.json({
    kinds: items.KINDS,
    kindLabels: items.KIND_LABEL,
    statuses: items.STATUSES,
    statusLabels: items.STATUS_LABEL,
    categories: items.categoryList(),
    driveKinds: items.DRIVE_KINDS,
    wipeMethods: items.WIPE_METHODS,
    barcodePrefix: items.BARCODE_PREFIX,
    company: COMPANY,
    today: today(),
    ebay: { configured: ebay.isConfigured(), connected: ebay.isConnected(), maxDays: ebay.MAX_DAYS },
  });
});

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));

/* ---------- scanning ---------- */
app.post('/api/scan', (req, res) => res.json(items.handleScan(req.body)));

/* ---------- items ---------- */
// Guard against spreadsheet formula injection in text cells
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sendCsv = (res, name, cols, rows) => {
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${today()}.csv"` });
  res.send('﻿' + csv);
};

app.get('/api/items', (req, res) => res.json(items.listItems(req.query)));

app.get('/api/items/export.csv', (req, res) => {
  const total = items.listItems({ ...req.query, limit: 1 }).total;
  let list = [];
  for (let off = 0; off < total; off += 1000) list = list.concat(items.listItems({ ...req.query, limit: 1000, offset: off }).items);
  sendCsv(res, 'inventory', ['barcode', 'kind', 'status', 'name', 'category', 'brand', 'model', 'serial', 'mac', 'condition', 'location',
    'purchase_price', 'repair_cost', 'purchase_date', 'source', 'supplier', 'collection_ref', 'data_status', 'sale_price', 'sale_fees', 'sale_postage', 'sold_at', 'notes'], list);
});

app.post('/api/items', (req, res) => res.status(201).json(items.createItem(req.body || {})));
app.get('/api/items/:id', (req, res) => res.json(items.itemDetail(id(req))));
app.put('/api/items/:id', (req, res) => res.json(items.updateItem(id(req), req.body || {})));
app.delete('/api/items/:id', (req, res) => { items.deleteItem(id(req)); res.json({ ok: true }); });
app.post('/api/items/:id/status', (req, res) => res.json(items.setStatus(id(req), req.body?.status, req.body?.note)));
app.post('/api/items/:id/comments', (req, res) => res.status(201).json(items.addComment(id(req), req.body?.text)));
app.delete('/api/comments/:id', (req, res) => { items.deleteComment(id(req)); res.json({ ok: true }); });

/* ---------- drives and data wiping ---------- */
app.post('/api/items/:id/drives', (req, res) => res.status(201).json(items.addDrive(id(req), req.body || {})));
app.post('/api/items/:id/drives/:driveId/wipe', (req, res) => res.json(items.wipeDrive(id(req), id(req, 'driveId'), req.body || {})));
app.post('/api/items/:id/drives/:driveId/unwipe', (req, res) => res.json(items.unwipeDrive(id(req), id(req, 'driveId'))));
app.delete('/api/items/:id/drives/:driveId', (req, res) => res.json(items.deleteDrive(id(req), id(req, 'driveId'))));
app.post('/api/items/:id/wipe', (req, res) => res.json(items.wipeAll(id(req), req.body || {})));
app.get('/api/wipe-log', (_req, res) => res.json(items.wipeLog()));
app.get('/api/wipe-log/export.csv', (_req, res) => {
  sendCsv(res, 'wipe-log', ['wiped_at', 'barcode', 'name', 'item_serial', 'kind', 'serial', 'capacity', 'status', 'method', 'collection_ref', 'collected_from', 'notes'], items.wipeLog(100000));
});

/* ---------- sales ---------- */
app.get('/api/sales', (_req, res) => res.json(items.listSales()));
app.post('/api/items/:id/sale', (req, res) => res.status(201).json(items.sellItem(id(req), req.body || {})));
app.delete('/api/items/:id/sale', (req, res) => res.json(items.undoSale(id(req))));

/* ---------- labels ---------- */
// ?ids=1,2,3 — one label per page, in barcode order. Opens in the browser's PDF viewer, ready to print.
app.get('/api/labels.pdf', (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger))].slice(0, 500);
  if (!ids.length) throw new HttpError(400, 'No items chosen');
  const rows = all(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY barcode COLLATE NOCASE`, ...ids);
  if (!rows.length) throw new HttpError(404, 'Those items no longer exist');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="labels-${today()}.pdf"` });
  writeLabelsPdf(res, rows, labelSize());
});

/* ---------- WEEE collections ---------- */
app.get('/api/collections', (_req, res) => res.json(collections.listCollections()));
app.post('/api/collections', (req, res) => res.status(201).json(collections.createCollection(req.body || {})));
app.get('/api/collections/:id', (req, res) => res.json(collections.collectionDetail(id(req))));
app.put('/api/collections/:id', (req, res) => res.json(collections.updateCollection(id(req), req.body || {})));
app.delete('/api/collections/:id', (req, res) => { collections.deleteCollection(id(req)); res.json({ ok: true }); });
app.post('/api/collections/:id/items', (req, res) => res.status(201).json(collections.addItems(id(req), req.body || {})));

/* ---------- settings ---------- */
const settingsView = () => {
  const cfg = ebay.config();
  return {
    label: labelSize(),
    // the Cert ID is never sent back to the browser, only whether one is saved
    ebay: { env: cfg.env, siteId: cfg.siteId, clientId: cfg.clientId, ruName: cfg.ruName, hasSecret: !!cfg.clientSecret,
      configured: ebay.isConfigured(cfg), connected: ebay.isConnected() },
  };
};
app.get('/api/settings', (_req, res) => res.json(settingsView()));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  for (const key of ['label_w', 'label_h']) {
    if (!(key in b)) continue;
    const n = Number(b[key]);
    if (!(n >= 10 && n <= 300)) throw new HttpError(400, 'Label sizes are in millimetres, between 10 and 300');
    setSetting(key, n);
  }
  if ('ebay_env' in b) setSetting('ebay_env', b.ebay_env === 'sandbox' ? 'sandbox' : 'production');
  if ('ebay_site_id' in b) setSetting('ebay_site_id', String(parseInt(b.ebay_site_id, 10) || 3));
  if ('ebay_client_id' in b) setSetting('ebay_client_id', String(b.ebay_client_id).trim().slice(0, 200));
  if ('ebay_runame' in b) setSetting('ebay_runame', String(b.ebay_runame).trim().slice(0, 200));
  // left blank = keep the Cert ID that is already saved
  if (String(b.ebay_client_secret ?? '').trim()) setSetting('ebay_client_secret', String(b.ebay_client_secret).trim().slice(0, 200));
  res.json(settingsView());
});

/* ---------- eBay ---------- */
app.get('/api/ebay/consent-url', (_req, res) => res.json({ url: ebay.consentUrl() }));
app.post('/api/ebay/connect', wrap(async (req, res) => { await ebay.connect(req.body?.code); res.json(settingsView()); }));
app.post('/api/ebay/disconnect', (_req, res) => { ebay.disconnect(); res.json(settingsView()); });
// If the RuName's "auth accepted URL" points at https://<this site>/ebay/callback, signing in finishes by itself
app.get('/ebay/callback', wrap(async (req, res) => {
  try {
    await ebay.connect(String(req.query.code || ''));
    res.redirect('/#/settings?ebay=connected');
  } catch (err) {
    res.redirect(`/#/settings?ebay=${encodeURIComponent(err.message)}`);
  }
}));

app.get('/api/ebay/purchases', (_req, res) => res.json(ebayData.listPurchases()));
app.post('/api/ebay/purchases/fetch', wrap(async (req, res) => res.json(ebayData.savePurchases(await ebay.fetchPurchases(req.body?.days)))));
app.get('/api/ebay/purchases/:id/defaults', (req, res) => res.json(ebayData.purchaseDefaults(id(req))));
app.post('/api/ebay/purchases/:id/add', (req, res) => res.status(201).json(ebayData.addPurchase(id(req))));
app.post('/api/ebay/purchases/:id/hide', (req, res) => res.json(ebayData.hidePurchase(id(req), req.body?.hidden !== false)));

app.get('/api/ebay/sales', (_req, res) => res.json(ebayData.listEbaySales()));
app.post('/api/ebay/sales/fetch', wrap(async (req, res) => res.json(ebayData.saveSales(await ebay.fetchSales(req.body?.days)))));
app.get('/api/ebay/sales/:id/candidates', (req, res) => res.json(ebayData.saleCandidates(id(req), req.query.q)));
app.post('/api/ebay/sales/:id/match', (req, res) => res.status(201).json(ebayData.matchSale(id(req), req.body || {})));
app.post('/api/ebay/sales/:id/hide', (req, res) => res.json(ebayData.hideSale(id(req), req.body?.hidden !== false)));

/* ---------- backup ---------- */
app.get('/api/backup', (_req, res, next) => {
  const file = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (err) { return next(err); }
  res.download(file, `recycling-inventory-backup-${today()}.db`, () => fs.rm(file, { force: true }, () => {}));
});

/* ---------- static frontend ---------- */
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Recycling inventory listening on :${port} (data in ${DATA_DIR})`));
