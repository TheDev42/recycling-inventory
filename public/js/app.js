import { $, html, mount, icon, store, CHANGED, errorBox } from './util.js';
import { app, loadMeta } from './state.js';
import { initScanner, setInterceptor } from './scanner.js';

import dashboardView from './views/dashboard.js';
import inventoryView from './views/inventory.js';
import itemView from './views/item.js';
import itemFormView from './views/itemForm.js';
import collectionsView from './views/collections.js';
import collectionView from './views/collection.js';
import wipeView from './views/wipe.js';
import purchasesView from './views/purchases.js';
import ebaySalesView from './views/ebaySales.js';
import salesView from './views/sales.js';
import settingsView from './views/settings.js';

const NAV = [
  ['Overview', [['dashboard', 'Dashboard', '/dashboard']]],
  ['Stock', [['inventory', 'Inventory', '/inventory'], ['add', 'Add item', '/items/new']]],
  ['Recycling', [['collections', 'WEEE collections', '/collections'], ['wipe', 'Data wiping', '/wipe']]],
  ['eBay', [['purchases', 'Purchases', '/purchases'], ['ebaySales', 'Sold on eBay', '/ebay-sales']]],
  ['Money', [['sales', 'Sales & profit', '/sales']]],
  ['System', [['settings', 'Settings', '/settings']]],
];

const ROUTES = [
  [/^\/dashboard$/, dashboardView, '/dashboard'],
  [/^\/inventory$/, inventoryView, '/inventory'],
  [/^\/items\/new$/, itemFormView, '/items/new'],
  [/^\/items\/(\d+)\/edit$/, itemFormView, '/inventory'],
  [/^\/items\/(\d+)$/, itemView, '/inventory'],
  [/^\/collections$/, collectionsView, '/collections'],
  [/^\/collections\/(\d+)$/, collectionView, '/collections'],
  [/^\/wipe$/, wipeView, '/wipe'],
  [/^\/purchases$/, purchasesView, '/purchases'],
  [/^\/ebay-sales$/, ebaySalesView, '/ebay-sales'],
  [/^\/sales$/, salesView, '/sales'],
  [/^\/settings$/, settingsView, '/settings'],
];

let current = null;
let navToken = 0;

async function route() {
  const token = ++navToken;
  const hash = location.hash.slice(1) || '/dashboard';
  const qIndex = hash.indexOf('?');
  const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
  const query = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');

  current?.destroy?.();
  current = null;
  setInterceptor(null);

  const view = $('#view');
  const match = ROUTES.find(([re]) => re.test(path));
  if (!match) {
    mount(view, html`<div class="empty">Page not found. <a href="#/dashboard">Go to the dashboard</a></div>`);
    return;
  }
  const [re, handler, navPath] = match;
  $('#nav').querySelectorAll('a').forEach((a) => {
    if (a.getAttribute('href') === '#' + navPath) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  try {
    const isActive = () => token === navToken;
    const instance = await handler({ el: view, args: path.match(re).slice(1), query, isActive });
    if (token !== navToken) { instance?.destroy?.(); return; }
    current = instance || null;
  } catch (err) {
    if (token === navToken) mount(view, errorBox(err));
  }
}

function initTheme() {
  const apply = (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; };
  // Dark is the default look; the button flips to light and remembers the choice.
  apply(store.get('theme', 'dark'));
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    store.set('theme', next);
    apply(next);
  });
}

// Phone layout: the sidebar collapses to a top bar and this button slides the menu in and out.
function initMenu() {
  const sidebar = $('#sidebar');
  const btn = $('#menu-btn');
  const backdrop = $('#nav-backdrop');
  const setOpen = (open) => {
    sidebar.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
  };
  btn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  backdrop.addEventListener('click', () => setOpen(false));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('hashchange', () => setOpen(false));
}

async function boot() {
  initTheme();
  initMenu();
  mount($('#nav'), html`${NAV.map(([title, links]) => html`<div class="nav-section"><div class="nav-section-title">${title}</div>
    ${links.map(([id, label, path]) => html`<a href="#${path}" data-nav="${id}">${icon(id)}<span class="label">${label}</span></a>`)}</div>`)}`);
  try {
    await loadMeta();
  } catch (err) {
    mount($('#view'), errorBox(err));
    return;
  }
  // Two-tone name like the Inventory Control logo: first word plain, the rest in the accent colour
  const [first, ...rest] = (app.meta.company || 'Recycling Inventory').split(' ');
  mount($('#brand-name'), html`${first}${rest.length ? html` <span>${rest.join(' ')}</span>` : ''}`);
  document.title = app.meta.company || 'Recycling Inventory';
  initScanner();
  document.addEventListener(CHANGED, () => current?.refresh?.());
  window.addEventListener('hashchange', route);
  route();
}

boot();
