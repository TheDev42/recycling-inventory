import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Default: the "data" folder in the project root (next to package.json), wherever the server is started from.
// Docker sets DATA_DIR=/data, which docker-compose.yml maps to that same folder.
const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const DATA_DIR = dataDir;
export const DB_PATH = path.join(dataDir, 'inventory.db');

// The first version of this system (the Python one) kept its database under the same name with a different layout.
// If that is what is in the data folder, it is moved aside — kept as a backup — and its contents are copied into a
// fresh database further down, once the tables exist.
const LEGACY_PATH = path.join(dataDir, 'inventory-old-version.db');
function setLegacyAside() {
  if (!fs.existsSync(DB_PATH)) return false;
  const old = new DatabaseSync(DB_PATH);
  const cols = old.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  old.close();
  if (!cols.includes('tag') || cols.includes('barcode')) return false;
  if (fs.existsSync(LEGACY_PATH)) throw new Error(`Both an old-version database and ${LEGACY_PATH} exist. Move one of them out of the data folder`);
  fs.renameSync(DB_PATH, LEGACY_PATH);
  for (const ext of ['-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
  return true;
}
const hasLegacy = setLegacyAside();

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One pick-up of WEEE: who it came from and when. The items collected hang off it.
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  collected_from TEXT NOT NULL,
  contact TEXT,
  address TEXT,
  collected_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Purchases pulled from eBay, one row per order line. price and postage are per unit.
CREATE TABLE IF NOT EXISTS ebay_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  ebay_item_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL DEFAULT '',
  title TEXT,
  price REAL,
  postage REAL,
  currency TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  seller TEXT,
  purchased_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (order_id, ebay_item_id, transaction_id)
);

-- Sales pulled from eBay, one row per order line. price, postage_charged and fee are totals for the line.
CREATE TABLE IF NOT EXISTS ebay_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL UNIQUE,
  ebay_item_id TEXT,
  title TEXT,
  price REAL,
  postage_charged REAL,
  fee REAL,
  currency TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  buyer TEXT,
  sold_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- what the label's barcode encodes
  kind TEXT NOT NULL DEFAULT 'repair',           -- repair (bought to fix and sell) | weee (collected for recycling)
  status TEXT NOT NULL DEFAULT 'in_stock',       -- in_stock | repair | ready | listed | sold | recycled
  name TEXT NOT NULL,
  category TEXT,
  brand TEXT,
  model TEXT,
  serial TEXT,
  serial_norm TEXT,                              -- upper-case letters and digits only, for scanner lookups
  mac TEXT,
  mac_norm TEXT,                                 -- ' AABBCCDDEEFF 112233445566 ' (space-wrapped, so each one can be matched whole)
  condition TEXT,                                -- the fault / what is wrong with it
  location TEXT,
  notes TEXT,
  purchase_price REAL,
  repair_cost REAL,                              -- parts bought to fix it
  purchase_date TEXT,
  source TEXT,                                   -- eBay | Collection | Other
  supplier TEXT,
  ebay_purchase_id INTEGER REFERENCES ebay_purchases(id) ON DELETE SET NULL,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  data_bearing INTEGER NOT NULL DEFAULT 0,       -- 1 = it holds (or held) storage that has to be wiped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_serial ON items(serial_norm);
CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id);
CREATE INDEX IF NOT EXISTS idx_items_purchase ON items(ebay_purchase_id);

-- Each drive (or built-in storage) in a data-bearing item, and what was done to clear it.
CREATE TABLE IF NOT EXISTS drives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT,
  serial TEXT,
  serial_norm TEXT,
  capacity TEXT,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | wiped | destroyed
  method TEXT,
  wiped_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drives_item ON drives(item_id);
CREATE INDEX IF NOT EXISTS idx_drives_serial ON drives(serial_norm);

