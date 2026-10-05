import {
  api, html, mount, $, fmtDate, fmtDateTime, timeAgo, toast, notifyChanged, money, fmtMoney, profitCell,
  statusBadge, statusLabel, dataBadge, driveBadge, kindBadge, itemSub, labelsUrl, ebayItemUrl, errorBox,
} from '../util.js';
import { app } from '../state.js';

const PLATFORMS = ['eBay', 'Facebook Marketplace', 'Gumtree', 'In person', 'Other'];

export default async function itemView({ el, args, isActive }) {
  const id = Number(args[0]);
  let selling = false; // the "mark as sold" form is open

  const wipeControls = () => html`
    <div class="field"><label for="wipe-method">How it was cleared</label>
      <select id="wipe-method">${app.meta.wipeMethods.map((m) => html`<option>${m}</option>`)}</select></div>
    <div class="field"><label for="wipe-date">Date</label><input id="wipe-date" type="date" value="${app.meta.today}"></div>`;

  function storageCard(it, drives) {
    if (!it.data_bearing) {
      return html`<section class="card">
        <h2>Storage &amp; data wiping</h2>
        <p class="muted">Not marked as holding data, so there is nothing to wipe.</p>
        <button class="btn secondary" data-act="holds-data">It does hold data</button>
      </section>`;
    }
    const waiting = drives.filter((d) => d.status === 'pending').length;
    return html`<section class="card">
      <div class="card-head"><h2>Storage &amp; data wiping</h2>${dataBadge(it.data_status)}</div>
      ${drives.length ? html`<div class="table-wrap cards" style="margin-bottom:12px"><table class="data stacked">
        <thead><tr><th>Drive</th><th>Serial</th><th>Size</th><th>Status</th><th></th></tr></thead>
        <tbody>${drives.map((d) => html`<tr>
          <td data-label="Drive">${d.kind || 'Drive'}</td>
          <td data-label="Serial" class="mono">${d.serial || ''}</td>
          <td data-label="Size">${d.capacity || ''}</td>
          <td data-label="Status">${driveBadge(d.status)}${d.status !== 'pending' ? html`<div class="cell-sub">${d.method} · ${fmtDate(d.wiped_at)}</div>` : ''}</td>
          <td><div class="row-actions">
            ${d.status === 'pending' ? html`<button class="btn small" data-wipe-drive="${d.id}">Mark wiped</button>`
              : html`<button class="btn ghost small" data-unwipe-drive="${d.id}" title="Set back to waiting">Undo</button>`}
            <button class="btn ghost small" data-del-drive="${d.id}" title="Remove this drive record">Remove</button></div></td>
        </tr>`)}</tbody></table></div>`
        : html`<p class="muted">No drives recorded yet. Add each drive below, or — for built-in storage such as a phone — just press <strong>Mark storage as wiped</strong>.</p>`}
      ${it.data_status === 'pending' ? html`<div class="inline-form" style="margin-bottom:16px">
        ${wipeControls()}
        <button class="btn" data-act="wipe-all">${waiting > 1 ? `Mark all ${waiting} drives as wiped` : drives.length ? 'Mark as wiped' : 'Mark storage as wiped'}</button>
      </div>` : ''}
      <form id="drive-form" class="inline-form" autocomplete="off">
        <div class="field"><label for="drive-kind">Add a drive</label>
          <select id="drive-kind" name="kind">${app.meta.driveKinds.map((k) => html`<option>${k}</option>`)}</select></div>
        <div class="field"><label for="drive-serial">Serial number</label><input id="drive-serial" name="serial" type="text" placeholder="scan or type"></div>
        <div class="field"><label for="drive-capacity">Size</label><input id="drive-capacity" name="capacity" type="text" placeholder="e.g. 500GB" style="width:110px"></div>
        <button class="btn secondary" type="submit">Add drive</button>
      </form>
      ${!drives.length ? html`<p style="margin:14px 0 0"><button class="btn ghost small" data-act="no-data">It does not hold data after all</button></p>` : ''}
    </section>`;
  }

  function saleCard(it, sale) {
    if (sale) {
      const profit = sale.sale_price - sale.fees - sale.postage - (it.purchase_price || 0) - (it.repair_cost || 0);
      return html`<section class="card">
        <div class="card-head"><h2>Sale</h2><button class="btn secondary small" data-act="undo-sale">Undo sale</button></div>
        <dl class="dl">
          <dt>Sold for</dt><dd><strong>${fmtMoney(sale.sale_price)}</strong></dd>
          <dt>Fees</dt><dd>${fmtMoney(sale.fees)}</dd>
          <dt>Postage</dt><dd>${fmtMoney(sale.postage)}</dd>
          <dt>Cost</dt><dd>${fmtMoney((it.purchase_price || 0) + (it.repair_cost || 0))}</dd>
          <dt>Profit</dt><dd>${profitCell(profit)}</dd>
          <dt>Date</dt><dd>${fmtDate(sale.sold_at)}</dd>
          <dt>Where</dt><dd>${sale.platform || '—'}${sale.ebay_order_id ? html` <span class="muted">· order ${sale.ebay_order_id}</span>` : ''}</dd>
          ${sale.buyer ? html`<dt>Buyer</dt><dd>${sale.buyer}</dd>` : ''}
          ${sale.notes ? html`<dt>Notes</dt><dd>${sale.notes}</dd>` : ''}
        </dl>
      </section>`;
    }
    if (!selling) return '';
    return html`<section class="card picker">
      <h2>Mark as sold</h2>
      <p class="muted">Sold it on eBay? <a href="#/ebay-sales">Match it to the eBay sale</a> instead and the price and fees fill themselves in.</p>
      <form id="sale-form" autocomplete="off">
        <datalist id="platform-list">${PLATFORMS.map((p) => html`<option value="${p}"></option>`)}</datalist>
        <div class="form-grid">
          <div class="field"><label for="sale-price">Sold for (£) *</label><input id="sale-price" name="sale_price" type="number" step="0.01" min="0" required></div>
          <div class="field"><label for="sale-fees">Fees (£)</label><input id="sale-fees" name="fees" type="number" step="0.01" min="0"></div>
          <div class="field"><label for="sale-postage">Postage you paid (£)</label><input id="sale-postage" name="postage" type="number" step="0.01" min="0"></div>
          <div class="field"><label for="sale-date">Date</label><input id="sale-date" name="sold_at" type="date" value="${app.meta.today}"></div>
          <div class="field"><label for="sale-platform">Where</label><input id="sale-platform" name="platform" type="text" list="platform-list" placeholder="e.g. eBay"></div>
          <div class="field"><label for="sale-buyer">Buyer</label><input id="sale-buyer" name="buyer" type="text"></div>
          <div class="field wide"><label for="sale-notes">Notes</label><input id="sale-notes" name="notes" type="text"></div>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Mark as sold</button><button class="btn ghost" type="button" data-act="cancel-sale">Cancel</button></div>
      </form>
    </section>`;
  }

  async function load() {
    let d;
    try { d = await api.get(`/api/items/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const it = d.item;
    const sold = it.status === 'sold';
    const gone = sold || it.status === 'recycled';

    mount(el, html`
      <div class="crumbs"><a href="#/inventory">Inventory</a> / ${it.barcode}</div>
      <div class="card item-hero">
        <div>
          <div class="code">${it.barcode}</div>
          <div style="font-size:1.1rem;font-weight:650;margin-top:2px">${it.name}${itemSub(it) ? html` <span class="muted">— ${itemSub(it)}</span>` : ''}</div>
          <div style="margin-top:8px" class="actions">${statusBadge(it.status)} ${it.data_status === 'na' ? '' : dataBadge(it.data_status)} ${kindBadge(it)}</div>
          ${it.location ? html`<div class="muted" style="margin-top:8px">📍 ${it.location}</div>` : ''}
        </div>
        <div class="actions">
          <a class="btn" href="${labelsUrl([it.id])}" target="_blank" rel="noopener">Print label</a>
          <a class="btn secondary" href="#/items/${it.id}/edit">Edit</a>
          ${sold ? '' : html`<label class="ctx-field">Status
            <select id="status-select" aria-label="Change status">${app.meta.statuses.filter((s) => s !== 'sold').map((s) => html`<option value="${s}" ${s === it.status ? 'selected' : ''}>${statusLabel(s)}</option>`)}</select></label>`}
          ${gone || selling ? '' : html`<button class="btn secondary" data-act="sell">Mark as sold</button>`}
        </div>
      </div>
      ${it.data_status === 'pending' ? html`<div class="notice warn" style="margin-top:16px"><strong>Storage not wiped yet.</strong> This item cannot be sold or recycled until its storage is recorded as wiped or destroyed below.</div>` : ''}

      <div class="grid side" style="margin-top:16px">
        <div class="stack">
          ${saleCard(it, d.sale)}
          ${storageCard(it, d.drives)}

          <section class="card">
            <h2>${it.kind === 'weee' ? 'Notes' : 'Repair notes'}</h2>
            <form id="comment-form" class="stack" style="gap:8px;margin-bottom:12px">
              <textarea name="text" rows="2" placeholder="What you found and what you did — e.g. “No POST, replaced BIOS chip”, “Shorted cap near the VRM”…" aria-label="New note" required></textarea>
              <div><button class="btn" type="submit">Add note</button></div>
            </form>
            ${d.comments.length ? html`<ul class="thread">${d.comments.map((c) => html`
              <li>
                <div class="meta">${fmtDateTime(c.created_at)}<button class="btn ghost small" data-del-comment="${c.id}" title="Delete note">Delete</button></div>
                <div class="body">${c.text}</div>
              </li>`)}</ul>` : html`<div class="empty">No notes yet.</div>`}
          </section>

          <section class="card">
            <h2>Activity</h2>
            ${d.events.length ? html`<ul class="feed">${d.events.map((e) => html`<li><span class="what">${e.detail}</span><span class="when">${timeAgo(e.ts)}</span></li>`)}</ul>` : html`<div class="empty">No activity.</div>`}
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <h2>Details</h2>
            <dl class="dl">
              <dt>Kind</dt><dd>${app.meta.kindLabels[it.kind] || it.kind}</dd>
              <dt>Category</dt><dd>${it.category || '—'}</dd>
              <dt>Brand</dt><dd>${it.brand || '—'}</dd>
              <dt>Model</dt><dd>${it.model || '—'}</dd>
              <dt>Serial number</dt><dd class="mono">${it.serial || '—'}</dd>
              <dt>MAC address</dt><dd class="mono">${it.mac || '—'}</dd>
              <dt>Fault / condition</dt><dd>${it.condition || '—'}</dd>
              <dt>Location</dt><dd>${it.location || '—'}</dd>
              ${it.notes ? html`<dt>Notes</dt><dd style="white-space:pre-wrap">${it.notes}</dd>` : ''}
              <dt>Added</dt><dd>${fmtDate(it.created_at)}</dd>
            </dl>
          </section>

          <section class="card">
            <h2>${it.kind === 'weee' ? 'Where it came from' : 'Purchase'}</h2>
            <dl class="dl">
              <dt>Price paid</dt><dd>${it.purchase_price != null ? html`<strong>${money(it.purchase_price)}</strong>` : '—'}</dd>
              <dt>Repair cost</dt><dd>${money(it.repair_cost) || '—'}</dd>
              <dt>${it.kind === 'weee' ? 'Collected' : 'Bought'}</dt><dd>${fmtDate(it.purchase_date) || '—'}</dd>
              <dt>Source</dt><dd>${it.source || '—'}</dd>
              <dt>${it.kind === 'weee' ? 'From' : 'Seller'}</dt><dd>${it.supplier || '—'}</dd>
              ${it.collection_id ? html`<dt>Collection</dt><dd><a href="#/collections/${it.collection_id}">${it.collection_ref}</a> · ${it.collected_from}</dd>` : ''}
              ${d.purchase ? html`<dt>eBay listing</dt><dd><a href="${ebayItemUrl(d.purchase.ebay_item_id)}" target="_blank" rel="noopener">${d.purchase.title || d.purchase.ebay_item_id}</a>
                <div class="cell-sub">Order ${d.purchase.order_id}</div></dd>` : ''}
            </dl>
          </section>

          <section class="card"><h2>Danger zone</h2>
            <button class="btn danger" data-act="delete">Delete this item</button>
          </section>
        </div>
      </div>`);
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); notifyChanged(); return true; } catch (err) { toast(err.message, 'error', 6000); return false; }
  }
  const wipeBody = () => ({ method: $('#wipe-method', el)?.value || app.meta.wipeMethods[0], date: $('#wipe-date', el)?.value || app.meta.today });

  el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sell') { selling = true; load().then(() => $('#sale-price', el)?.focus()); }
    if (act === 'cancel-sale') { selling = false; load(); }
    if (act === 'undo-sale' && confirm('Undo this sale and put the item back on the shelf?')) run(() => api.del(`/api/items/${id}/sale`), 'Sale undone');
    if (act === 'wipe-all') run(() => api.post(`/api/items/${id}/wipe`, wipeBody()), 'Storage recorded as cleared');
    if (act === 'holds-data') run(() => api.put(`/api/items/${id}`, { data_bearing: true }));
    if (act === 'no-data') run(() => api.put(`/api/items/${id}`, { data_bearing: false }));
    if (act === 'delete' && confirm('Delete this item permanently, including its notes, drives and any sale recorded against it?')) {
      api.del(`/api/items/${id}`).then(() => { toast('Item deleted', 'ok'); location.hash = '#/inventory'; }).catch((err) => toast(err.message, 'error', 5000));
    }
    const wipe = e.target.closest('[data-wipe-drive]');
    if (wipe) run(() => api.post(`/api/items/${id}/drives/${wipe.dataset.wipeDrive}/wipe`, wipeBody()), 'Drive recorded as cleared');
    const unwipe = e.target.closest('[data-unwipe-drive]');
    if (unwipe && confirm('Set this drive back to waiting to be wiped?')) run(() => api.post(`/api/items/${id}/drives/${unwipe.dataset.unwipeDrive}/unwipe`));
    const delDrive = e.target.closest('[data-del-drive]');
    if (delDrive && confirm('Remove this drive record? Its wipe record goes with it.')) run(() => api.del(`/api/items/${id}/drives/${delDrive.dataset.delDrive}`));
    const del = e.target.closest('[data-del-comment]');
    if (del && confirm('Delete this note?')) run(() => api.del(`/api/comments/${del.dataset.delComment}`));
  };

  el.onchange = (e) => {
    if (e.target.id !== 'status-select') return;
    const status = e.target.value;
    // a refused change (storage not wiped, say) puts the list back on the real status
    run(() => api.post(`/api/items/${id}/status`, { status }), `Now ${statusLabel(status).toLowerCase()}`).then((ok) => { if (!ok) load(); });
  };

  el.onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'comment-form') {
      run(() => api.post(`/api/items/${id}/comments`, { text: f.text.value }), 'Note added');
    } else if (f.id === 'drive-form') {
      run(() => api.post(`/api/items/${id}/drives`, { kind: f.kind.value, serial: f.serial.value, capacity: f.capacity.value }), 'Drive added');
    } else if (f.id === 'sale-form') {
      const body = Object.fromEntries(['sale_price', 'fees', 'postage', 'sold_at', 'platform', 'buyer', 'notes'].map((k) => [k, f[k].value]));
      selling = false;
      run(() => api.post(`/api/items/${id}/sale`, body), 'Marked as sold');
    }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onchange = null; el.onsubmit = null; } };
}
