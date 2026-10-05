import { all, get, run, tx, HttpError } from './db.js';
import { createItem, sellItem, listItems, ITEM_SELECT } from './items.js';

/* What has been pulled from eBay, and how it ties up with the inventory. */

const round2 = (n) => Math.round(n * 100) / 100;
const day = (isoTime) => (/^\d{4}-\d{2}-\d{2}/.test(isoTime || '') ? isoTime.slice(0, 10) : null);

const GUESSES = [
  [/mother\s?board|main\s?board|logic board/i, 'Motherboard'],
  [/laptop|notebook|macbook|thinkpad|chromebook/i, 'Laptop'],
  [/graphics card|\bgpu\b|geforce|radeon/i, 'Graphics card'],
  [/\b(ssd|hdd|nvme)\b|hard drive/i, 'Hard drive / SSD'],
  [/iphone|smartphone|\bphone\b/i, 'Phone'],
  [/ipad|tablet/i, 'Tablet'],
  [/monitor/i, 'Monitor'],
  [/router|switch|access point/i, 'Network equipment'],
  [/playstation|xbox|nintendo|console/i, 'Games console'],
  [/desktop|\bpc\b|imac|tower/i, 'Desktop PC'],
];
const guessCategory = (title) => GUESSES.find(([re]) => re.test(title || ''))?.[1] || '';

/* ---------- purchases ---------- */

