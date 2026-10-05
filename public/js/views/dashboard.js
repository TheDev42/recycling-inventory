import { api, html, mount, fmtDate, fmtMoney, timeAgo, plural, dataBadge, kindBadge, itemSub } from '../util.js';

const STATES = [
  { key: 'in_stock', label: 'In stock', c: '--s1' },
  { key: 'repair', label: 'In repair', c: '--s7' },
  { key: 'ready', label: 'Ready to sell', c: '--s3' },
  { key: 'listed', label: 'Listed for sale', c: '--s2' },
];

const kpi = (label, value, { href, color, note, alert } = {}) => html`
  <a class="kpi ${alert ? 'alert' : ''}" href="${href || '#/inventory'}">
    <div class="label">${color ? html`<span class="dot" style="--c:var(${color})"></span>` : ''}${label}</div>
    <div class="value">${value}</div>
    ${note ? html`<div class="note">${note}</div>` : ''}
  </a>`;

function shelfByCategory(rows) {
  if (!rows.length) return html`<div class="empty">Nothing on the shelf yet. <a href="#/items/new">Add an item</a> or <a href="#/purchases">pull in your eBay purchases</a>.</div>`;
  const max = Math.max(...rows.map((r) => r.total));
  return html`
    <div class="legend">${STATES.map((s) => html`<span class="key"><span class="sw" style="--c:var(${s.c})"></span>${s.label}</span>`)}</div>
    <div class="hbars">${rows.map((r) => {
      const parts = STATES.filter((s) => r[s.key] > 0);
      return html`<div class="hbar">
        <div class="name" title="${r.category}">${r.category}</div>
        <div class="track" style="width:${(r.total / max) * 100}%" role="img"
          aria-label="${parts.map((s) => `${r[s.key]} ${s.label.toLowerCase()}`).join(', ')}">
          ${parts.map((s) => html`<span class="seg-fill" style="--c:var(${s.c});flex:${r[s.key]}" title="${r[s.key]} ${s.label.toLowerCase()}"></span>`)}
        </div>
        <div class="total">${r.total}</div>
      </div>`;
    })}</div>`;
}

const activityLine = (e) => html`<li>
  <span class="what">${e.item_id ? html`<a class="barcode" href="#/items/${e.item_id}">${e.barcode}</a> ` : e.barcode ? html`<span class="barcode">${e.barcode}</span> ` : ''}${e.detail}</span>
  <span class="when">${timeAgo(e.ts)}</span></li>`;

export default async function dashboardView({ el, isActive }) {
  async function load() {
    const d = await api.get('/api/dashboard');
    if (!isActive()) return;
    const c = d.counts;
    mount(el, html`
      <div class="page-head">
        <div><h1>Dashboard</h1><div class="sub">${plural(d.stock.count, 'item')} on the shelf · ${fmtDate(d.today)}</div></div>
        <div class="actions">
          <a class="btn secondary" href="#/collections">New collection</a>
          <a class="btn" href="#/items/new">Add item</a>
        </div>
      </div>

      <div class="kpis">
        ${kpi('On the shelf', d.stock.count, { href: '#/inventory?status=active', note: d.stock.weee ? `${d.stock.weee} for recycling` : '' })}
        ${kpi('In repair', c.repair, { href: '#/inventory?status=repair', color: '--s7' })}
        ${kpi('Ready / listed', c.ready + c.listed, { href: '#/inventory?status=ready', color: '--s3', note: `${c.ready} ready · ${c.listed} listed` })}
        ${kpi('Waiting to be wiped', d.pendingWipe.total, { href: '#/wipe', alert: d.pendingWipe.total > 0, note: 'items holding data' })}
        ${kpi('Stock value', fmtMoney(d.stock.value), { href: '#/inventory?status=active', note: 'paid for what is on the shelf' })}
        ${kpi('Profit, last 30 days', fmtMoney(d.sales.recentProfit), { href: '#/sales', note: `${d.sales.recentCount} sold · ${fmtMoney(d.sales.profit)} all time` })}
        ${d.ebay.connected || d.ebay.toAdd ? kpi('eBay purchases to add', d.ebay.toAdd, { href: '#/purchases', color: '--s2' }) : ''}
        ${d.ebay.connected || d.ebay.unmatched ? kpi('eBay sales to match', d.ebay.unmatched, { href: '#/ebay-sales', color: '--s2' }) : ''}
      </div>

      <div class="grid cols-2">
        <section class="card"><div class="card-head"><h2>On the shelf by category</h2><a href="#/inventory?status=active">View all</a></div>${shelfByCategory(d.byCategory)}</section>
        <section class="card">
          <div class="card-head"><h2>Waiting to be wiped</h2><a href="#/wipe">Data wiping</a></div>
          ${d.pendingWipe.items.length ? html`<div class="table-wrap"><table class="data"><tbody>
            ${d.pendingWipe.items.map((it) => html`<tr class="clickable" onclick="location.hash='#/items/${it.id}'">
              <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
              <td><div class="cell-main">${it.name} ${kindBadge(it)}</div>${itemSub(it) ? html`<div class="cell-sub">${itemSub(it)}</div>` : ''}</td>
              <td>${dataBadge(it.data_status)}</td></tr>`)}
          </tbody></table></div>
          ${d.pendingWipe.total > d.pendingWipe.items.length ? html`<p class="muted small-text" style="margin:10px 0 0">…and ${d.pendingWipe.total - d.pendingWipe.items.length} more.</p>` : ''}`
            : html`<div class="empty">Nothing is waiting — every item that holds data has been cleared.</div>`}
        </section>
      </div>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Recent activity</h2></div>
        ${d.activity.length ? html`<ul class="feed">${d.activity.map(activityLine)}</ul>` : html`<div class="empty">Activity from scans, sales and edits will show up here.</div>`}
      </section>`);
  }

  await load();
  return { refresh: load };
}
