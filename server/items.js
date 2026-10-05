import { all, get, run, tx, HttpError, nowIso, today, logEvent, getSetting, setSetting } from './db.js';

export const KINDS = ['repair', 'weee'];
export const KIND_LABEL = { repair: 'Repair / resale', weee: 'WEEE recycling' };
export const STATUSES = ['in_stock', 'repair', 'ready', 'listed', 'sold', 'recycled'];
export const STATUS_LABEL = {
  in_stock: 'In stock', repair: 'In repair', ready: 'Ready to sell', listed: 'Listed for sale', sold: 'Sold', recycled: 'Recycled',
};
export const CATEGORIES = [
  'Motherboard', 'Laptop', 'Desktop PC', 'Server', 'Phone', 'Tablet', 'Hard drive / SSD', 'Graphics card', 'Monitor',
  'Network equipment', 'Printer', 'Games console', 'TV / AV', 'Cables & parts', 'Other',
];
export const DRIVE_KINDS = ['HDD', 'SSD', 'NVMe / M.2', 'Built-in storage', 'Memory card', 'Other'];
// The last one is the only method that counts as "destroyed" rather than "wiped"
export const DESTROYED_METHOD = 'Physically destroyed';
export const WIPE_METHODS = ['Software overwrite', 'Secure erase (ATA / NVMe)', 'Factory reset', 'Degaussed', DESTROYED_METHOD];

// Labels are numbered R00001, R00002... BARCODE_PREFIX changes the letter(s) in front.
export const BARCODE_PREFIX = (process.env.BARCODE_PREFIX ?? 'R').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 4);
const BARCODE_DIGITS = 5;

/* ---------- cleaning what comes in ---------- */

