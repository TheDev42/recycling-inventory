import csv
import io
import os
import re
import secrets
import time
from datetime import date, datetime
from urllib.parse import parse_qs, unquote, urlparse

from flask import Flask, Response, abort, flash, redirect, render_template, request, url_for
from jinja2 import UndefinedError
from markupsafe import Markup

import db
import ebay
from labels import barcode_svg

TAG_PREFIX = "INV"

KINDS = {"stock": "Stock", "recycling": "Recycling"}
STATUSES = {
    "in_stock": "In stock",
    "in_repair": "In repair",
    "listed": "Listed",
    "sold": "Sold",
    "recycled": "Recycled",
    "scrapped": "Scrapped",
}
ACTIVE_STATUSES = ("in_stock", "in_repair", "listed")
DATA_STATUSES = {
    "na": "No storage",
    "pending": "Not wiped",
    "wiped": "Wiped",
    "destroyed": "Storage destroyed",
}
ID_TYPES = ["Serial number", "MAC address", "IMEI", "Asset tag", "Model number", "Other"]
ITEM_FIELDS = [
    "name", "kind", "status", "category", "condition", "location", "notes",
    "purchase_price", "purchase_date", "source", "supplier", "data_status", "wipe_method",
]

app = Flask(__name__)
app.teardown_appcontext(db.close_db)
db.init_db()

with app.app_context():
    if not db.get_setting("secret_key"):
        db.set_setting("secret_key", secrets.token_hex(32))
    app.secret_key = db.get_setting("secret_key")


# ---------- helpers ----------

def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def norm(value):
    return re.sub(r"[^A-Za-z0-9]", "", value or "").upper()


def to_float(value):
    cleaned = re.sub(r"[^0-9.\-]", "", value or "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def get_item(item_id):
    item = db.get_db().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if item is None:
        abort(404)
    return item


def find_items(ref):
    """Exact match on a label tag, or on any identifier (serial, MAC, ...)."""
    ref = (ref or "").strip()
    if not ref:
        return []
    conn = db.get_db()
    rows = conn.execute("SELECT * FROM items WHERE upper(tag) = ?", (ref.upper(),)).fetchall()
    if rows or not norm(ref):
        return rows
    return conn.execute(
        "SELECT DISTINCT i.* FROM items i JOIN identifiers d ON d.item_id = i.id WHERE d.norm = ?",
        (norm(ref),),
    ).fetchall()


def record_sale(item, sale_price, fees, postage, sold_at, platform, buyer, notes, ebay_sale_id=None):
    conn = db.get_db()
    conn.execute(
        "INSERT INTO sales (item_id, sale_price, fees, postage, sold_at, platform, buyer, notes, ebay_sale_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item["id"], sale_price or 0, fees or 0, postage or 0, sold_at, platform, buyer, notes, ebay_sale_id),
    )
    conn.execute("UPDATE items SET status = 'sold', updated_at = ? WHERE id = ?", (now(), item["id"]))
    conn.commit()
    if item["data_status"] == "pending":
        flash(f"Warning: {item['tag']} is marked as sold but its storage has not been wiped.", "warn")


def ebay_token():
    """A valid eBay access token, refreshed if needed."""
    cfg = db.all_settings()
    if not cfg.get("ebay_refresh_token"):
        raise ebay.EbayError("Not connected to eBay yet. Connect your account in Settings.")
    if cfg.get("ebay_access_token") and int(cfg.get("ebay_access_expires") or 0) > time.time() + 60:
        return cfg["ebay_access_token"]
    tokens = ebay.refresh_access_token(cfg, cfg["ebay_refresh_token"])
    db.set_setting("ebay_access_token", tokens["access_token"])
    db.set_setting("ebay_access_expires", str(tokens["expires_at"]))
    return tokens["access_token"]


def store_tokens(tokens):
    db.set_setting("ebay_access_token", tokens["access_token"])
    db.set_setting("ebay_access_expires", str(tokens["expires_at"]))
    db.set_setting("ebay_refresh_token", tokens.get("refresh_token", ""))


@app.template_filter("money")
def money(value):
    if value is None or value == "":
        return "—"
    symbol = db.get_setting("currency")
    return f"-{symbol}{-value:,.2f}" if value < 0 else f"{symbol}{value:,.2f}"


@app.template_filter("price_input")
def price_input(value):
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError, UndefinedError):
        return ""


