import { api, html, mount, fmtDate, toast, plural } from '../util.js';
import { app } from '../state.js';

// Shared with the collection page, which uses the same boxes to edit one
export const collectionFields = (c = {}) => html`
  <div class="form-grid">
    <div class="field"><label for="c-from">Collected from *</label><input id="c-from" name="collected_from" type="text" required maxlength="120" value="${c.collected_from || ''}" placeholder="Company or person"></div>
    <div class="field"><label for="c-date">Date</label><input id="c-date" name="collected_at" type="date" value="${c.collected_at || app.meta.today}"></div>
    <div class="field"><label for="c-contact">Contact</label><input id="c-contact" name="contact" type="text" value="${c.contact || ''}" placeholder="Name, phone or email"></div>
    <div class="field wide"><label for="c-address">Address</label><input id="c-address" name="address" type="text" value="${c.address || ''}"></div>
    <div class="field wide"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" rows="2">${c.notes || ''}</textarea></div>
  </div>`;
export const readCollection = (f) => Object.fromEntries(['collected_from', 'collected_at', 'contact', 'address', 'notes'].map((k) => [k, f[k].value]));

export default async function collectionsView({ el, isActive }) {
  async function load() {
    const list = await api.get('/api/collections');
    if (!isActive()) return;
    mount(el, html`
      <div class="page-head">
        <div><h1>WEEE collections</h1><div class="sub">${plural(list.length, 'collection')} · each pick-up and what came in with it</div></div>
      </div>
      <form id="collection-form" class="card" autocomplete="off" style="margin-bottom:20px">
        <h2>New collection</h2>
        ${collectionFields()}
        <div class="form-actions"><button class="btn" type="submit">Start collection</button></div>
      </form>
      ${list.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Ref</th><th>Collected from</th><th>Date</th><th class="num">Items</th><th>Data wiping</th></tr></thead>
        <tbody>${list.map((c) => html`<tr class="clickable" data-id="${c.id}">
          <td><a class="barcode" href="#/collections/${c.id}">${c.ref}</a></td>
          <td><div class="cell-main">${c.collected_from}</div>${c.address ? html`<div class="cell-sub">${c.address}</div>` : ''}</td>
          <td class="nowrap" data-label="Collected">${fmtDate(c.collected_at)}</td>
          <td class="num" data-label="Items">${c.item_count}</td>
          <td>${c.pending_wipe ? html`<span class="badge pat-bad"><span class="ico" aria-hidden="true">✕</span>${c.pending_wipe} to wipe</span>`
            : c.item_count ? html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>All clear</span>` : ''}</td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty">No collections yet. Start one above, then add what you picked up.</div>`}`);
  }

  el.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api.post('/api/collections', readCollection(e.target));
      toast(`${c.ref} started — now add what you collected`, 'ok');
      location.hash = `#/collections/${c.id}`;
    } catch (err) { toast(err.message, 'error', 5000); }
  };
  el.onclick = (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a')) location.hash = `#/collections/${row.dataset.id}`;
  };

  await load();
  return { refresh: load, destroy() { el.onsubmit = null; el.onclick = null; } };
}
