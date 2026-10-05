import { api, html, mount, $, qs, debounce, fmtDate, money, fmtMoney, toast, plural, notifyChanged, statusBadge, dataBadge, itemSub, ebayItemUrl } from '../util.js';
import { app } from '../state.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';

const TABS = [['todo', 'To match'], ['matched', 'Matched'], ['hidden', 'Hidden'], ['all', 'All']];
const bucket = (s) => (s.items.length >= s.quantity ? 'matched' : s.hidden ? 'hidden' : 'todo');

export default async function ebaySalesView({ el, query, isActive }) {
  let tab = TABS.some(([t]) => t === query.get('tab')) ? query.get('tab') : 'todo';
  let fetching = false;
  let matching = null; // id of the eBay sale the picker is open for
  let search = '';

  /* ---------- the picker: which inventory item was this sale? ---------- */
  async function renderPicker() {
    const host = $('#match-picker', el);
    if (!matching) { mount(host, html``); return; }
    let d;
    try { d = await api.get(`/api/ebay/sales/${matching}/candidates` + qs({ q: search })); } catch (err) {
      mount(host, html`<div class="error-box">${err.message}</div>`);
      return;
    }
    if (!isActive()) return;
    // keep amounts you have already changed while the list underneath is searched
    const kept = (name, fallback) => $(`#match-form [name=${name}]`, el)?.value ?? fallback;
    const s = d.sale;
    mount(host, html`<section class="card picker" style="margin-bottom:16px">
      <div class="card-head"><h2>Which item was this?</h2><button class="btn ghost small" data-act="close-match">Close</button></div>
      <p><strong>${s.title}</strong> <span class="muted">— sold ${fmtDate(s.sold_at)} to ${s.buyer || 'unknown'} for ${fmtMoney(s.price)}${s.quantity > 1 ? ` (${s.quantity} units)` : ''}</span></p>
      <form id="match-form" class="inline-form" autocomplete="off" style="margin-bottom:14px">
        <div class="field"><label for="m-price">Sold for (£)</label><input id="m-price" name="sale_price" type="number" step="0.01" min="0" value="${kept('sale_price', d.defaults.sale_price)}" style="width:120px">
          <span class="hint">${s.postage_charged ? 'Price plus the postage the buyer paid' : s.quantity > 1 ? 'Per unit' : 'From eBay'}</span></div>
        <div class="field"><label for="m-fees">eBay fees (£)</label><input id="m-fees" name="fees" type="number" step="0.01" min="0" value="${kept('fees', d.defaults.fees)}" style="width:120px"><span class="hint">From eBay</span></div>
        <div class="field"><label for="m-postage">Postage you paid (£)</label><input id="m-postage" name="postage" type="number" step="0.01" min="0" value="${kept('postage', '')}" style="width:120px"><span class="hint">Your label cost</span></div>
      </form>
      <div class="toolbar"><div class="grow"><input type="search" id="match-q" placeholder="Search the inventory, or scan the item's label" value="${search}" aria-label="Search for the item"></div></div>
      ${d.items.length ? html`<div class="table-wrap cards pk-table"><table class="data stacked">
        <thead><tr><th>Barcode</th><th>Item</th><th>Serial</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.items.map((it) => html`<tr>
          <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
          <td><div class="cell-main">${it.name}</div>${itemSub(it) ? html`<div class="cell-sub">${itemSub(it)}</div>` : ''}</td>
          <td class="mono" data-label="Serial">${it.serial || ''}</td>
          <td class="num nowrap" data-label="Paid">${money(it.purchase_price)}</td>
          <td>${statusBadge(it.status)} ${it.data_status === 'pending' ? dataBadge(it.data_status) : ''}</td>
          <td><div class="row-actions"><button class="btn small" data-pick="${it.id}">This one — mark sold</button></div></td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty">${search ? 'Nothing on the shelf matches that search.' : 'Nothing on the shelf looks like this listing. Search for it, or scan its label.'}</div>`}
      ${!search && d.items.length ? html`<p class="muted small-text" style="margin:10px 0 0">Best guesses from the listing title. Not there? Search, or scan the label on the item you are posting.</p>` : ''}
    </section>`);
  }

  function openPicker(id) {
    matching = id;
    search = '';
    // Scanning a label while the picker is open finds that item in it, rather than leaving the page
    setInterceptor(async (code) => {
      search = code;
      play('lookup');
      await renderPicker();
      return true;
    });
    renderPicker().then(() => $('#match-picker', el)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  function closePicker() {
    matching = null;
    setInterceptor(null);
    renderPicker();
  }

  /* ---------- the list ---------- */
  async function load() {
    const list = await api.get('/api/ebay/sales');
    if (!isActive()) return;
    const count = (t) => (t === 'all' ? list.length : list.filter((s) => bucket(s) === t).length);
    const rows = tab === 'all' ? list : list.filter((s) => bucket(s) === tab);
    const { connected, maxDays } = app.meta.ebay;
    if (matching && !list.some((s) => s.id === matching && s.items.length < s.quantity)) { matching = null; setInterceptor(null); }

    mount(el, html`
      <div class="page-head">
        <div><h1>Sold on eBay</h1><div class="sub">Match each eBay sale to the item on your shelf to mark it sold, with the price and fees filled in</div></div>
        <div class="actions"><button class="btn" data-act="fetch" ${connected && !fetching ? '' : 'disabled'}>${fetching ? 'Fetching…' : 'Fetch from eBay'}</button></div>
      </div>
      ${connected ? '' : html`<div class="notice warn">eBay is not connected yet. <a href="#/settings">Set it up on the Settings page</a> — until then, open an item and use <strong>Mark as sold</strong>.</div>`}
      <div id="match-picker"></div>
      <div class="tabs">${TABS.map(([t, label]) => html`<button class="tab" data-tab="${t}" aria-pressed="${String(t === tab)}">${label}<span class="count">${count(t)}</span></button>`)}</div>
      ${rows.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Sold</th><th>Listing</th><th>Buyer</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Fees</th><th>Item</th><th></th></tr></thead>
        <tbody>${rows.map((s) => html`<tr class="${s.id === matching ? 'picked' : ''}">
          <td class="nowrap" data-label="Sold">${fmtDate(s.sold_at)}</td>
          <td><div class="cell-main">${s.ebay_item_id ? html`<a href="${ebayItemUrl(s.ebay_item_id)}" target="_blank" rel="noopener">${s.title}</a>` : s.title}</div>
            <div class="cell-sub">Order ${s.order_id}${s.currency && s.currency !== 'GBP' ? ` · prices in ${s.currency}` : ''}</div></td>
          <td data-label="Buyer">${s.buyer}</td>
          <td class="num" data-label="Qty">${s.quantity}</td>
          <td class="num nowrap" data-label="Price">${money(s.price)}${s.postage_charged ? html`<div class="cell-sub">+ ${money(s.postage_charged)} postage</div>` : ''}</td>
          <td class="num nowrap" data-label="Fees">${money(s.fee)}</td>
          <td>${s.items.map((i) => html`<div><a class="barcode" href="#/items/${i.id}">${i.barcode}</a>
            <button class="btn ghost small" data-unmatch="${i.id}" title="Undo: the item goes back on the shelf">Unmatch</button></div>`)}</td>
          <td><div class="row-actions">
            ${s.items.length < s.quantity ? html`
              <button class="btn small" data-match="${s.id}">${s.items.length ? `Match another (${s.items.length} of ${s.quantity})` : 'Match to an item'}</button>
              <button class="btn ghost small" data-hide="${s.id}" data-hidden="${s.hidden ? '0' : '1'}">${s.hidden ? 'Unhide' : 'Hide'}</button>` : ''}
          </div></td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty">${list.length ? 'Nothing in this list.' : connected ? `Nothing fetched yet. Press “Fetch from eBay” to pull in the last ${maxDays} days.` : 'Nothing here yet.'}</div>`}
      <p class="muted small-text" style="margin-top:12px">Sales of things that were never on this inventory can be hidden.</p>`);
    await renderPicker();
  }

  const onSearch = debounce(() => { search = $('#match-q', el)?.value.trim() || ''; renderPicker().then(() => { const q = $('#match-q', el); q?.focus(); q?.setSelectionRange(q.value.length, q.value.length); }); }, 250);
  el.oninput = (e) => { if (e.target.id === 'match-q') onSearch(); };
  el.onsubmit = (e) => e.preventDefault();

  el.onclick = async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; load(); return; }
    if (e.target.closest('[data-act=close-match]')) { closePicker(); return; }
    const match = e.target.closest('[data-match]');
    if (match) { openPicker(Number(match.dataset.match)); return; }
    try {
      if (e.target.closest('[data-act=fetch]')) {
        fetching = true;
        load();
        try {
          const res = await api.post('/api/ebay/sales/fetch');
          toast(res.added ? `${plural(res.added, 'new sale')} fetched` : `Nothing new (${plural(res.fetched, 'sale')} checked)`, res.added ? 'ok' : 'info');
        } finally { fetching = false; }
        notifyChanged();
        return;
      }
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        const f = $('#match-form', el);
        pick.disabled = true;
        const it = await api.post(`/api/ebay/sales/${matching}/match`, {
          item_id: Number(pick.dataset.pick), sale_price: f.sale_price.value, fees: f.fees.value, postage: f.postage.value,
        });
        play('lookup');
        toast(`${it.barcode} marked as sold for ${fmtMoney(it.sale_price)}`, 'ok', 5000);
        search = '';
        notifyChanged(); // the picker closes by itself once every unit of the sale is matched
        return;
      }
      const unmatch = e.target.closest('[data-unmatch]');
      if (unmatch && confirm('Undo this match? The item goes back on the shelf and the sale needs matching again.')) {
        await api.del(`/api/items/${unmatch.dataset.unmatch}/sale`);
        notifyChanged();
        return;
      }
      const hide = e.target.closest('[data-hide]');
      if (hide) {
        await api.post(`/api/ebay/sales/${hide.dataset.hide}/hide`, { hidden: hide.dataset.hidden === '1' });
        notifyChanged();
      }
    } catch (err) {
      toast(err.message, 'error', 7000);
      load();
    }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.oninput = null; el.onsubmit = null; } };
}