@app.template_filter("day")
def day(value):
    return (value or "")[:10] or "—"


@app.context_processor
def inject_globals():
    return {
        "KINDS": KINDS,
        "STATUSES": STATUSES,
        "DATA_STATUSES": DATA_STATUSES,
        "ID_TYPES": ID_TYPES,
        "cfg": db.all_settings(),
    }


# ---------- dashboard & scanning ----------

@app.route("/")
def dashboard():
    conn = db.get_db()
    active = ",".join(f"'{s}'" for s in ACTIVE_STATUSES)
    stats = {
        "stock": conn.execute(
            f"SELECT COUNT(*) n, COALESCE(SUM(purchase_price), 0) v FROM items "
            f"WHERE kind = 'stock' AND status IN ({active})"
        ).fetchone(),
        "recycling": conn.execute(
            f"SELECT COUNT(*) n FROM items WHERE kind = 'recycling' AND status IN ({active})"
        ).fetchone()["n"],
        "sold": conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(s.sale_price), 0) revenue, "
            "COALESCE(SUM(s.sale_price - s.fees - s.postage - COALESCE(i.purchase_price, 0)), 0) profit "
            "FROM sales s JOIN items i ON i.id = s.item_id"
        ).fetchone(),
        "unlinked_sales": conn.execute(
            "SELECT COUNT(*) n FROM ebay_sales e WHERE hidden = 0 AND "
            "(SELECT COUNT(*) FROM sales s WHERE s.ebay_sale_id = e.id) < e.quantity"
        ).fetchone()["n"],
    }
    to_wipe = conn.execute(
        "SELECT * FROM items WHERE data_status = 'pending' ORDER BY created_at LIMIT 50"
    ).fetchall()
    recent = conn.execute("SELECT * FROM items ORDER BY id DESC LIMIT 10").fetchall()
    return render_template("dashboard.html", stats=stats, to_wipe=to_wipe, recent=recent)


@app.route("/scan")
def scan():
    q = request.args.get("q", "").strip()
    matches = find_items(q)
    if len(matches) == 1:
        return redirect(url_for("item_detail", item_id=matches[0]["id"]))
    return redirect(url_for("items", q=q))


# ---------- items ----------

@app.route("/items")
def items():
    q = request.args.get("q", "").strip()
    kind = request.args.get("kind", "")
    status = request.args.get("status", "")
    data = request.args.get("data", "")

    sql = (
        "SELECT i.*, s.sale_price, "
        "(SELECT group_concat(d.type || ': ' || d.value, ' · ') FROM identifiers d WHERE d.item_id = i.id) AS ids "
        "FROM items i LEFT JOIN sales s ON s.item_id = i.id WHERE 1 = 1"
    )
    params = []
    if q:
        like = f"%{q}%"
        norm_like = f"%{norm(q)}%" if norm(q) else "\x00"
        sql += (
            " AND (i.name LIKE ? OR i.tag LIKE ? OR i.notes LIKE ? OR i.supplier LIKE ? OR i.category LIKE ?"
            " OR i.location LIKE ? OR EXISTS (SELECT 1 FROM identifiers d WHERE d.item_id = i.id"
            " AND (d.value LIKE ? OR d.norm LIKE ?)))"
        )
        params += [like] * 7 + [norm_like]
    if kind in KINDS:
        sql += " AND i.kind = ?"
        params.append(kind)
    if status == "active":
        sql += " AND i.status IN (%s)" % ",".join("?" * len(ACTIVE_STATUSES))
        params += ACTIVE_STATUSES
    elif status in STATUSES:
        sql += " AND i.status = ?"
        params.append(status)
    if data in DATA_STATUSES:
        sql += " AND i.data_status = ?"
        params.append(data)
    sql += " ORDER BY i.id DESC LIMIT 1000"
    rows = db.get_db().execute(sql, params).fetchall()
    return render_template("items.html", items=rows, q=q, kind=kind, status=status, data=data)


