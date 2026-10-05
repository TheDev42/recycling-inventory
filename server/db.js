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
