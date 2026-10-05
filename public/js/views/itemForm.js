import { api, html, mount, $, toast, notifyChanged, labelsUrl, errorBox } from '../util.js';
import { app, refreshMeta } from '../state.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';

const SOURCES = ['eBay', 'Collection', 'Facebook Marketplace', 'Trade-in', 'Other'];
const isMac = (code) => /^[0-9a-f]{12}$/i.test(code.replace(/[\s:.-]/g, ''));

export default async function itemFormView({ el, args, query }) {
  const editId = args[0] ? Number(args[0]) : null;
  // A new item can start from an eBay purchase, a WEEE collection or a serial number that was just scanned
  let item = { kind: query.get('kind') === 'weee' ? 'weee' : 'repair', serial: query.get('serial') || '' };
  let collections = [];
  try {
    if (editId) item = (await api.get(`/api/items/${editId}`)).item;
    else if (query.get('purchase')) item = { ...item, ...(await api.get(`/api/ebay/purchases/${Number(query.get('purchase'))}/defaults`)) };
    collections = await api.get('/api/collections');
  } catch (err) { mount(el, errorBox(err)); return; }
  if (!editId && query.get('collection')) {
    const c = collections.find((x) => x.id === Number(query.get('collection')));
    if (c) item = { ...item, kind: 'weee', collection_id: c.id, source: 'Collection', supplier: c.collected_from, purchase_date: c.collected_at };
  }
  if (!editId && item.kind === 'weee' && item.data_bearing === undefined) item.data_bearing = 1;
  const v = (key) => item[key] ?? '';
  const meta = app.meta;

  mount(el, html`
    <div class="crumbs"><a href="#/inventory">Inventory</a> / ${editId ? html`<a href="#/items/${editId}">${item.barcode}</a> / Edit` : 'New item'}</div>
    <div class="page-head"><div><h1>${editId ? 'Edit item' : 'Add item'}</h1>
      ${item.ebay_purchase_id && !editId ? html`<div class="sub">From your eBay purchase — check the details, then save.</div>` : ''}</div></div>
    <form id="item-form" class="card" autocomplete="off">
      <datalist id="category-list">${meta.categories.map((c) => html`<option value="${c}"></option>`)}</datalist>
      <datalist id="source-list">${SOURCES.map((c) => html`<option value="${c}"></option>`)}</datalist>
      <div class="form-grid">
        <div class="field"><label for="f-kind">Kind *</label>
          <select id="f-kind" name="kind">${meta.kinds.map((k) => html`<option value="${k}" ${k === item.kind ? 'selected' : ''}>${meta.kindLabels[k]}</option>`)}</select></div>
        <div class="field wide"><label for="f-name">Name *</label>
          <input id="f-name" name="name" type="text" required maxlength="200" value="${v('name')}" placeholder="e.g. ASUS B450M-A motherboard — no POST"></div>
        <div class="field"><label for="f-category">Category</label>
          <input id="f-category" name="category" type="text" list="category-list" value="${v('category')}" placeholder="e.g. Motherboard"></div>
        <div class="field"><label for="f-brand">Brand</label><input id="f-brand" name="brand" type="text" value="${v('brand')}"></div>
        <div class="field"><label for="f-model">Model</label><input id="f-model" name="model" type="text" value="${v('model')}"></div>
        <div class="field"><label for="f-serial">Serial number</label>
          <input id="f-serial" name="serial" type="text" value="${v('serial')}" placeholder="scan or type">
          <span class="hint">You can scan straight into this page.</span></div>
        <div class="field"><label for="f-mac">MAC address</label>
          <input id="f-mac" name="mac" type="text" value="${v('mac')}" placeholder="AA:BB:CC:DD:EE:FF">
          <span class="hint">More than one? Separate them with commas.</span></div>
        <div class="field wide"><label for="f-condition">Fault / condition</label>
          <input id="f-condition" name="condition" type="text" value="${v('condition')}" placeholder="e.g. No power, bent CPU pins"></div>
        <div class="field"><label for="f-price">Price paid (£)</label>
          <input id="f-price" name="purchase_price" type="number" step="0.01" min="0" value="${v('purchase_price')}" placeholder="including postage"></div>
        <div class="field"><label for="f-repair">Repair cost (£)</label>
          <input id="f-repair" name="repair_cost" type="number" step="0.01" min="0" value="${v('repair_cost')}" placeholder="parts bought to fix it"></div>
        <div class="field"><label for="f-date">Date bought / collected</label><input id="f-date" name="purchase_date" type="date" value="${v('purchase_date')}"></div>
        <div class="field"><label for="f-source">Source</label><input id="f-source" name="source" type="text" list="source-list" value="${v('source')}" placeholder="e.g. eBay"></div>
        <div class="field"><label for="f-supplier">Seller / collected from</label><input id="f-supplier" name="supplier" type="text" value="${v('supplier')}"></div>
        ${collections.length ? html`<div class="field"><label for="f-collection">WEEE collection</label>
          <select id="f-collection" name="collection_id"><option value="">— none —</option>
          ${collections.map((c) => html`<option value="${c.id}" ${c.id === item.collection_id ? 'selected' : ''}>${c.ref} · ${c.collected_from}</option>`)}</select></div>` : ''}
        <div class="field"><label for="f-location">Location</label><input id="f-location" name="location" type="text" value="${v('location')}" placeholder="e.g. Shelf B2"></div>
        <div class="field"><span class="lbl">Data</span>
          <label class="check"><input type="checkbox" name="data_bearing" ${item.data_bearing ? 'checked' : ''}> Holds data (has a drive or built-in storage)</label>
          <span class="hint">It then has to be wiped before it can be sold or recycled.</span></div>
        <div class="field"><label for="f-barcode">Barcode</label>
          <input id="f-barcode" name="barcode" type="text" maxlength="30" value="${v('barcode')}" placeholder="${editId ? '' : `automatic, e.g. ${meta.barcodePrefix}00001`}">
          ${editId ? '' : html`<span class="hint">Leave blank to get the next number.</span>`}</div>
        <div class="field wide"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes" rows="3">${v('notes')}</textarea></div>
      </div>
      <div id="form-error"></div>
      <div class="form-actions">
        <button class="btn" type="submit" data-then="open">${editId ? 'Save changes' : 'Save'}</button>
        ${editId ? '' : html`<button class="btn secondary" type="submit" data-then="print">Save &amp; print label</button>`}
        <a class="btn ghost" href="${editId ? `#/items/${editId}` : '#/inventory'}">Cancel</a>
      </div>
    </form>`);

  const form = $('#item-form', el);
  const field = (name) => form.elements[name];
  if (!editId) field('name').focus();

  // A new recycling item holds data until you say otherwise; switching kind follows that until you touch the box
  let touchedData = !!editId;
  field('data_bearing').addEventListener('change', () => { touchedData = true; });
  field('kind').addEventListener('change', () => { if (!touchedData) field('data_bearing').checked = field('kind').value === 'weee'; });

  // Scanning with no box focused: a MAC address goes in the MAC box (added to any already there), anything else is the serial
  setInterceptor(async (code) => {
    if (isMac(code)) field('mac').value = [field('mac').value.trim(), code].filter(Boolean).join(', ');
    else field('serial').value = code;
    play('lookup');
    return true;
  });
  // A scanner types the code and then presses Enter. In these boxes Enter must NOT save the form: it moves on instead.
  for (const [from, to] of [['serial', 'mac'], ['mac', 'condition']]) {
    field(from).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      field(to).focus();
    });
  }

  let submitter = null;
  form.addEventListener('click', (e) => { submitter = e.target.closest('button[type=submit]') || submitter; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const print = submitter?.dataset.then === 'print';
    const body = Object.fromEntries(['kind', 'name', 'category', 'brand', 'model', 'serial', 'mac', 'condition', 'purchase_price', 'repair_cost',
      'purchase_date', 'source', 'supplier', 'location', 'barcode', 'notes'].map((k) => [k, field(k).value]));
    body.data_bearing = field('data_bearing').checked;
    if (field('collection_id')) body.collection_id = field('collection_id').value;
    if (!editId && item.ebay_purchase_id) body.ebay_purchase_id = item.ebay_purchase_id;
    $('#form-error', form).innerHTML = '';
    // The label opens in its own tab. Browsers only allow that straight from the click, so the tab is opened now and pointed at the label once the item exists.
    const tab = print ? window.open('', '_blank') : null;
    try {
      const saved = editId ? await api.put(`/api/items/${editId}`, body) : await api.post('/api/items', body);
      notifyChanged();
      refreshMeta();
      toast(editId ? 'Saved' : `Saved as ${saved.barcode}`, 'ok');
      if (tab) tab.location = labelsUrl([saved.id]);
      location.hash = `#/items/${saved.id}`;
    } catch (err) {
      tab?.close();
      mount($('#form-error', form), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`);
    }
  });

  return {};
}