def save_item(item_id=None):
    form = request.form
    values = {f: (form.get(f) or "").strip() or None for f in ITEM_FIELDS}
    if not values["name"]:
        return None
    values["purchase_price"] = to_float(form.get("purchase_price"))
    if values["kind"] not in KINDS:
        values["kind"] = "stock"
    if values["data_status"] not in DATA_STATUSES:
        values["data_status"] = "na"

    conn = db.get_db()
    existing = get_item(item_id) if item_id else None
    sold = existing is not None and existing["status"] == "sold"
    # 'sold' is only ever set by recording a sale
    if sold:
        values["status"] = "sold"
    elif values["status"] not in STATUSES or values["status"] == "sold":
        values["status"] = "in_stock"

    if values["data_status"] in ("wiped", "destroyed"):
        wiped_at = (existing["wiped_at"] if existing else None) or now()
    else:
        wiped_at = None
        values["wipe_method"] = None

    if existing:
        assignments = ", ".join(f"{f} = ?" for f in ITEM_FIELDS)
        conn.execute(
            f"UPDATE items SET {assignments}, wiped_at = ?, updated_at = ? WHERE id = ?",
            [values[f] for f in ITEM_FIELDS] + [wiped_at, now(), item_id],
        )
        conn.execute("DELETE FROM identifiers WHERE item_id = ?", (item_id,))
    else:
        purchase_id = form.get("ebay_purchase_id") or None
        columns = ", ".join(ITEM_FIELDS)
        marks = ", ".join("?" * len(ITEM_FIELDS))
        cur = conn.execute(
            f"INSERT INTO items ({columns}, wiped_at, ebay_purchase_id, created_at, updated_at) "
            f"VALUES ({marks}, ?, ?, ?, ?)",
            [values[f] for f in ITEM_FIELDS] + [wiped_at, purchase_id, now(), now()],
        )
        item_id = cur.lastrowid
        conn.execute("UPDATE items SET tag = ? WHERE id = ?", (f"{TAG_PREFIX}{item_id:06d}", item_id))

    for id_type, value in zip(form.getlist("id_type"), form.getlist("id_value")):
        value = value.strip()
        if value:
            conn.execute(
                "INSERT INTO identifiers (item_id, type, value, norm) VALUES (?, ?, ?, ?)",
                (item_id, id_type if id_type in ID_TYPES else "Other", value, norm(value)),
            )
    conn.commit()
    return item_id


@app.route("/items/new", methods=["GET", "POST"])
def item_new():
    if request.method == "POST":
        item_id = save_item()
        if item_id is None:
            flash("An item needs a name.", "error")
        else:
            flash("Item added.", "ok")
            return redirect(url_for("item_detail", item_id=item_id))

    kind = request.args.get("kind", "stock")
    item = {
        "kind": kind if kind in KINDS else "stock",
        "status": "in_stock",
        "data_status": "pending" if kind == "recycling" else "na",
        "purchase_date": date.today().isoformat(),
    }
    purchase = None
    purchase_id = request.args.get("purchase") or request.form.get("ebay_purchase_id")
    if purchase_id:
        purchase = db.get_db().execute(
            "SELECT * FROM ebay_purchases WHERE id = ?", (purchase_id,)
        ).fetchone()
    if purchase:
        item.update(
            name=purchase["title"],
            purchase_price=purchase["price"],
            purchase_date=(purchase["purchased_at"] or "")[:10],
            source="eBay",
            supplier=purchase["seller"],
        )
    if request.method == "POST":
        item.update(request.form.to_dict())
    return render_template("item_form.html", item=item, identifiers=[], purchase=purchase)


