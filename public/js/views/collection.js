import { api, html, mount, $, fmtDate, toast, plural, notifyChanged, statusBadge, dataBadge, itemSub, labelsUrl, errorBox } from '../util.js';
import { app, refreshMeta } from '../state.js';
import { collectionFields, readCollection } from './collections.js';

export default async function collectionView({ el, args, isActive }) {
  const id = Number(args[0]);
  let editing = false;

  async function load() {
    let d;
    try { d = await api.get(`/api/collections/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const c = d.collection;
    // keep what is half-typed in the quick-add boxes when the list underneath refreshes
    const typed = $('#add-form', el) ? Object.fromEntries(new FormData($('#add-form', el))) : null;

    mount(el, html`
      <div class="crumbs"><a href="#/collections">WEEE collections</a> / ${c.ref}</div>
      <div class="card item-hero">
        <div>
          <div class="code">${c.ref}</div>
          <div style="font-size:1.1rem;font-weight:650;margin-top:2px">${c.collected_from} <span class="muted">— ${fmtDate(c.collected_at)}</span></div>
          <div class="muted" style="margin-top:8px">${[c.contact, c.address].filter(Boolean).join(' · ')}</div>
          ${c.notes ? html`<div style="margin-top:8px;white-space:pre-wrap">${c.notes}</div>` : ''}
          <div style="margin-top:8px" class="actions"><span class="chip">${plural(c.item_count, 'item')}</span>
            ${c.pending_wipe ? html`<span class="badge pat-bad"><span class="ico" aria-hidden="true">✕</span>${c.pending_wipe} to wipe</span>`
              : c.item_count ? html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>All data cleared</span>` : ''}</div>
        </div>
        <div class="actions">
          ${d.items.length ? html`<a class="btn" href="${labelsUrl(d.items.map((it) => it.id))}" target="_blank" rel="noopener">Print all ${plural(d.items.length, 'label')}</a>` : ''}
          <button class="btn secondary" data-act="edit">${editing ? 'Cancel edit' : 'Edit'}</button>
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </div>
      ${editing ? html`<form id="edit-form" class="card" autocomplete="off" style="margin-top:16px">
        <h2>Edit collection</h2>${collectionFields(c)}
        <div class="form-actions"><button class="btn" type="submit">Save changes</button></div>
      </form>` : ''}

      <form id="add-form" class="card" autocomplete="off" style="margin-top:16px">
        <h2>Add what you collected</h2>
        <datalist id="category-list">${app.meta.categories.map((x) => html`<option value="${x}"></option>`)}</datalist>
        <div class="form-grid">
          <div class="field"><label for="a-name">Name *</label><input id="a-name" name="name" type="text" required maxlength="200" placeholder="e.g. Dell OptiPlex 7050"></div>
          <div class="field"><label for="a-category">Category</label><input id="a-category" name="category" type="text" list="category-list" placeholder="e.g. Desktop PC"></div>
          <div class="field"><label for="a-brand">Brand</label><input id="a-brand" name="brand" type="text"></div>
          <div class="field"><label for="a-model">Model</label><input id="a-model" name="model" type="text"></div>
          <div class="field"><label for="a-serial">Serial number</label><input id="a-serial" name="serial" type="text" placeholder="scan or type"></div>
          <div class="field"><label for="a-qty">How many</label><input id="a-qty" name="qty" type="number" min="1" max="100" value="1">
            <span class="hint">Identical items, each with its own label.</span></div>
          <div class="field"><span class="lbl">Data</span>
            <label class="check"><input type="checkbox" name="data_bearing" checked> Holds data (needs wiping)</label></div>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Add to collection</button>
          <a class="btn ghost" href="#/items/new?collection=${c.id}">Use the full form</a></div>
      </form>

      <h2 style="margin:24px 0 12px">Items in this collection</h2>
      ${d.items.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Barcode</th><th>Item</th><th>Serial</th><th>Status</th><th>Data</th></tr></thead>
        <tbody>${d.items.map((it) => html`<tr class="clickable" data-id="${it.id}">
          <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
          <td><div class="cell-main">${it.name}</div>${itemSub(it) ? html`<div class="cell-sub">${itemSub(it)}</div>` : ''}</td>
          <td class="mono" data-label="Serial">${it.serial || ''}</td>
          <td>${statusBadge(it.status)}</td>
          <td>${it.data_status === 'na' ? '' : dataBadge(it.data_status)}</td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty">Nothing added yet.</div>`}`);

    const form = $('#add-form', el);
    if (typed) {
      for (const [k, v] of Object.entries(typed)) if (form.elements[k] && form.elements[k].type !== 'checkbox') form.elements[k].value = v;
      form.elements.data_bearing.checked = 'data_bearing' in typed;
    }
  }

  el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { editing = !editing; load(); return; }
    if (act === 'delete' && confirm('Delete this collection? Its items stay on the inventory, they just stop being linked to it.')) {
      api.del(`/api/collections/${id}`).then(() => { toast('Collection deleted', 'ok'); location.hash = '#/collections'; }).catch((err) => toast(err.message, 'error', 5000));
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a')) location.hash = `#/items/${row.dataset.id}`;
  };

  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === 'edit-form') {
        await api.put(`/api/collections/${id}`, readCollection(f));
        editing = false;
        toast('Saved', 'ok');
      } else {
        const body = { ...Object.fromEntries(new FormData(f)), data_bearing: f.elements.data_bearing.checked };
        const { created } = await api.post(`/api/collections/${id}/items`, body);
        toast(created.length === 1 ? `Added as ${created[0].barcode}` : `Added ${created.length} items: ${created[0].barcode} to ${created.at(-1).barcode}`, 'ok');
        // ready for the next one of the same kind: only the serial number is cleared
        f.elements.serial.value = '';
        f.elements.qty.value = 1;
        refreshMeta();
      }
      notifyChanged();
    } catch (err) { toast(err.message, 'error', 5000); }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onsubmit = null; } };
}
