import { api, html, mount, $, $$, qs, debounce, fmtDate, money, statusBadge, dataBadge, kindBadge, itemSub, labelsUrl, toast, plural } from '../util.js';
import { app } from '../state.js';

// Clicking a header sorts by it; the phone layout (no headers) uses the "Sort" list instead.
const COLUMNS = [
  ['barcode', 'Barcode'], ['name', 'Item'], ['serial', 'Serial / MAC'], ['paid', 'Paid'], ['status', 'Status'], ['data', 'Data'], ['created', 'Added'],
];
const MAX_BULK = 500; // the label PDF takes at most 500 items

export default async function inventoryView({ el, query, isActive }) {
  const s = {
    q: query.get('q') || '', kind: query.get('kind') || '', status: query.get('status') || '',
    category: query.get('category') || '', data: query.get('data') || '',
    sort: query.get('sort') || 'barcode', dir: query.get('dir') === 'asc' ? 'asc' : 'desc',
    limit: Number(query.get('limit')) || 100, page: Math.max(0, (Number(query.get('page')) || 1) - 1),
  };
  const meta = app.meta;
  const selected = new Set(); // ticked items (ids), kept while you page and filter, for printing labels
  let lastTotal = 0;

  const filters = () => ({ q: s.q, kind: s.kind, status: s.status, category: s.category, data: s.data, sort: s.sort, dir: s.dir });
  const params = () => ({ ...filters(), limit: s.limit, offset: s.page * s.limit });
  const syncUrl = () => {
    const p = { ...filters(), limit: s.limit === 100 ? '' : s.limit, page: s.page ? s.page + 1 : '' };
    if (s.sort === 'barcode') delete p.sort;
    if (s.dir === 'desc') delete p.dir;
    history.replaceState(null, '', '#/inventory' + qs(p));
  };

  const opt = (value, label, selectedOpt) => html`<option value="${value}" ${selectedOpt ? 'selected' : ''}>${label}</option>`;

  mount(el, html`
    <div class="page-head">
      <div><h1>Inventory</h1><div class="sub" id="inv-sub"></div></div>
      <div class="actions">
        <a class="btn secondary" id="inv-export" href="/api/items/export.csv">Export CSV</a>
        <a class="btn" href="#/items/new">Add item</a>
      </div>
    </div>
    <div class="toolbar">
      <div class="grow"><input type="search" id="inv-q" placeholder="Search barcode, name, model, serial, MAC…" value="${s.q}" aria-label="Search inventory"></div>
      <select id="inv-kind" aria-label="Kind"><option value="">Repairs &amp; recycling</option>${meta.kinds.map((k) => opt(k, meta.kindLabels[k], k === s.kind))}</select>
      <select id="inv-status" aria-label="Status"><option value="">Any status</option>${opt('active', 'On the shelf (not sold or recycled)', s.status === 'active')}
        ${meta.statuses.map((x) => opt(x, meta.statusLabels[x], x === s.status))}</select>
      <select id="inv-category" aria-label="Category"><option value="">All categories</option>${meta.categories.map((c) => opt(c, c, c === s.category))}</select>
      <select id="inv-data" aria-label="Data wiping"><option value="">Any data status</option>
        ${[['pending', 'Needs wiping'], ['cleared', 'Data cleared'], ['na', 'Holds no data']].map(([v, l]) => opt(v, l, v === s.data))}</select>
      <select id="inv-sort" aria-label="Sort by">${COLUMNS.map(([v, l]) => opt(v, 'Sort: ' + l, v === s.sort))}</select>
      <button class="btn secondary small" id="inv-dir" type="button" aria-label="Sort direction"></button>
      <button class="btn ghost small" id="inv-clear" type="button">Clear</button>
    </div>
    <div id="inv-bulk"></div>
    <div id="inv-results"></div>`);

  // The bar that appears when items are ticked. Drawn on its own, so ticking never re-renders (or scrolls) the list.
  function renderBulk() {
    const n = selected.size;
    mount($('#inv-bulk', el), n ? html`<div class="bulk-bar">
      <span><strong>${n}</strong> selected</span>
      <a class="btn small" href="${labelsUrl([...selected].slice(0, MAX_BULK))}" target="_blank" rel="noopener">Print ${plural(Math.min(n, MAX_BULK), 'label')}</a>
      ${lastTotal > n ? html`<button class="btn ghost small" type="button" data-bulk="all">Select all ${Math.min(lastTotal, MAX_BULK)} matching</button>` : ''}
      <button class="btn ghost small" type="button" data-bulk="clear">Clear</button>
    </div>` : html``);
    const head = $('#inv-all', el);
    if (head) {
      const boxes = $$('.inv-check', el);
      const on = boxes.filter((b) => b.checked).length;
      head.checked = boxes.length > 0 && on === boxes.length;
      head.indeterminate = on > 0 && on < boxes.length;
    }
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    syncUrl();
    $('#inv-sort', el).value = s.sort;
    $('#inv-dir', el).textContent = s.dir === 'asc' ? '▲ Asc' : '▼ Desc';
    $('#inv-export', el).href = '/api/items/export.csv' + qs(filters());
    let data;
    try { data = await api.get('/api/items' + qs(params())); } catch (err) {
      mount($('#inv-results', el), html`<div class="error-box">${err.message}</div>`);
      return;
    }
    if (mine !== seq || !isActive()) return;
    const pages = Math.max(1, Math.ceil(data.total / s.limit));
    if (s.page >= pages) { s.page = pages - 1; return load(); }
    lastTotal = data.total;
    $('#inv-sub', el).textContent = `${plural(data.total, 'item')} match${data.total === 1 ? 'es' : ''}`;
    const from = data.total ? s.page * s.limit + 1 : 0;
    const to = Math.min(data.total, (s.page + 1) * s.limit);
    const filtered = s.q || s.kind || s.status || s.category || s.data;

    mount($('#inv-results', el), html`
      <div class="table-wrap cards"><table class="data inventory-table">
        <thead><tr><th class="ck"><input type="checkbox" id="inv-all" aria-label="Tick every item on this page"></th>${COLUMNS.map(([key, label]) => html`<th class="sortable ${key === 'paid' ? 'num' : ''}" data-sort="${key}" aria-sort="${s.sort === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-ind">${s.sort === key ? (s.dir === 'asc' ? '▲' : '▼') : ''}</span></th>`)}</tr></thead>
        <tbody>${data.items.length ? data.items.map((it) => html`
          <tr class="clickable ${it.status === 'sold' || it.status === 'recycled' ? 'is-sold' : ''}" data-id="${it.id}">
            <td class="ck"><input type="checkbox" class="inv-check" data-id="${it.id}" ${selected.has(it.id) ? 'checked' : ''} aria-label="Tick ${it.barcode}"></td>
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td><div class="cell-main">${it.name} ${kindBadge(it)}</div>${itemSub(it) ? html`<div class="cell-sub">${itemSub(it)}</div>` : ''}</td>
            <td>${it.serial ? html`<div class="mono">${it.serial}</div>` : ''}${it.mac ? html`<div class="cell-sub mono">${it.mac}</div>` : ''}</td>
            <td class="num nowrap">${money(it.purchase_price)}</td>
            <td>${statusBadge(it.status)}
              ${it.status === 'sold' && it.sale_price != null ? html`<div class="cell-sub">for ${money(it.sale_price)}</div>` : ''}
              ${it.collection_id ? html`<div class="cell-sub nowrap">Collection: <a href="#/collections/${it.collection_id}">${it.collection_ref}</a></div>` : ''}
              ${it.location ? html`<div class="cell-sub">📍 ${it.location}</div>` : ''}</td>
            <td>${it.data_status === 'na' ? '' : dataBadge(it.data_status)}</td>
            <td class="nowrap">${fmtDate(it.created_at)}</td>
          </tr>`) : html`<tr><td colspan="${COLUMNS.length + 1}"><div class="empty">${filtered ? 'No items match those filters.' : 'Nothing here yet — add an item, pull in your eBay purchases or start a WEEE collection.'}</div></td></tr>`}
        </tbody></table></div>
      <div class="pager">
        <span>Showing ${from}–${to} of ${data.total}</span>
        <span class="actions">
          <label>Per page <select id="inv-limit">${[25, 50, 100, 250].map((n) => opt(n, n, n === s.limit))}</select></label>
          <button class="btn secondary small" data-page="prev" ${s.page === 0 ? 'disabled' : ''}>← Prev</button>
          <span>Page ${s.page + 1} of ${pages}</span>
          <button class="btn secondary small" data-page="next" ${s.page + 1 >= pages ? 'disabled' : ''}>Next →</button>
        </span>
      </div>`);
    renderBulk();
  }

  const reload = (resetPage = true) => { if (resetPage) s.page = 0; load(); };
  const search = debounce(() => { s.q = $('#inv-q', el).value.trim(); reload(); }, 220);
  $('#inv-q', el).addEventListener('input', search);
  for (const key of ['kind', 'status', 'category', 'data', 'sort']) {
    $(`#inv-${key}`, el).addEventListener('change', (e) => { s[key] = e.target.value; reload(); });
  }
  $('#inv-dir', el).addEventListener('click', () => { s.dir = s.dir === 'asc' ? 'desc' : 'asc'; reload(); });
  $('#inv-clear', el).addEventListener('click', () => {
    Object.assign(s, { q: '', kind: '', status: '', category: '', data: '', sort: 'barcode', dir: 'desc' });
    $('#inv-q', el).value = '';
    for (const key of ['kind', 'status', 'category', 'data']) $(`#inv-${key}`, el).value = '';
    reload();
  });

  $('#inv-bulk', el).addEventListener('click', async (e) => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (act === 'clear') {
      selected.clear();
      $$('.inv-check', el).forEach((b) => { b.checked = false; });
      renderBulk();
    } else if (act === 'all') {
      try {
        const data = await api.get('/api/items' + qs({ ...filters(), limit: MAX_BULK, offset: 0 }));
        data.items.forEach((it) => selected.add(it.id));
        $$('.inv-check', el).forEach((b) => { b.checked = selected.has(Number(b.dataset.id)); });
        if (data.total > MAX_BULK) toast(`Only the first ${MAX_BULK} matches were ticked. Narrow the filters for the rest`, 'info', 5000);
        renderBulk();
      } catch (err) { toast(err.message, 'error', 5000); }
    }
  });

  $('#inv-results', el).addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (s.sort === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.sort = key; s.dir = 'asc'; }
      reload();
      return;
    }
    const pg = e.target.closest('[data-page]');
    if (pg) { s.page += pg.dataset.page === 'next' ? 1 : -1; reload(false); window.scrollTo(0, 0); return; }
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a') && !e.target.closest('.ck')) location.hash = `#/items/${row.dataset.id}`;
  });
  $('#inv-results', el).addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'inv-limit') { s.limit = Number(t.value); reload(); }
    else if (t.classList.contains('inv-check')) {
      const id = Number(t.dataset.id);
      if (t.checked) selected.add(id); else selected.delete(id);
      renderBulk();
    } else if (t.id === 'inv-all') {
      $$('.inv-check', el).forEach((b) => {
        b.checked = t.checked;
        const id = Number(b.dataset.id);
        if (t.checked) selected.add(id); else selected.delete(id);
      });
      renderBulk();
    }
  });

  await load();
  return { refresh: () => load() };
}
