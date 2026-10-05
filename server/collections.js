import { all, get, run, tx, HttpError, nowIso, today } from './db.js';
import { createItem, listItems, text, date } from './items.js';

// How many items a collection has, and how many of them still have storage waiting to be wiped
const COUNTS = `(SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
  (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id AND i.data_bearing = 1
     AND (NOT EXISTS (SELECT 1 FROM drives d WHERE d.item_id = i.id)
       OR EXISTS (SELECT 1 FROM drives d WHERE d.item_id = i.id AND d.status = 'pending'))) AS pending_wipe`;

const getCollection = (id) => get(`SELECT c.*, ${COUNTS} FROM collections c WHERE c.id = ?`, id);
function mustCollection(id) {
  const c = getCollection(id);
  if (!c) throw new HttpError(404, 'Collection not found');
  return c;
}

export const listCollections = () => all(`SELECT c.*, ${COUNTS} FROM collections c ORDER BY c.collected_at DESC, c.id DESC`);

function fields(body) {
  const collected_from = text(body.collected_from, 120);
  if (!collected_from) throw new HttpError(400, 'Say who it was collected from');
  return {
    collected_from, contact: text(body.contact, 120), address: text(body.address, 300),
    collected_at: date(body.collected_at, 'Collection date') || today(), notes: text(body.notes, 2000),
  };
}

export function createCollection(body = {}) {
  return tx(() => {
    const f = fields(body);
    const n = (get("SELECT MAX(CAST(SUBSTR(ref, 5) AS INTEGER)) AS n FROM collections WHERE ref LIKE 'COL-%'").n || 0) + 1;
    const res = run('INSERT INTO collections (ref, collected_from, contact, address, collected_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      `COL-${String(n).padStart(4, '0')}`, f.collected_from, f.contact, f.address, f.collected_at, f.notes, nowIso());
    return getCollection(Number(res.lastInsertRowid));
  });
}

export function updateCollection(id, body = {}) {
  mustCollection(id);
  const f = fields(body);
  run('UPDATE collections SET collected_from = ?, contact = ?, address = ?, collected_at = ?, notes = ? WHERE id = ?',
    f.collected_from, f.contact, f.address, f.collected_at, f.notes, id);
  return getCollection(id);
}

// The items stay on the inventory; they just stop pointing at this collection
export function deleteCollection(id) {
  mustCollection(id);
  run('DELETE FROM collections WHERE id = ?', id);
}

export function collectionDetail(id) {
  return { collection: mustCollection(id), items: listItems({ collection: id, limit: 1000, sort: 'barcode' }).items };
}

// Quick add from the collection page: `qty` identical items in one go (a serial number only makes sense for one)
export function addItems(id, body = {}) {
  return tx(() => {
    const c = mustCollection(id);
    const qty = Math.min(Math.max(parseInt(body.qty, 10) || 1, 1), 100);
    if (qty > 1 && text(body.serial, 120)) throw new HttpError(400, 'A serial number belongs to one item, so set the quantity to 1');
    const created = [];
    for (let i = 0; i < qty; i++) {
      created.push(createItem({
        kind: 'weee', name: body.name, category: body.category, brand: body.brand, model: body.model, serial: body.serial,
        condition: body.condition, location: body.location, data_bearing: !!body.data_bearing,
        collection_id: id, source: 'Collection', supplier: c.collected_from, purchase_date: c.collected_at,
      }));
    }
    return { created };
  });
}