@app.route("/items/<int:item_id>")
def item_detail(item_id):
    item = get_item(item_id)
    conn = db.get_db()
    identifiers = conn.execute(
        "SELECT * FROM identifiers WHERE item_id = ? ORDER BY id", (item_id,)
    ).fetchall()
    sale = conn.execute("SELECT * FROM sales WHERE item_id = ?", (item_id,)).fetchone()
    purchase = None
    if item["ebay_purchase_id"]:
        purchase = conn.execute(
            "SELECT * FROM ebay_purchases WHERE id = ?", (item["ebay_purchase_id"],)
        ).fetchone()
    return render_template(
        "item_detail.html", item=item, identifiers=identifiers, sale=sale, purchase=purchase,
        today=date.today().isoformat(),
    )


@app.route("/items/<int:item_id>/edit", methods=["GET", "POST"])
def item_edit(item_id):
    item = get_item(item_id)
    if request.method == "POST":
        if save_item(item_id) is None:
            flash("An item needs a name.", "error")
        else:
            flash("Item updated.", "ok")
            return redirect(url_for("item_detail", item_id=item_id))
    identifiers = db.get_db().execute(
        "SELECT * FROM identifiers WHERE item_id = ? ORDER BY id", (item_id,)
    ).fetchall()
    return render_template("item_form.html", item=item, identifiers=identifiers, purchase=None)


@app.route("/items/<int:item_id>/delete", methods=["POST"])
def item_delete(item_id):
    item = get_item(item_id)
    conn = db.get_db()
    conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
    conn.commit()
    flash(f"Deleted {item['tag']} – {item['name']}.", "ok")
    return redirect(url_for("items"))


@app.route("/items/<int:item_id>/wipe", methods=["POST"])
def item_wipe(item_id):
    get_item(item_id)
    state = request.form.get("state", "wiped")
    if state not in DATA_STATUSES:
        abort(400)
    done = state in ("wiped", "destroyed")
    conn = db.get_db()
    conn.execute(
        "UPDATE items SET data_status = ?, wipe_method = ?, wiped_at = ?, updated_at = ? WHERE id = ?",
        (
            state,
            (request.form.get("wipe_method") or "").strip() or None if done else None,
            now() if done else None,
            now(),
            item_id,
        ),
    )
    conn.commit()
    flash(f"Storage marked as: {DATA_STATUSES[state]}.", "ok")
    next_url = request.form.get("next", "")
    if not next_url.startswith("/") or next_url.startswith("//"):
        next_url = url_for("item_detail", item_id=item_id)
    return redirect(next_url)


@app.route("/items/<int:item_id>/status", methods=["POST"])
def item_status(item_id):
    item = get_item(item_id)
    status = request.form.get("status")
    if status not in STATUSES or status == "sold" or item["status"] == "sold":
        abort(400)
    conn = db.get_db()
    conn.execute("UPDATE items SET status = ?, updated_at = ? WHERE id = ?", (status, now(), item_id))
    conn.commit()
    return redirect(url_for("item_detail", item_id=item_id))


@app.route("/items/<int:item_id>/sell", methods=["POST"])
def item_sell(item_id):
    item = get_item(item_id)
    if item["status"] == "sold":
        flash("This item already has a sale recorded.", "error")
    else:
        form = request.form
        record_sale(
            item,
            to_float(form.get("sale_price")),
            to_float(form.get("fees")),
            to_float(form.get("postage")),
            form.get("sold_at") or date.today().isoformat(),
            (form.get("platform") or "").strip() or None,
            (form.get("buyer") or "").strip() or None,
            (form.get("notes") or "").strip() or None,
        )
        flash("Sale recorded.", "ok")
    return redirect(url_for("item_detail", item_id=item_id))