export const normCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const text = (v, max) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};
export function money(v, label, { required = false } = {}) {
  if (v === '' || v === null || v === undefined) {
    if (required) throw new HttpError(400, `${label} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, `${label} must be an amount of money`);
  return Math.round(n * 100) / 100;
}
export function date(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${label} is not a valid date`);
  return s;
}
const refId = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

// Accepts one or more MAC addresses however they were typed or scanned (aa-bb-…, AABB.CCDD.EEFF, AABBCCDDEEFF) and
// stores them as AA:BB:CC:DD:EE:FF. Anything that is not a MAC address is kept as typed.
export function parseMacs(v) {
  const s = String(v ?? '').trim().slice(0, 200);
  if (!s) return { mac: null, mac_norm: null };
  const out = [];
  const norms = [];
  for (const part of s.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const hex = part.toUpperCase().replace(/[\s:.-]/g, '');
    if (/^[0-9A-F]+$/.test(hex) && hex.length % 12 === 0) {
      for (const m of hex.match(/.{12}/g)) { out.push(m.match(/.{2}/g).join(':')); norms.push(m); }
    } else {
      out.push(part);
      norms.push(normCode(part));
    }
  }
  return { mac: out.join(', '), mac_norm: ` ${norms.join(' ')} ` };
}

/* ---------- reading items ---------- */

// na: holds no data. pending: holds data and has a drive still to clear (or none recorded yet). cleared: every drive done.
const DATA_SQL = `CASE WHEN i.data_bearing = 0 THEN 'na'
  WHEN NOT EXISTS (SELECT 1 FROM drives d WHERE d.item_id = i.id) THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM drives d WHERE d.item_id = i.id AND d.status = 'pending') THEN 'pending'
  ELSE 'cleared' END`;

export const ITEM_SELECT = `SELECT i.*, ${DATA_SQL} AS data_status,
    c.ref AS collection_ref, c.collected_from,
    s.sale_price, s.fees AS sale_fees, s.postage AS sale_postage, s.sold_at
  FROM items i
  LEFT JOIN collections c ON c.id = i.collection_id
  LEFT JOIN sales s ON s.item_id = i.id`;

export const getItem = (id) => get(`${ITEM_SELECT} WHERE i.id = ?`, id);
function mustItem(id) {
  const it = getItem(id);
  if (!it) throw new HttpError(404, 'Item not found');
  return it;
}

const SORTS = {
  barcode: 'i.barcode', name: 'i.name', category: 'i.category', serial: 'i.serial', status: 'i.status',
  paid: 'i.purchase_price', data: 'data_status', created: 'i.created_at',
};

export function listItems(query = {}) {
  const where = [];
  const params = [];
  const q = String(query.q ?? '').trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const fields = ['i.barcode', 'i.name', 'i.category', 'i.brand', 'i.model', 'i.serial', 'i.mac', 'i.supplier', 'i.location', 'i.notes', 'c.ref', 'c.collected_from'];
    const parts = fields.map((f) => `${f} LIKE ? ESCAPE '\\'`);
    params.push(...fields.map(() => like));
    // also match a serial or MAC typed without its punctuation
    const n = normCode(q);
    if (n.length >= 4) {
      parts.push("i.serial_norm LIKE ? ESCAPE '\\'", "i.mac_norm LIKE ? ESCAPE '\\'");
      params.push(`%${n}%`, `%${n}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (KINDS.includes(query.kind)) { where.push('i.kind = ?'); params.push(query.kind); }
  if (STATUSES.includes(query.status)) { where.push('i.status = ?'); params.push(query.status); }
  else if (query.status === 'active') where.push("i.status NOT IN ('sold', 'recycled')");
  if (query.category) { where.push('i.category = ?'); params.push(String(query.category)); }
  if (['na', 'pending', 'cleared'].includes(query.data)) { where.push(`(${DATA_SQL}) = ?`); params.push(query.data); }
  if (query.collection) { where.push('i.collection_id = ?'); params.push(Number(query.collection) || 0); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const sort = SORTS[query.sort] || SORTS.barcode;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  const total = get(`SELECT COUNT(*) AS n FROM items i LEFT JOIN collections c ON c.id = i.collection_id ${clause}`, ...params).n;
  const items = all(`${ITEM_SELECT} ${clause} ORDER BY ${sort} IS NULL, ${sort} COLLATE NOCASE ${dir}, i.id ${dir} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { total, items };
}

export function itemDetail(id) {
  const item = mustItem(id);
  return {
    item,
    drives: all('SELECT * FROM drives WHERE item_id = ? ORDER BY id', id),
    comments: all('SELECT * FROM comments WHERE item_id = ? ORDER BY id DESC', id),
    events: all('SELECT * FROM events WHERE item_id = ? ORDER BY id DESC LIMIT 40', id),
    sale: get(`SELECT s.*, e.order_id AS ebay_order_id, e.title AS ebay_title FROM sales s
               LEFT JOIN ebay_sales e ON e.id = s.ebay_sale_id WHERE s.item_id = ?`, id) || null,
    purchase: item.ebay_purchase_id ? get('SELECT * FROM ebay_purchases WHERE id = ?', item.ebay_purchase_id) || null : null,
  };
}

/* ---------- scanning ---------- */

// A label's barcode first; failing that, a serial number, MAC address or drive serial recorded against an item.
export function findByCode(code) {
  const byBarcode = get(`${ITEM_SELECT} WHERE i.barcode = ?`, code);
  if (byBarcode) return { item: byBarcode, via: '' };
  const n = normCode(code);
  if (n.length < 4) return null;
  const newestUnsold = "ORDER BY i.status IN ('sold', 'recycled'), i.id DESC LIMIT 1";
  const bySerial = get(`${ITEM_SELECT} WHERE i.serial_norm = ? ${newestUnsold}`, n);
  if (bySerial) return { item: bySerial, via: 'serial number' };
  const byMac = get(`${ITEM_SELECT} WHERE i.mac_norm LIKE ? ESCAPE '\\' ${newestUnsold}`, `% ${n} %`);
  if (byMac) return { item: byMac, via: 'MAC address' };
  const byDrive = get(`${ITEM_SELECT} WHERE i.id IN (SELECT item_id FROM drives WHERE serial_norm = ?) ${newestUnsold}`, n);
  if (byDrive) return { item: byDrive, via: 'drive serial number' };
  return null;
}

export function handleScan(body) {
  const code = String(body?.barcode ?? '').trim().slice(0, 200);
  if (!code) throw new HttpError(400, 'Nothing was scanned');
  const found = findByCode(code);
  if (!found) return { ok: false, tone: 'unknown', unknown: true, barcode: code, message: `${code} is not in the system` };
  const { item, via } = found;
  return {
    ok: true, tone: 'lookup', barcode: item.barcode, item: { id: item.id, barcode: item.barcode },
    navigate: `/items/${item.id}`,
    message: `${item.barcode} — ${item.name}${via ? ` (matched by ${via})` : ''}`,
  };
}

/* ---------- creating and editing ---------- */

// Called inside a transaction. The counter only ever goes up, so a deleted item's number is never handed out again.
function nextBarcode() {
  let n = parseInt(getSetting('barcode_counter', '0'), 10) || 0;
  let code;
  do {
    n++;
    code = BARCODE_PREFIX + String(n).padStart(BARCODE_DIGITS, '0');
  } while (get('SELECT 1 AS x FROM items WHERE barcode = ?', code));
  setSetting('barcode_counter', n);
  return code;
}

const TEXT_FIELDS = { name: 200, category: 60, brand: 80, model: 120, serial: 120, condition: 500, location: 120, notes: 4000, source: 40, supplier: 120 };
const COLUMNS = [
  'kind', 'status', 'name', 'category', 'brand', 'model', 'serial', 'serial_norm', 'mac', 'mac_norm', 'condition', 'location', 'notes',
  'purchase_price', 'repair_cost', 'purchase_date', 'source', 'supplier', 'ebay_purchase_id', 'collection_id', 'data_bearing',
];

// Only the fields present in `body` are changed; the rest keep the value in `base`.
function applyFields(base, body) {
  const out = { ...base };
  for (const [key, max] of Object.entries(TEXT_FIELDS)) if (key in body) out[key] = text(body[key], max);
  if (!out.name) throw new HttpError(400, 'Give the item a name');
  out.serial_norm = out.serial ? normCode(out.serial) : null;
  if ('mac' in body) Object.assign(out, parseMacs(body.mac));
  if ('kind' in body) {
    if (!KINDS.includes(body.kind)) throw new HttpError(400, 'Unknown kind of item');
    out.kind = body.kind;
  }
  if ('purchase_price' in body) out.purchase_price = money(body.purchase_price, 'Price paid');
  if ('repair_cost' in body) out.repair_cost = money(body.repair_cost, 'Repair cost');
  if ('purchase_date' in body) out.purchase_date = date(body.purchase_date, 'Date');
  if ('data_bearing' in body) out.data_bearing = body.data_bearing ? 1 : 0;
  if ('collection_id' in body) {
    out.collection_id = refId(body.collection_id);
    if (out.collection_id && !get('SELECT 1 AS x FROM collections WHERE id = ?', out.collection_id)) throw new HttpError(400, 'That collection no longer exists');
  }
  if ('ebay_purchase_id' in body) {
    out.ebay_purchase_id = refId(body.ebay_purchase_id);
    if (out.ebay_purchase_id && !get('SELECT 1 AS x FROM ebay_purchases WHERE id = ?', out.ebay_purchase_id)) throw new HttpError(400, 'That eBay purchase no longer exists');
  }
  return out;
}

function barcodeFrom(body) {
  const code = String(body.barcode ?? '').trim();
  if (!code) return null;
  if (code.length > 30 || !/^[\x21-\x7e]+$/.test(code)) throw new HttpError(400, 'A barcode can be up to 30 letters, digits or symbols, with no spaces');
  return code;
}

export function createItem(body = {}) {
  return tx(() => {
    const f = applyFields({ kind: 'repair', status: 'in_stock', data_bearing: 0 }, body);
    if ('status' in body && body.status) {
      if (!STATUSES.includes(body.status) || body.status === 'sold') throw new HttpError(400, 'A new item cannot start with that status');
      f.status = body.status;
    }
    let barcode = barcodeFrom(body);
    if (barcode) {
      const clash = get('SELECT name FROM items WHERE barcode = ?', barcode);
      if (clash) throw new HttpError(409, `Barcode ${barcode} is already used by “${clash.name}”`);
    } else barcode = nextBarcode();
    const now = nowIso();
    const res = run(`INSERT INTO items (barcode, ${COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      barcode, ...COLUMNS.map((c) => f[c] ?? null), now, now);
    const item = getItem(Number(res.lastInsertRowid));
    logEvent({ action: 'create', item, detail: `Added to inventory: ${item.name}` });
    return item;
  });
}

export function updateItem(id, body = {}) {
  return tx(() => {
    const before = mustItem(id);
    const f = applyFields(before, body);
    let barcode = barcodeFrom(body) || before.barcode;
    if (barcode.toLowerCase() !== before.barcode.toLowerCase()) {
      const clash = get('SELECT name FROM items WHERE barcode = ? AND id <> ?', barcode, id);
      if (clash) throw new HttpError(409, `Barcode ${barcode} is already used by “${clash.name}”`);
    }
    run(`UPDATE items SET barcode = ?, ${COLUMNS.filter((c) => c !== 'status').map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      barcode, ...COLUMNS.filter((c) => c !== 'status').map((c) => f[c] ?? null), nowIso(), id);
    const item = getItem(id);
    logEvent({ action: 'edit', item, detail: 'Details edited' });
    return item;
  });
}

export function deleteItem(id) {
  tx(() => {
    const item = mustItem(id);
    run('DELETE FROM items WHERE id = ?', id);
    logEvent({ action: 'delete', barcode: item.barcode, detail: `Deleted: ${item.name}` });
  });
}

const dataBlock = (item, doing) =>
  new HttpError(409, `${item.barcode} still has storage waiting to be wiped. Clear it (or untick “holds data”) before ${doing}`);

export function setStatus(id, status, note) {
  return tx(() => {
    const item = mustItem(id);
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    if (status === 'sold') throw new HttpError(400, 'Use “Mark as sold” so the sale price is recorded');
    if (item.status === 'sold') throw new HttpError(409, `${item.barcode} is sold. Undo the sale first`);
    if (status === 'recycled' && item.data_status === 'pending') throw dataBlock(item, 'recycling it');
    if (status !== item.status) {
      run('UPDATE items SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
      logEvent({ action: 'status', item, detail: `${STATUS_LABEL[item.status]} → ${STATUS_LABEL[status]}` });
    }
    const t = text(note, 2000);
    if (t) run('INSERT INTO comments (item_id, text, created_at) VALUES (?, ?, ?)', id, `${STATUS_LABEL[status]}: ${t}`, nowIso());
    return getItem(id);
  });
}

/* ---------- notes ---------- */

export function addComment(id, value) {
  mustItem(id);
  const t = text(value, 4000);
  if (!t) throw new HttpError(400, 'The note is empty');
  const res = run('INSERT INTO comments (item_id, text, created_at) VALUES (?, ?, ?)', id, t, nowIso());
  return get('SELECT * FROM comments WHERE id = ?', Number(res.lastInsertRowid));
}

export function deleteComment(commentId) {
  if (!run('DELETE FROM comments WHERE id = ?', commentId).changes) throw new HttpError(404, 'Note not found');
}

/* ---------- drives and data wiping ---------- */

function wipeFields(body) {
  const method = text(body.method, 80);
  if (!method) throw new HttpError(400, 'Choose how it was wiped');
  return { method, status: method === DESTROYED_METHOD ? 'destroyed' : 'wiped', wiped_at: date(body.date, 'Wipe date') || today() };
}

export function addDrive(itemId, body = {}) {
  return tx(() => {
    const item = mustItem(itemId);
    const serial = text(body.serial, 120);
    const res = run('INSERT INTO drives (item_id, kind, serial, serial_norm, capacity, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      itemId, text(body.kind, 40) || 'HDD', serial, serial ? normCode(serial) : null, text(body.capacity, 40), text(body.notes, 500), nowIso());
    // recording a drive against something means it holds data
    if (!item.data_bearing) run('UPDATE items SET data_bearing = 1, updated_at = ? WHERE id = ?', nowIso(), itemId);
    logEvent({ action: 'drive', item, detail: `Drive recorded${serial ? `: ${serial}` : ''}` });
    return get('SELECT * FROM drives WHERE id = ?', Number(res.lastInsertRowid));
  });
}

function mustDrive(itemId, driveId) {
  const drive = get('SELECT * FROM drives WHERE id = ? AND item_id = ?', driveId, itemId);
  if (!drive) throw new HttpError(404, 'Drive not found');
  return drive;
}

export function wipeDrive(itemId, driveId, body = {}) {
  return tx(() => {
    const item = mustItem(itemId);
    const drive = mustDrive(itemId, driveId);
    const w = wipeFields(body);
    run('UPDATE drives SET status = ?, method = ?, wiped_at = ? WHERE id = ?', w.status, w.method, w.wiped_at, driveId);
    logEvent({ action: 'wipe', item, detail: `Drive ${drive.serial || drive.kind} ${w.status} (${w.method})` });
    return getItem(itemId);
  });
}

// Back to "pending", for a wipe that was recorded by mistake
export function unwipeDrive(itemId, driveId) {
  return tx(() => {
    const item = mustItem(itemId);
    const drive = mustDrive(itemId, driveId);
    run("UPDATE drives SET status = 'pending', method = NULL, wiped_at = NULL WHERE id = ?", driveId);
    logEvent({ action: 'wipe', item, detail: `Drive ${drive.serial || drive.kind} set back to waiting` });
    return getItem(itemId);
  });
}

export function deleteDrive(itemId, driveId) {
  return tx(() => {
    const item = mustItem(itemId);
    const drive = mustDrive(itemId, driveId);
    run('DELETE FROM drives WHERE id = ?', driveId);
    logEvent({ action: 'drive', item, detail: `Drive record removed${drive.serial ? `: ${drive.serial}` : ''}` });
    return getItem(itemId);
  });
}

// Clears every drive still waiting. Something with no drives recorded (a phone, say) gets one "built-in storage" entry,
// so there is always a line in the wipe log saying what was done and when.
export function wipeAll(itemId, body = {}) {
  return tx(() => {
    const item = mustItem(itemId);
    if (!item.data_bearing) throw new HttpError(409, `${item.barcode} is not marked as holding data`);
    const w = wipeFields(body);
    const pending = all("SELECT id FROM drives WHERE item_id = ? AND status = 'pending'", itemId);
    if (pending.length) {
      run("UPDATE drives SET status = ?, method = ?, wiped_at = ? WHERE item_id = ? AND status = 'pending'", w.status, w.method, w.wiped_at, itemId);
    } else if (!get('SELECT 1 AS x FROM drives WHERE item_id = ?', itemId)) {
      run('INSERT INTO drives (item_id, kind, status, method, wiped_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        itemId, 'Built-in storage', w.status, w.method, w.wiped_at, nowIso());
    } else throw new HttpError(409, `${item.barcode} has nothing left to wipe`);
    logEvent({ action: 'wipe', item, detail: `Storage ${w.status} (${w.method})` });
    return getItem(itemId);
  });
}

// Every drive that has been cleared, newest first: the record of what was wiped, how and when
export const wipeLog = (limit = 200) =>
  all(`SELECT d.*, i.barcode, i.name, i.serial AS item_serial, c.ref AS collection_ref, c.collected_from
       FROM drives d JOIN items i ON i.id = d.item_id LEFT JOIN collections c ON c.id = i.collection_id
       WHERE d.status <> 'pending' ORDER BY d.wiped_at DESC, d.id DESC LIMIT ?`, limit);

/* ---------- sales ---------- */

export const profitOf = (r) =>
  Math.round(((r.sale_price || 0) - (r.fees || 0) - (r.postage || 0) - (r.purchase_price || 0) - (r.repair_cost || 0)) * 100) / 100;

export function sellItem(id, body = {}) {
  return tx(() => {
    const item = mustItem(id);
    if (item.status === 'sold') throw new HttpError(409, `${item.barcode} is already marked as sold`);
    if (item.status === 'recycled') throw new HttpError(409, `${item.barcode} has been recycled, so it cannot be sold`);
    if (item.data_status === 'pending') throw dataBlock(item, 'selling it');
    const ebaySaleId = refId(body.ebay_sale_id);
    if (ebaySaleId) {
      const sale = get('SELECT quantity, (SELECT COUNT(*) FROM sales WHERE ebay_sale_id = e.id) AS matched FROM ebay_sales e WHERE e.id = ?', ebaySaleId);
      if (!sale) throw new HttpError(404, 'That eBay sale no longer exists');
      if (sale.matched >= sale.quantity) throw new HttpError(409, 'That eBay sale is already matched to an item');
    }
    run(`INSERT INTO sales (item_id, sale_price, fees, postage, sold_at, platform, buyer, notes, prev_status, ebay_sale_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, money(body.sale_price, 'Sale price', { required: true }), money(body.fees, 'Fees') ?? 0, money(body.postage, 'Postage') ?? 0,
      date(body.sold_at, 'Sale date') || today(), text(body.platform, 40) || (ebaySaleId ? 'eBay' : null), text(body.buyer, 120), text(body.notes, 1000),
      item.status, ebaySaleId, nowIso());
    run("UPDATE items SET status = 'sold', updated_at = ? WHERE id = ?", nowIso(), id);
    const sold = getItem(id);
    logEvent({ action: 'sold', item, detail: `Sold for £${sold.sale_price.toFixed(2)}${ebaySaleId ? ' (matched to an eBay sale)' : ''}` });
    return sold;
  });
}

export function undoSale(id) {
  return tx(() => {
    const item = mustItem(id);
    const sale = get('SELECT * FROM sales WHERE item_id = ?', id);
    if (!sale) throw new HttpError(409, `${item.barcode} has no sale to undo`);
    run('DELETE FROM sales WHERE item_id = ?', id);
    const back = STATUSES.includes(sale.prev_status) && sale.prev_status !== 'sold' ? sale.prev_status : 'in_stock';
    run('UPDATE items SET status = ?, updated_at = ? WHERE id = ?', back, nowIso(), id);
    logEvent({ action: 'unsold', item, detail: `Sale undone — back to ${STATUS_LABEL[back].toLowerCase()}` });
    return getItem(id);
  });
}

export function listSales() {
  const rows = all(`SELECT s.*, i.barcode, i.name, i.kind, i.purchase_price, i.repair_cost
                    FROM sales s JOIN items i ON i.id = s.item_id ORDER BY s.sold_at DESC, s.id DESC`);
  const sales = rows.map((r) => ({ ...r, profit: profitOf(r) }));
  const sum = (key) => Math.round(sales.reduce((t, r) => t + (r[key] || 0), 0) * 100) / 100;
  return {
    sales,
    totals: {
      count: sales.length, revenue: sum('sale_price'), fees: sum('fees'), postage: sum('postage'),
      cost: Math.round((sum('purchase_price') + sum('repair_cost')) * 100) / 100, profit: sum('profit'),
    },
  };
}

/* ---------- categories in use ---------- */

export function categoryList() {
  const seen = new Set(CATEGORIES.map((c) => c.toLowerCase()));
  const list = [...CATEGORIES];
  for (const r of all('SELECT DISTINCT category AS c FROM items WHERE category IS NOT NULL ORDER BY 1')) {
    if (!seen.has(r.c.toLowerCase())) { seen.add(r.c.toLowerCase()); list.push(r.c); }
  }
  return list;
}
