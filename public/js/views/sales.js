import { api, html, mount, fmtDate, fmtMoney, money, profitCell, plural } from '../util.js';

const kpi = (label, value, note) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${note ? html`<div class="note">${note}</div>` : ''}</div>`;

export default async function salesView({ el, isActive }) {
  async function load() {
    const { sales, totals: t } = await api.get('/api/sales');
    if (!isActive()) return;
    mount(el, html`
      <div class="page-head">
        <div><h1>Sales &amp; profit</h1><div class="sub">${plural(t.count, 'item')} sold</div></div>
        <div class="actions"><a class="btn secondary" href="#/ebay-sales">Match eBay sales</a></div>
      </div>
      <div class="kpis">
        ${kpi('Sold for', fmtMoney(t.revenue))}
        ${kpi('Fees & postage', fmtMoney(t.fees + t.postage), `${fmtMoney(t.fees)} fees · ${fmtMoney(t.postage)} postage`)}
        ${kpi('Cost of what sold', fmtMoney(t.cost), 'price paid plus repair parts')}
        ${kpi('Profit', profitCell(t.profit))}
      </div>
      ${sales.length ? html`<div class="table-wrap cards"><table class="data stacked">
        <thead><tr><th>Sold</th><th>Barcode</th><th>Item</th><th>Where</th><th class="num">Sold for</th><th class="num">Fees</th><th class="num">Postage</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
        <tbody>${sales.map((s) => html`<tr class="clickable" onclick="location.hash='#/items/${s.item_id}'">
          <td class="nowrap" data-label="Sold">${fmtDate(s.sold_at)}</td>
          <td><a class="barcode" href="#/items/${s.item_id}">${s.barcode}</a></td>
          <td><div class="cell-main">${s.name}</div>${s.buyer ? html`<div class="cell-sub">to ${s.buyer}</div>` : ''}</td>
          <td data-label="Where">${s.platform || ''}</td>
          <td class="num nowrap" data-label="Sold for">${fmtMoney(s.sale_price)}</td>
          <td class="num nowrap" data-label="Fees">${money(s.fees || null)}</td>
          <td class="num nowrap" data-label="Postage">${money(s.postage || null)}</td>
          <td class="num nowrap" data-label="Cost">${money((s.purchase_price || 0) + (s.repair_cost || 0) || null)}</td>
          <td class="num nowrap" data-label="Profit">${profitCell(s.profit)}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td colspan="4">Total</td><td class="num">${fmtMoney(t.revenue)}</td><td class="num">${fmtMoney(t.fees)}</td><td class="num">${fmtMoney(t.postage)}</td>
          <td class="num">${fmtMoney(t.cost)}</td><td class="num">${profitCell(t.profit)}</td></tr></tfoot>
        </table></div>`
        : html`<div class="empty">Nothing sold yet. Scan or open an item and press <strong>Mark as sold</strong>, or <a href="#/ebay-sales">match your eBay sales</a>.</div>`}`);
  }

  await load();
  return { refresh: load };
}