@app.route("/items/<int:item_id>/unsell", methods=["POST"])
def item_unsell(item_id):
    get_item(item_id)
    conn = db.get_db()
    conn.execute("DELETE FROM sales WHERE item_id = ?", (item_id,))
    conn.execute("UPDATE items SET status = 'in_stock', updated_at = ? WHERE id = ?", (now(), item_id))
    conn.commit()
    flash("Sale removed; item is back in stock.", "ok")
    return redirect(url_for("item_detail", item_id=item_id))


# ---------- labels & export ----------

@app.route("/labels")
def labels():
    ids = [int(i) for i in request.args.getlist("ids") if i.isdigit()]
    if not ids:
        flash("Tick at least one item to print labels for.", "error")
        return redirect(url_for("items"))
    conn = db.get_db()
    entries = []
    for item_id in ids:
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            continue
        identifiers = conn.execute(
            "SELECT * FROM identifiers WHERE item_id = ? ORDER BY id", (item_id,)
        ).fetchall()
        entries.append(
            {"item": item, "identifiers": identifiers, "barcode": Markup(barcode_svg(item["tag"]))}
        )
    return render_template("labels.html", entries=entries)


@app.route("/export/items.csv")
def export_items():
    rows = db.get_db().execute(
        "SELECT i.*, s.sale_price, s.fees, s.postage, s.sold_at, s.platform, s.buyer, "
        "(SELECT group_concat(d.type || ': ' || d.value, '; ') FROM identifiers d WHERE d.item_id = i.id) AS ids "
        "FROM items i LEFT JOIN sales s ON s.item_id = i.id ORDER BY i.id"
    ).fetchall()
    columns = [
        "tag", "name", "kind", "status", "category", "condition", "location", "ids",
        "purchase_price", "purchase_date", "source", "supplier", "data_status", "wipe_method",
        "wiped_at", "sale_price", "fees", "postage", "sold_at", "platform", "buyer", "notes",
    ]
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(columns)
    for row in rows:
        writer.writerow([row[c] for c in columns])
    return Response(
        "﻿" + out.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=inventory-{date.today()}.csv"},
    )


# ---------- sales ----------

@app.route("/sales")
def sales():
    rows = db.get_db().execute(
        "SELECT s.*, i.tag, i.name, i.purchase_price, "
        "s.sale_price - s.fees - s.postage - COALESCE(i.purchase_price, 0) AS profit "
        "FROM sales s JOIN items i ON i.id = s.item_id ORDER BY s.sold_at DESC, s.id DESC"
    ).fetchall()
    totals = {
        key: sum(row[key] or 0 for row in rows)
        for key in ("purchase_price", "sale_price", "fees", "postage", "profit")
    }
    return render_template("sales.html", sales=rows, totals=totals)


# ---------- eBay ----------

@app.route("/ebay/purchases")
def ebay_purchases():
    show = request.args.get("show", "new")
    sql = (
        "SELECT p.*, (SELECT COUNT(*) FROM items i WHERE i.ebay_purchase_id = p.id) AS added "
        "FROM ebay_purchases p"
    )
    if show == "new":
        sql += " WHERE p.hidden = 0 AND (SELECT COUNT(*) FROM items i WHERE i.ebay_purchase_id = p.id) < p.quantity"
    elif show == "hidden":
        sql += " WHERE p.hidden = 1"
    sql += " ORDER BY p.purchased_at DESC"
    conn = db.get_db()
    rows = conn.execute(sql).fetchall()
    linked = {}
    for item in conn.execute("SELECT id, tag, ebay_purchase_id FROM items WHERE ebay_purchase_id IS NOT NULL"):
        linked.setdefault(item["ebay_purchase_id"], []).append(item)
    return render_template("ebay_purchases.html", purchases=rows, linked=linked, show=show)