export function savePurchases(list) {
  return tx(() => {
    let added = 0;
    for (const p of list) {
      if (!p.order_id || !p.ebay_item_id) continue;
      const known = get('SELECT id FROM ebay_purchases WHERE order_id = ? AND ebay_item_id = ? AND transaction_id = ?', p.order_id, p.ebay_item_id, p.transaction_id);
      if (known) {
        run('UPDATE ebay_purchases SET title = ?, price = ?, postage = ?, currency = ?, quantity = ?, seller = ?, purchased_at = ? WHERE id = ?',
          p.title, p.price, p.postage, p.currency, p.quantity, p.seller, p.purchased_at, known.id);
      } else {
        run(`INSERT INTO ebay_purchases (order_id, ebay_item_id, transaction_id, title, price, postage, currency, quantity, seller, purchased_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p.order_id, p.ebay_item_id, p.transaction_id, p.title, p.price, p.postage, p.currency, p.quantity, p.seller, p.purchased_at);
        added++;
      }
    }
    return { fetched: list.length, added };
  });
}

export function listPurchases() {
  const items = all('SELECT id, barcode, ebay_purchase_id FROM items WHERE ebay_purchase_id IS NOT NULL ORDER BY id');
  return all('SELECT * FROM ebay_purchases ORDER BY purchased_at DESC, id DESC').map((p) => ({
    ...p, items: items.filter((i) => i.ebay_purchase_id === p.id),
  }));
}

function mustPurchase(id) {
  const p = get('SELECT * FROM ebay_purchases WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'eBay purchase not found');
  return p;
}

// What a new inventory item made from this purchase starts with. Postage is part of what it cost.
export function purchaseDefaults(id) {
  const p = mustPurchase(id);
  return {
    kind: 'repair', name: p.title || `eBay item ${p.ebay_item_id}`, category: guessCategory(p.title),
    purchase_price: p.price == null ? '' : round2(p.price + (p.postage || 0)), purchase_date: day(p.purchased_at) || '',
    source: 'eBay', supplier: p.seller || '', ebay_purchase_id: p.id,
  };
}

// One inventory item for every unit bought that is not on the inventory yet
export function addPurchase(id) {
  return tx(() => {
    const p = mustPurchase(id);
    const have = get('SELECT COUNT(*) AS n FROM items WHERE ebay_purchase_id = ?', id).n;
    if (have >= p.quantity) throw new HttpError(409, 'That purchase is already on the inventory');
    const created = [];
    for (let i = have; i < p.quantity; i++) created.push(createItem(purchaseDefaults(id)));
    return { created };
  });
}

export function hidePurchase(id, hidden) {
  mustPurchase(id);
  run('UPDATE ebay_purchases SET hidden = ? WHERE id = ?', !!hidden, id);
  return { ok: true };
}

/* ---------- sales ---------- */

export function saveSales(list) {
  return tx(() => {
    let added = 0;
    for (const s of list) {
      if (!s.line_item_id) continue;
      const known = get('SELECT id FROM ebay_sales WHERE line_item_id = ?', s.line_item_id);
      if (known) {
        run('UPDATE ebay_sales SET title = ?, price = ?, postage_charged = ?, fee = ?, currency = ?, quantity = ?, buyer = ?, sold_at = ? WHERE id = ?',
          s.title, s.price, s.postage_charged, s.fee, s.currency, s.quantity, s.buyer, s.sold_at, known.id);
      } else {
        run(`INSERT INTO ebay_sales (order_id, line_item_id, ebay_item_id, title, price, postage_charged, fee, currency, quantity, buyer, sold_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          s.order_id, s.line_item_id, s.ebay_item_id, s.title, s.price, s.postage_charged, s.fee, s.currency, s.quantity, s.buyer, s.sold_at);
        added++;
      }
    }
    return { fetched: list.length, added };
  });
}

export function listEbaySales() {
  const matched = all(`SELECT s.ebay_sale_id, i.id, i.barcode, i.name FROM sales s JOIN items i ON i.id = s.item_id
                       WHERE s.ebay_sale_id IS NOT NULL ORDER BY s.id`);
  return all('SELECT * FROM ebay_sales ORDER BY sold_at DESC, id DESC').map((s) => ({
    ...s, items: matched.filter((m) => m.ebay_sale_id === s.id),
  }));
}

function mustSale(id) {
  const s = get('SELECT * FROM ebay_sales WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'eBay sale not found');
  return s;
}

export function hideSale(id, hidden) {
  mustSale(id);
  run('UPDATE ebay_sales SET hidden = ? WHERE id = ?', !!hidden, id);
  return { ok: true };
}

// What one unit of this sale brought in: the price plus the postage the buyer paid, and its share of eBay's fees
const perUnit = (s) => ({
  sale_price: round2(((s.price || 0) + (s.postage_charged || 0)) / s.quantity),
  fees: round2((s.fee || 0) / s.quantity),
});

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []);

// Which unsold items this sale could be. With a search, whatever matches it; without, the items whose
// name / brand / model share the most words with the listing title (model words count double).
export function saleCandidates(id, q) {
  const sale = mustSale(id);
  const defaults = perUnit(sale);
  if (String(q || '').trim()) return { sale, defaults, items: listItems({ q, status: 'active', limit: 25 }).items };
  const title = words(sale.title);
  const hits = (text, weight) => [...words(text)].filter((w) => title.has(w)).length * weight;
  const items = all(`${ITEM_SELECT} WHERE i.status NOT IN ('sold', 'recycled')`)
    .map((it) => ({ ...it, score: hits(it.name, 1) + hits(it.brand, 1) + hits(it.model, 2) }))
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, 12);
  return { sale, defaults, items };
}

// Marks the item as sold against this eBay sale. The amounts default to the sale's own figures per unit.
export function matchSale(id, body = {}) {
  return tx(() => {
    const sale = mustSale(id);
    const itemId = Number(body.item_id);
    if (!Number.isInteger(itemId)) throw new HttpError(400, 'Choose the item that was sold');
    const d = perUnit(sale);
    const given = (v, fallback) => (v === '' || v === null || v === undefined ? fallback : v);
    return sellItem(itemId, {
      sale_price: given(body.sale_price, d.sale_price), fees: given(body.fees, d.fees), postage: given(body.postage, 0),
      sold_at: day(sale.sold_at), platform: 'eBay', buyer: sale.buyer, ebay_sale_id: id,
    });
  });
}
