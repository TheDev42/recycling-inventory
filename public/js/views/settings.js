import { api, html, mount, $, toast } from '../util.js';
import { refreshMeta } from '../state.js';

const SITES = [['3', 'eBay UK'], ['0', 'eBay US'], ['205', 'eBay Ireland'], ['77', 'eBay Germany'], ['71', 'eBay France'], ['15', 'eBay Australia']];

export default async function settingsView({ el, query, isActive }) {
  // Back from eBay's sign-in page (only when the RuName points at this site's /ebay/callback)
  const back = query.get('ebay');
  if (back) {
    toast(back === 'connected' ? 'eBay connected' : back, back === 'connected' ? 'ok' : 'error', 7000);
    history.replaceState(null, '', '#/settings');
  }

  async function load() {
    const s = await api.get('/api/settings');
    if (!isActive()) return;
    const e = s.ebay;
    mount(el, html`
      <div class="page-head"><div><h1>Settings</h1></div></div>
      <div class="stack">
        <form id="label-form" class="card" autocomplete="off">
          <h2>Labels</h2>
          <p class="muted">The size of the labels in your printer, in millimetres. In the print dialog choose the label printer, no margins, and 100% scale.</p>
          <div class="inline-form">
            <div class="field"><label for="l-w">Width (mm)</label><input id="l-w" name="label_w" type="number" min="10" max="300" step="0.5" value="${s.label.widthMm}" style="width:110px"></div>
            <div class="field"><label for="l-h">Height (mm)</label><input id="l-h" name="label_h" type="number" min="10" max="300" step="0.5" value="${s.label.heightMm}" style="width:110px"></div>
            <button class="btn" type="submit">Save</button>
          </div>
        </form>

        <section class="card">
          <div class="card-head"><h2>eBay</h2>${e.connected
            ? html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>Connected</span>`
            : html`<span class="badge pat-never"><span class="ico" aria-hidden="true">?</span>Not connected</span>`}</div>
          <p class="muted">Lets this site read what you bought and sold on eBay. It only ever reads — it cannot list, buy or change anything. The steps for getting the three keys are in the README.</p>
          <form id="ebay-form" autocomplete="off">
            <div class="form-grid">
              <div class="field"><label for="e-client">App ID (Client ID)</label><input id="e-client" name="ebay_client_id" type="text" value="${e.clientId}"></div>
              <div class="field"><label for="e-secret">Cert ID (Client Secret)</label>
                <input id="e-secret" name="ebay_client_secret" type="password" autocomplete="new-password" placeholder="${e.hasSecret ? 'saved — leave blank to keep it' : ''}"></div>
              <div class="field"><label for="e-runame">RuName (eBay redirect URL name)</label><input id="e-runame" name="ebay_runame" type="text" value="${e.ruName}"></div>
              <div class="field"><label for="e-site">eBay site</label>
                <select id="e-site" name="ebay_site_id">${SITES.map(([id, label]) => html`<option value="${id}" ${id === e.siteId ? 'selected' : ''}>${label}</option>`)}</select></div>
              <div class="field"><label for="e-env">Keys are for</label>
                <select id="e-env" name="ebay_env"><option value="production" ${e.env === 'production' ? 'selected' : ''}>Production (your real account)</option>
                  <option value="sandbox" ${e.env === 'sandbox' ? 'selected' : ''}>Sandbox (eBay's test site)</option></select></div>
            </div>
            <div class="form-actions"><button class="btn" type="submit">Save keys</button></div>
          </form>

          <h3 style="margin:22px 0 10px">${e.connected ? 'Connect again' : 'Connect your eBay account'}</h3>
          ${e.configured ? html`
            <ol class="steps">
              <li><button class="btn secondary small" data-act="sign-in">Sign in to eBay</button> — it opens in a new tab. Sign in and agree.</li>
              <li>eBay then sends you to your “auth accepted” page. Copy the whole address of that page from the browser's address bar.</li>
              <li>Paste it here within a few minutes:</li>
            </ol>
            <form id="connect-form" class="inline-form" autocomplete="off">
              <div class="field" style="flex:1 1 320px"><label for="e-code">Address of the page eBay sent you to</label><input id="e-code" name="code" type="text" required placeholder="https://…?code=…"></div>
              <button class="btn" type="submit">Finish connecting</button>
            </form>`
            : html`<p class="muted">Save the App ID, Cert ID and RuName first.</p>`}
          ${e.connected ? html`<p style="margin:16px 0 0"><button class="btn danger small" data-act="disconnect">Disconnect eBay</button></p>` : ''}
        </section>

        <section class="card">
          <h2>Backup</h2>
          <p class="muted">Everything — stock, wipe log, sales and your eBay keys — lives in one database file. Download a copy regularly and keep it private.</p>
          <a class="btn secondary" href="/api/backup">Download backup</a>
        </section>
      </div>`);
  }

  const save = async (body, okMsg) => {
    try { await api.put('/api/settings', body); toast(okMsg, 'ok'); await refreshMeta(); load(); } catch (err) { toast(err.message, 'error', 6000); }
  };

  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    if (f.id === 'label-form') save(body, 'Label size saved');
    else if (f.id === 'ebay-form') save(body, 'eBay keys saved');
    else if (f.id === 'connect-form') {
      try {
        await api.post('/api/ebay/connect', body);
        toast('eBay connected', 'ok');
        await refreshMeta();
        load();
      } catch (err) { toast(err.message, 'error', 8000); }
    }
  };

  el.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sign-in') {
      // opened straight from the click (browsers block tabs opened later), then pointed at eBay's sign-in page
      const tab = window.open('', '_blank');
      try {
        const { url } = await api.get('/api/ebay/consent-url');
        if (tab) tab.location = url; else location.href = url;
        $('#e-code', el)?.focus();
      } catch (err) { tab?.close(); toast(err.message, 'error', 6000); }
    }
    if (act === 'disconnect' && confirm('Disconnect eBay? What has already been fetched stays; you just cannot fetch more until you connect again.')) {
      try { await api.post('/api/ebay/disconnect'); toast('eBay disconnected', 'ok'); await refreshMeta(); load(); } catch (err) { toast(err.message, 'error', 6000); }
    }
  };

  await load();
  return { destroy() { el.onsubmit = null; el.onclick = null; } };
}
