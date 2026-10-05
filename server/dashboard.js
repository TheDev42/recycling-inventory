import { all, get, today } from './db.js';
import { STATUSES, listItems, listSales, profitOf } from './items.js';
import { isConnected } from './ebay.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function dashboard() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of all('SELECT status, COUNT(*) AS n FROM items GROUP BY status')) counts[r.status] = r.n;

  const stock = get(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(purchase_price, 0) + COALESCE(repair_cost, 0)), 0) AS value,
                       COALESCE(SUM(kind = 'weee'), 0) AS weee
                     FROM items WHERE status NOT IN ('sold', 'recycled')`);
  const pending = listItems({ data: 'pending', sort: 'created', limit: 8 });

  const { sales, totals } = listSales();
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const recent = sales.filter((s) => (s.sold_at || '') >= since);

  return {
    today: today(),
    counts,
    stock: { count: stock.n, value: round2(stock.value), weee: stock.weee },
    pendingWipe: { total: pending.total, items: pending.items },
    sales: { count: totals.count, profit: totals.profit, recentCount: recent.length, recentProfit: round2(recent.reduce((n, s) => n + profitOf(s), 0)) },
    ebay: {
      connected: isConnected(),
      toAdd: get(`SELECT COUNT(*) AS n FROM ebay_purchases p WHERE p.hidden = 0
                  AND (SELECT COUNT(*) FROM items i WHERE i.ebay_purchase_id = p.id) < p.quantity`).n,
      unmatched: get(`SELECT COUNT(*) AS n FROM ebay_sales e WHERE e.hidden = 0
                      AND (SELECT COUNT(*) FROM sales s WHERE s.ebay_sale_id = e.id) < e.quantity`).n,
    },
    // what is on the shelf right now, by category
    byCategory: all(`SELECT COALESCE(category, 'Uncategorised') AS category, COUNT(*) AS total,
                       SUM(status = 'in_stock') AS in_stock, SUM(status = 'repair') AS repair,
                       SUM(status = 'ready') AS ready, SUM(status = 'listed') AS listed
                     FROM items WHERE status NOT IN ('sold', 'recycled') GROUP BY 1 ORDER BY total DESC, 1 LIMIT 12`),
    activity: all('SELECT * FROM events ORDER BY id DESC LIMIT 15'),
  };
}
