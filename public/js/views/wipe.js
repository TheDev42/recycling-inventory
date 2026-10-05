import { api, html, mount, fmtDate, toast, plural, notifyChanged, kindBadge, itemSub } from '../util.js';
import { app } from '../state.js';

export default async function wipeView({ el, isActive }) {
  // kept across refreshes, so you can work down the list with the same method chosen
  let method = app.meta.wipeMethods[0];
  let date = app.meta.today;

  async function load() {
    const [pending, log] = await Promise.all([api.get('/api/items?data=pending&sort=created&dir=asc&limit=500'), api.get('/api/wipe-log')]);
    if (!isActive()) return;
    mount(el, html`
      <div class="page-head">
        <div><h1>Data wiping</h1><div class="sub">${pending.total ? `${plural(pending.total, 'item')} still holding data` : 'Nothing is waiting to be wiped'}</div></div>
        <div class="actions"><a class="btn secondary" href="/api/wipe-log/export.csv">Export wipe log (CSV)</a></div>
      </div>

      ${pending.items.length ? html`
        <div class="toolbar">
          <label class="ctx-field">How it was cleared
            <select id="wipe-method">${app.meta.wipeMethods.map((m) => html`<option ${m === method ? 'selected' : ''}>${m}</option>`)}</select></label>
          <label class="ctx-field">Date <input id="wipe-date" type="date" value="${date}"></label>
          <span class="muted small-text">Used by the “Mark wiped” buttons below. Open an item to record each drive’s serial number first.</span>
        </div>
        <div class="table-wrap cards"><table class="data stacked">
          <thead><tr><th>Barcode</th><th>Item</th><th>From</th><th>Added</th><th></th></tr></thead>
          <tbody>${pending.items.map((it) => html`<tr>
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td><div class="cell-main">${it.name} ${kindBadge(it)}</div>
              ${itemSub(it) || it.serial ? html`<div class="cell-sub">${[itemSub(it), it.serial ? `S/N ${it.serial}` : ''].filter(Boolean).join(' · ')}</div>` : ''}</td>
            <td data-label="From">${it.collection_id ? html`<a href="#/collections/${it.collection_id}">${it.collection_ref}</a> · ${it.collected_from}` : it.supplier || ''}</td>
            <td class="nowrap" data-label="Added">${fmtDate(it.created_at)}</td>
            <td><div class="row-actions"><button class="btn small" data-wipe="${it.id}">Mark wiped</button>
              <a class="btn secondary small" href="#/items/${it.id}">Drives…</a></div></td>
          </tr>`)}</tbody></table></div>`
        : html`<div class="empty">Every item that holds data has been recorded as wiped or destroyed.</div>`}

      <h2 style="margin:28px 0 12px">Wipe log</h2>
      ${log.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Date</th><th>Item</th><th>Drive</th><th>Serial</th><th>Method</th></tr></thead>
        <tbody>${log.map((d) => html`<tr>
          <td class="nowrap" data-label="Date">${fmtDate(d.wiped_at)}</td>
          <td><a class="barcode" href="#/items/${d.item_id}">${d.barcode}</a> ${d.name}${d.collection_ref ? html`<div class="cell-sub">${d.collection_ref} · ${d.collected_from}</div>` : ''}</td>
          <td data-label="Drive">${[d.kind, d.capacity].filter(Boolean).join(' · ')}</td>
          <td class="mono" data-label="Serial">${d.serial || ''}</td>
          <td data-label="Method">${d.method}</td>
        </tr>`)}</tbody></table></div>
        ${log.length >= 200 ? html`<p class="muted small-text" style="margin-top:10px">Showing the latest 200. The CSV export has everything.</p>` : ''}`
        : html`<div class="empty">Nothing has been wiped yet.</div>`}`);
  }

  el.onchange = (e) => {
    if (e.target.id === 'wipe-method') method = e.target.value;
    if (e.target.id === 'wipe-date') date = e.target.value;
  };
  el.onclick = async (e) => {
    const btn = e.target.closest('[data-wipe]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const it = await api.post(`/api/items/${btn.dataset.wipe}/wipe`, { method, date });
      toast(`${it.barcode} recorded as cleared`, 'ok');
      notifyChanged();
    } catch (err) { btn.disabled = false; toast(err.message, 'error', 5000); }
  };

  await load();
  return { refresh: load, destroy() { el.onchange = null; el.onclick = null; } };
}