@app.route("/ebay/purchases/sync", methods=["POST"])
def ebay_purchases_sync():
    try:
        purchases = ebay.fetch_purchases(db.all_settings(), ebay_token(), request.form.get("days", 90))
    except ebay.EbayError as exc:
        flash(str(exc), "error")
        return redirect(url_for("ebay_purchases"))
    conn = db.get_db()
    for p in purchases:
        conn.execute(
            "INSERT INTO ebay_purchases (order_id, ebay_item_id, transaction_id, title, price, currency, "
            "quantity, seller, purchased_at) VALUES (:order_id, :ebay_item_id, :transaction_id, :title, "
            ":price, :currency, :quantity, :seller, :purchased_at) "
            "ON CONFLICT(order_id, ebay_item_id, transaction_id) DO UPDATE SET title = excluded.title, "
            "price = excluded.price, quantity = excluded.quantity, seller = excluded.seller",
            p,
        )
    conn.commit()
    flash(f"Fetched {len(purchases)} purchase(s) from eBay.", "ok")
    return redirect(url_for("ebay_purchases"))


@app.route("/ebay/<any(purchases, sales):table>/<int:row_id>/hide", methods=["POST"])
def ebay_hide(table, row_id):
    conn = db.get_db()
    conn.execute(
        f"UPDATE ebay_{table} SET hidden = ? WHERE id = ?",
        (0 if request.form.get("unhide") else 1, row_id),
    )
    conn.commit()
    return redirect(request.referrer or url_for(f"ebay_{table}"))


@app.route("/ebay/sales")
def ebay_sales():
    show = request.args.get("show", "new")
    sql = (
        "SELECT e.*, (SELECT COUNT(*) FROM sales s WHERE s.ebay_sale_id = e.id) AS linked_count "
        "FROM ebay_sales e"
    )
    if show == "new":
        sql += " WHERE e.hidden = 0 AND (SELECT COUNT(*) FROM sales s WHERE s.ebay_sale_id = e.id) < e.quantity"
    elif show == "hidden":
        sql += " WHERE e.hidden = 1"
    sql += " ORDER BY e.sold_at DESC"
    conn = db.get_db()
    rows = conn.execute(sql).fetchall()
    linked = {}
    for item in conn.execute(
        "SELECT i.id, i.tag, s.ebay_sale_id FROM sales s JOIN items i ON i.id = s.item_id "
        "WHERE s.ebay_sale_id IS NOT NULL"
    ):
        linked.setdefault(item["ebay_sale_id"], []).append(item)
    unsold = conn.execute(
        "SELECT tag, name FROM items WHERE status != 'sold' ORDER BY id DESC LIMIT 1000"
    ).fetchall()
    return render_template("ebay_sales.html", sales=rows, linked=linked, unsold=unsold, show=show)


@app.route("/ebay/sales/sync", methods=["POST"])
def ebay_sales_sync():
    try:
        sold = ebay.fetch_sales(db.all_settings(), ebay_token(), request.form.get("days", 90))
    except ebay.EbayError as exc:
        flash(str(exc), "error")
        return redirect(url_for("ebay_sales"))
    conn = db.get_db()
    for s in sold:
        conn.execute(
            "INSERT INTO ebay_sales (order_id, line_item_id, ebay_item_id, title, price, fee, currency, "
            "quantity, buyer, sold_at) VALUES (:order_id, :line_item_id, :ebay_item_id, :title, :price, "
            ":fee, :currency, :quantity, :buyer, :sold_at) "
            "ON CONFLICT(line_item_id) DO UPDATE SET title = excluded.title, price = excluded.price, "
            "fee = excluded.fee, quantity = excluded.quantity, buyer = excluded.buyer",
            s,
        )
    conn.commit()
    flash(f"Fetched {len(sold)} sold item(s) from eBay.", "ok")
    return redirect(url_for("ebay_sales"))