-- One sale per inventory item
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  sale_price REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  postage REAL NOT NULL DEFAULT 0,
  sold_at TEXT,
  platform TEXT,
  buyer TEXT,
  notes TEXT,
  prev_status TEXT,                              -- what to put the item back to if the sale is undone
  ebay_sale_id INTEGER REFERENCES ebay_sales(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_ebay ON sales(ebay_sale_id);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id INTEGER,
  barcode TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`);

/* ---------- one-off import from the old version ---------- */
// Items keep the barcode that is already printed on their labels. Serial numbers and MAC addresses move from the old
// "identifiers" list into their own boxes; any other identifier (IMEI, asset tag…) is kept in the item's notes.
function importLegacy() {
  const code = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const STATUS = { in_repair: 'repair', scrapped: 'recycled', listed: 'listed', sold: 'sold', recycled: 'recycled' };
  db.exec(`ATTACH DATABASE '${LEGACY_PATH.replace(/'/g, "''")}' AS old`);
  db.exec('BEGIN');
  try {
    // eBay keys and the long-lived sign-in carry over; the short-lived token is fetched again when first needed
    db.exec(`INSERT OR IGNORE INTO settings SELECT key, value FROM old.settings
               WHERE key NOT IN ('ebay_access_token', 'ebay_access_expires', 'secret_key');
             INSERT INTO ebay_purchases (id, order_id, ebay_item_id, transaction_id, title, price, currency, quantity, seller, purchased_at, hidden)
               SELECT id, order_id, ebay_item_id, transaction_id, title, price, currency, quantity, seller, purchased_at, hidden FROM old.ebay_purchases;
             INSERT INTO ebay_sales (id, order_id, line_item_id, ebay_item_id, title, price, fee, currency, quantity, buyer, sold_at, hidden)
               SELECT id, order_id, line_item_id, ebay_item_id, title, price, fee, currency, quantity, buyer, sold_at, hidden FROM old.ebay_sales;`);

    const identifiers = db.prepare('SELECT * FROM old.identifiers ORDER BY id').all();
    const addItem = db.prepare(`INSERT INTO items (id, barcode, kind, status, name, category, model, serial, serial_norm, mac, mac_norm, condition, location, notes,
        purchase_price, purchase_date, source, supplier, ebay_purchase_id, data_bearing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addDrive = db.prepare("INSERT INTO drives (item_id, kind, status, method, wiped_at, created_at) VALUES (?, 'Built-in storage', ?, ?, ?, ?)");
    const items = db.prepare('SELECT * FROM old.items ORDER BY id').all();
    for (const i of items) {
      const mine = identifiers.filter((d) => d.item_id === i.id);
      const of = (type) => mine.filter((d) => d.type === type).map((d) => d.value);
      const [serial = null, ...moreSerials] = of('Serial number');
      const [model = null, ...moreModels] = of('Model number');
      const macs = of('MAC address').map((m) => {
        const hex = code(m);
        return /^[0-9A-F]{12}$/.test(hex) ? hex.match(/.{2}/g).join(':') : m;
      });
      const extra = [
        ...moreSerials.map((v) => `Serial number: ${v}`), ...moreModels.map((v) => `Model number: ${v}`),
        ...mine.filter((d) => !['Serial number', 'Model number', 'MAC address'].includes(d.type)).map((d) => `${d.type}: ${d.value}`),
      ];
      const row = [i.id, i.tag || `OLD${i.id}`, i.kind === 'recycling' ? 'weee' : 'repair', STATUS[i.status] || 'in_stock', i.name, i.category, model,
        serial, serial ? code(serial) : null, macs.length ? macs.join(', ') : null, macs.length ? ` ${macs.map(code).join(' ')} ` : null,
        i.condition, i.location, [i.notes, ...extra].filter(Boolean).join('\n') || null,
        i.purchase_price, i.purchase_date, i.source, i.supplier, i.ebay_purchase_id, i.data_status && i.data_status !== 'na' ? 1 : 0, i.created_at, i.updated_at];
      addItem.run(...row.map((v) => v ?? null));
      // already wiped: one entry in the wipe log saying how and when
      if (i.data_status === 'wiped' || i.data_status === 'destroyed') {
        addDrive.run(i.id, i.data_status, i.wipe_method || (i.data_status === 'destroyed' ? 'Physically destroyed' : 'Recorded in the old system'),
          (i.wiped_at || i.updated_at || '').slice(0, 10) || null, i.created_at);
      }
    }
    db.exec(`INSERT INTO sales (id, item_id, sale_price, fees, postage, sold_at, platform, buyer, notes, prev_status, ebay_sale_id, created_at)
               SELECT id, item_id, sale_price, fees, postage, substr(sold_at, 1, 10), platform, buyer, notes, 'in_stock', ebay_sale_id, COALESCE(sold_at, datetime('now'))
               FROM old.sales WHERE item_id IN (SELECT id FROM items);`);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE old');
    console.log(`Imported ${items.length} items from the old version. The old database is kept as ${LEGACY_PATH}`);
  } catch (err) {
    // put everything back exactly as it was, so nothing is lost and the next start tries again
    db.exec('ROLLBACK');
    db.close();
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
    fs.renameSync(LEGACY_PATH, DB_PATH);
    throw new Error(`Could not import the old version's database (it has been left untouched): ${err.message}`);
  }
}
if (hasLegacy) importLegacy();

const norm = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const get = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));

let txDepth = 0;
// Re-entrant: a nested tx() just joins the outer transaction, so an outer failure rolls everything back.
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

export const getSetting = (key, fallback = '') => get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
export const setSetting = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));

export const nowIso = () => new Date().toISOString();

const pad = (n) => String(n).padStart(2, '0');
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function logEvent({ action, item, barcode, detail }) {
  run('INSERT INTO events (ts, action, item_id, barcode, detail) VALUES (?, ?, ?, ?, ?)',
    nowIso(), action, item?.id ?? null, barcode ?? item?.barcode ?? null, detail ?? null);
}
