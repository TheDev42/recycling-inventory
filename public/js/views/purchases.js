import { api, html, mount, fmtDate, money, toast, plural, notifyChanged, ebayItemUrl } from '../util.js';
import { app } from '../state.js';

const TABS = [['todo', 'To add'], ['added', 'On the inventory'], ['hidden', 'Hidden'], ['all', 'All']];
const bucket = (p) => (p.items.length >= p.quantity ? 'added' : p.hidden ? 'hidden' : 'todo');

export default async function purchasesView({ el, query, isActive }) {
  let tab = TABS.some(([t]) => t === query.get('tab')) ? query.get('tab') : 'todo';
  let fetching = false;

  async function load() {
    const list = await api.get('/api/ebay/purchases');
    if (!isActive()) return;
    const count = (t) => (t === 'all' ? list.length : list.filter((p) => bucket(p) === t).length);
    const rows = tab === 'all' ? list : list.filter((p) => bucket(p) === tab);
    const { connected, maxDays } = app.meta.ebay;

    mount(el, html`
      <div class="page-head">
        <div><h1>eBay purchases</h1><div class="sub">What you bought on eBay, ready to turn into inventory items</div></div>
        <div class="actions"><button class="btn" data-act="fetch" ${connected && !fetching ? '' : 'disabled'}>${fetching ? 'Fetching…' : 'Fetch from eBay'}</button></div>
      </div>
      ${connected ? '' : html`<div class="notice warn">eBay is not connected yet. <a href="#/settings">Set it up on the Settings page</a> — until then you can still <a href="#/items/new">add items by hand</a>.</div>`}
      <div class="tabs">${TABS.map(([t, label]) => html`<button class="tab" data-tab="${t}" aria-pressed="${String(t === tab)}">${label}<span class="count">${count(t)}</span></button>`)}</div>
      ${rows.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Bought</th><th>Item</th><th>Seller</th><th class="num">Qty</th><th class="num">Price each</th><th class="num">Postage</th><th>Inventory</th><th></th></tr></thead>
        <tbody>${rows.map((p) => html`<tr>
          <td class="nowrap" data-label="Bought">${fmtDate(p.purchased_at)}</td>
          <td><div class="cell-main"><a href="${ebayItemUrl(p.ebay_item_id)}" target="_blank" rel="noopener">${p.title || p.ebay_item_id}</a></div>
            <div class="cell-sub">Order ${p.order_id}${p.currency && p.currency !== 'GBP' ? ` · prices in ${p.currency}` : ''}</div></td>
          <td data-label="Seller">${p.seller}</td>
          <td class="num" data-label="Qty">${p.quantity}</td>
          <td class="num nowrap" data-label="Price each">${money(p.price)}</td>
          <td class="num nowrap" data-label="Postage">${money(p.postage)}</td>
          <td>${p.items.map((i) => html`<a class="barcode" href="#/items/${i.id}">${i.barcode}</a> `)}
            ${p.items.length && p.items.length < p.quantity ? html`<span class="muted small-text">${p.items.length} of ${p.quantity}</span>` : ''}</td>
          <td><div class="row-actions">
            ${p.items.length < p.quantity ? html`
              <button class="btn small" data-add="${p.id}" title="Adds it with the listing title as its name, ready for a label">Add to inventory${p.quantity - p.items.length > 1 ? ` (×${p.quantity - p.items.length})` : ''}</button>
              <a class="btn secondary small" href="#/items/new?purchase=${p.id}" title="Fill in the model, serial number and MAC address before saving">Add with details</a>
              <button class="btn ghost small" data-hide="${p.id}" data-hidden="${p.hidden ? '0' : '1'}">${p.hidden ? 'Unhide' : 'Hide'}</button>` : ''}
          </div></td>
        </tr>`)}</tbody></table></div>`
        : html`<div class="empty">${list.length ? 'Nothing in this list.' : connected ? `Nothing fetched yet. Press “Fetch from eBay” to pull in the last ${maxDays} days.` : 'Nothing here yet.'}</div>`}
      <p class="muted small-text" style="margin-top:12px">eBay only hands out the last ${maxDays} days of purchases, so fetch at least that often. Things you bought that are not stock (packaging, tools…) can be hidden.</p>`);
  }

  el.onclick = async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; load(); return; }
    try {
      if (e.target.closest('[data-act=fetch]')) {
        fetching = true;
        load();
        try {
          const res = await api.post('/api/ebay/purchases/fetch');
          toast(res.added ? `${plural(res.added, 'new purchase')} fetched` : `Nothing new (${plural(res.fetched, 'purchase')} checked)`, res.added ? 'ok' : 'info');
        } finally { fetching = false; }
        notifyChanged();
        return;
      }
      const add = e.target.closest('[data-add]');
      if (add) {
        add.disabled = true;
        const { created } = await api.post(`/api/ebay/purchases/${add.dataset.add}/add`);
        toast(`Added as ${created.map((i) => i.barcode).join(', ')}`, 'ok', 6000);
        notifyChanged();
        // straight to the item when there is just one, so the serial number can go in and the label can be printed
        if (created.length === 1) location.hash = `#/items/${created[0].id}`;
        return;
      }
      const hide = e.target.closest('[data-hide]');
      if (hide) {
        await api.post(`/api/ebay/purchases/${hide.dataset.hide}/hide`, { hidden: hide.dataset.hidden === '1' });
        notifyChanged();
      }
    } catch (err) {
      toast(err.message, 'error', 7000);
      load();
    }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; } };
}