@app.route("/ebay/sales/<int:sale_id>/link", methods=["POST"])
def ebay_sale_link(sale_id):
    conn = db.get_db()
    sold = conn.execute(
        "SELECT e.*, (SELECT COUNT(*) FROM sales s WHERE s.ebay_sale_id = e.id) AS linked_count "
        "FROM ebay_sales e WHERE e.id = ?",
        (sale_id,),
    ).fetchone()
    if sold is None:
        abort(404)
    ref = request.form.get("item_ref", "")
    matches = find_items(ref)
    if sold["linked_count"] >= sold["quantity"]:
        flash("That eBay sale is already fully linked.", "error")
    elif not matches:
        flash(f"No inventory item found for “{ref}”. Scan its label or type its tag or serial.", "error")
    elif len(matches) > 1:
        flash(f"“{ref}” matches more than one item – use the label tag instead.", "error")
    elif matches[0]["status"] == "sold":
        flash(f"{matches[0]['tag']} already has a sale recorded.", "error")
    else:
        quantity = sold["quantity"] or 1
        record_sale(
            matches[0],
            round((sold["price"] or 0) / quantity, 2),
            round((sold["fee"] or 0) / quantity, 2),
            0,
            (sold["sold_at"] or "")[:10],
            "eBay",
            sold["buyer"],
            f"eBay order {sold['order_id']}",
            ebay_sale_id=sale_id,
        )
        flash(f"Linked {matches[0]['tag']} to the eBay sale.", "ok")
    return redirect(request.referrer or url_for("ebay_sales"))


# ---------- settings & eBay connection ----------

@app.route("/settings", methods=["GET", "POST"])
def settings():
    if request.method == "POST":
        for key in db.DEFAULT_SETTINGS:
            if key in request.form:
                db.set_setting(key, request.form[key].strip())
        flash("Settings saved.", "ok")
        return redirect(url_for("settings"))
    cfg = db.all_settings()
    return render_template(
        "settings.html",
        configured=ebay.is_configured(cfg),
        connected=bool(cfg.get("ebay_refresh_token")),
        callback_url=url_for("ebay_callback", _external=True),
    )


@app.route("/ebay/connect")
def ebay_connect():
    cfg = db.all_settings()
    if not ebay.is_configured(cfg):
        flash("Enter your eBay App ID, Cert ID and RuName first.", "error")
        return redirect(url_for("settings"))
    return redirect(ebay.consent_url(cfg))


def finish_connect(code):
    try:
        store_tokens(ebay.exchange_code(db.all_settings(), code))
        flash("Connected to eBay.", "ok")
    except ebay.EbayError as exc:
        flash(str(exc), "error")
    return redirect(url_for("settings"))


@app.route("/ebay/callback")
def ebay_callback():
    code = request.args.get("code")
    if not code:
        flash("eBay did not return an authorisation code.", "error")
        return redirect(url_for("settings"))
    return finish_connect(code)


@app.route("/ebay/code", methods=["POST"])
def ebay_code():
    """Manual fallback: paste the URL eBay redirected to (or just the code)."""
    pasted = request.form.get("pasted", "").strip()
    if "code=" in pasted:
        code = parse_qs(urlparse(pasted).query).get("code", [""])[0]
    else:
        code = unquote(pasted)
    if not code:
        flash("Could not find an authorisation code in what you pasted.", "error")
        return redirect(url_for("settings"))
    return finish_connect(code)


@app.route("/ebay/disconnect", methods=["POST"])
def ebay_disconnect():
    for key in ("ebay_access_token", "ebay_access_expires", "ebay_refresh_token"):
        db.set_setting(key, "")
    flash("Disconnected from eBay.", "ok")
    return redirect(url_for("settings"))


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 5000)),
        debug=bool(os.environ.get("DEBUG")),
    )
