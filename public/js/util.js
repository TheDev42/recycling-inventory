/* ---------- safe HTML templating: interpolated values are escaped unless wrapped in raw() / html`` ---------- */
export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Safe(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
};
export const html = (strings, ...vals) =>
  new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? render(vals[i]) : ''), ''));
// Tolerates a missing target: a slow request can finish after you have already navigated to another page.
export const mount = (el, tpl) => { if (el) el.innerHTML = tpl instanceof Safe ? tpl.s : esc(tpl); };

/* ---------- DOM helpers ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

/* ---------- API ---------- */
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
api.get = (url) => api('GET', url);
api.post = (url, body = {}) => api('POST', url, body);
api.put = (url, body = {}) => api('PUT', url, body);
api.del = (url) => api('DELETE', url);
export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---------- formatting ---------- */
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const fmtMoney = (n) => `${n < 0 ? '−' : ''}£${Math.abs(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// blank (not £0.00) when nothing was recorded
export const money = (n) => (n == null ? '' : fmtMoney(n));
export const profitCell = (n) => html`<span class="money ${n < 0 ? 'neg' : 'pos'}">${fmtMoney(n)}</span>`;

/* ---------- shared badges (icon + label, never colour alone) ---------- */
const STATUS_META = {
  in_stock: { label: 'In stock', icon: '●', cls: 'st-stock' },
  repair: { label: 'In repair', icon: '⚒', cls: 'st-repair' },
  ready: { label: 'Ready to sell', icon: '✓', cls: 'st-ready' },
  listed: { label: 'Listed for sale', icon: '➜', cls: 'st-listed' },
  sold: { label: 'Sold', icon: '£', cls: 'st-sold' },
  recycled: { label: 'Recycled', icon: '♻', cls: 'st-recycled' },
};
export const statusLabel = (s) => STATUS_META[s]?.label || s;
export const statusBadge = (s) => {
  const m = STATUS_META[s] || { label: s, icon: '•', cls: '' };
  return html`<span class="badge ${m.cls}"><span class="ico" aria-hidden="true">${m.icon}</span>${m.label}</span>`;
};

const DATA_META = {
  pending: { label: 'Needs wiping', icon: '✕', cls: 'pat-bad' },
  cleared: { label: 'Data cleared', icon: '✓', cls: 'pat-ok' },
  na: { label: 'No data', icon: '–', cls: 'pat-na' },
};
export const dataBadge = (s) => {
  const m = DATA_META[s] || { label: s, icon: '•', cls: '' };
  return html`<span class="badge ${m.cls}"><span class="ico" aria-hidden="true">${m.icon}</span>${m.label}</span>`;
};
export const driveBadge = (s) =>
  s === 'pending' ? html`<span class="badge pat-bad"><span class="ico" aria-hidden="true">✕</span>Waiting</span>`
    : html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>${s === 'destroyed' ? 'Destroyed' : 'Wiped'}</span>`;

// Only recycling stock gets a badge (bought-to-repair stock is the norm, so it stays quiet)
export const kindBadge = (it) =>
  it.kind === 'weee' ? html`<span class="badge st-weee" title="Collected for WEEE recycling"><span class="ico" aria-hidden="true">♻</span>WEEE</span>` : '';

export const itemSub = (it) => [it.category, [it.brand, it.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
export const labelsUrl = (ids) => `/api/labels.pdf?ids=${ids.join(',')}`;
export const ebayItemUrl = (itemId) => `https://www.ebay.co.uk/itm/${encodeURIComponent(itemId)}`;

/* ---------- toasts ---------- */
export function toast(message, kind = 'info', ms = 3800) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

export const CHANGED = 'inventory:changed';
export const notifyChanged = () => document.dispatchEvent(new CustomEvent(CHANGED));

/* ---------- small icon set ---------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  inventory: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  add: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
  collections: '<path d="M4 8l8-4 8 4v9l-8 4-8-4V8z"/><path d="M4 8l8 4 8-4M12 12v9"/>',
  wipe: '<path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  purchases: '<path d="M3 7h18v13a1 1 0 01-1 1H4a1 1 0 01-1-1V7z"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18"/>',
  ebaySales: '<path d="M9 4h6a1 1 0 011 1v1H8V5a1 1 0 011-1z"/><rect x="5" y="6" width="14" height="15" rx="2"/><path d="M9 12h6M9 16h4"/>',
  sales: '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
};
export const icon = (name) =>
  raw(`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

export const errorBox = (err) => html`<div class="error-box"><strong>Something went wrong:</strong> ${err.message || err}</div>`;
