import os
import sqlite3

from flask import g

DB_PATH = os.environ.get(
    "INVENTORY_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "inventory.db")
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Purchases pulled from eBay (one row per order line)
CREATE TABLE IF NOT EXISTS ebay_purchases (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT NOT NULL,
    ebay_item_id   TEXT NOT NULL,
    transaction_id TEXT NOT NULL DEFAULT '',
    title          TEXT,
    price          REAL,
    currency       TEXT,
    quantity       INTEGER NOT NULL DEFAULT 1,
    seller         TEXT,
    purchased_at   TEXT,
    hidden         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (order_id, ebay_item_id, transaction_id)
);

-- Sales pulled from eBay (one row per order line)
CREATE TABLE IF NOT EXISTS ebay_sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT NOT NULL,
    line_item_id   TEXT NOT NULL UNIQUE,
    ebay_item_id   TEXT,
    title          TEXT,
    price          REAL,              -- total for the line (all units)
    fee            REAL,              -- this line's share of the eBay fees
    currency       TEXT,
    quantity       INTEGER NOT NULL DEFAULT 1,
    buyer          TEXT,
    sold_at        TEXT,
    hidden         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tag              TEXT UNIQUE,                      -- what the barcode encodes
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'stock',    -- stock | recycling
    status           TEXT NOT NULL DEFAULT 'in_stock', -- in_stock | in_repair | listed | sold | recycled | scrapped
    category         TEXT,
    condition        TEXT,
    location         TEXT,
    notes            TEXT,
    purchase_price   REAL,
    purchase_date    TEXT,
    source           TEXT,
    supplier         TEXT,
    ebay_purchase_id INTEGER REFERENCES ebay_purchases(id) ON DELETE SET NULL,
    data_status      TEXT NOT NULL DEFAULT 'na',       -- na | pending | wiped | destroyed
    wipe_method      TEXT,
    wiped_at         TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identifiers (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    type    TEXT NOT NULL,
    value   TEXT NOT NULL,
    norm    TEXT NOT NULL    -- upper-case, letters and digits only; used for scanner lookups
);
CREATE INDEX IF NOT EXISTS idx_identifiers_norm ON identifiers(norm);
CREATE INDEX IF NOT EXISTS idx_identifiers_item ON identifiers(item_id);

-- One sale per inventory item
CREATE TABLE IF NOT EXISTS sales (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    sale_price   REAL NOT NULL DEFAULT 0,
    fees         REAL NOT NULL DEFAULT 0,
    postage      REAL NOT NULL DEFAULT 0,
    sold_at      TEXT,
    platform     TEXT,
    buyer        TEXT,
    notes        TEXT,
    ebay_sale_id INTEGER REFERENCES ebay_sales(id) ON DELETE SET NULL
);
"""

DEFAULT_SETTINGS = {
    "business_name": "",
    "currency": "£",
    "label_w": "62",
    "label_h": "29",
    "ebay_env": "production",
    "ebay_site_id": "3",
    "ebay_client_id": "",
    "ebay_client_secret": "",
    "ebay_runame": "",
}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def all_settings():
    settings = dict(DEFAULT_SETTINGS)
    for row in get_db().execute("SELECT key, value FROM settings"):
        settings[row["key"]] = row["value"]
    return settings


def get_setting(key, default=None):
    row = get_db().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is not None:
        return row["value"]
    return DEFAULT_SETTINGS.get(key, default)


def set_setting(key, value):
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()
