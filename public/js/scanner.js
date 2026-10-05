import { api, html, mount, $, fmtDateTime, notifyChanged } from './util.js';
import { play, isMuted, setMuted, unlockAudio } from './audio.js';

/*
 * Scanner: a USB/Bluetooth barcode scanner acts like a keyboard - it "types" the code very fast and presses Enter.
 * We listen for that on the whole document, so nothing has to be focused. Keystrokes are ignored while you are
 * typing in a form field, so normal data entry still works (and you can scan a serial number straight into a box).
 */

// A page can take over scans while it is open (the item form fills its serial box, the eBay match picker searches)
let interceptor = null;
export const setInterceptor = (fn) => { interceptor = fn; };

const el = {};
let last = null;

const LEVEL = { lookup: 'ok', warn: 'warn', error: 'err', unknown: 'err' };
const GLYPH = { ok: '✓', warn: '⚠', err: '✕' };

function renderResult() {
  if (!last) {
    mount(el.result, html`<span class="res-idle">Ready — scanner input is live on every page.</span>`);
    el.result.className = 'sb-result';
    return;
  }
  const level = LEVEL[last.tone] || 'ok';
  el.result.className = `sb-result res-${level}`;
  const link = last.item ? html` <a href="#/items/${last.item.id}">open</a>` : '';
  const create = last.unknown ? html` <a class="btn small" href="#/items/new?serial=${encodeURIComponent(last.barcode)}">Add an item with this serial number</a>` : '';
  mount(el.result, html`<span class="res-ico" aria-hidden="true">${GLYPH[level]}</span><span class="res-msg">${last.message}</span>${link}${create}<span class="res-time">${fmtDateTime(last.at)}</span>`);
}

const renderSound = () => { el.soundBtn.textContent = isMuted() ? 'Muted' : 'Sound'; };

/* ---------- scanning ---------- */
let chain = Promise.resolve();
export function submitScan(barcode) {
  const code = String(barcode).trim();
  if (!code) return;
  chain = chain.then(() => doScan(code)).catch((err) => console.error(err));
}

async function doScan(barcode) {
  if (interceptor && (await interceptor(barcode))) return;
  let res;
  try {
    res = await api.post('/api/scan', { barcode });
  } catch (err) {
    res = { ok: false, tone: 'error', message: err.message, barcode };
  }
  res.at = new Date().toISOString();
  last = res;
  play(res.tone);
  renderResult();
  if (res.navigate) {
    // Already on that page? Just refresh it; otherwise go there.
    if (location.hash === '#' + res.navigate) notifyChanged();
    else location.hash = '#' + res.navigate;
  }
}

/* ---------- global keyboard capture ---------- */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image']);
const isTextEntry = (t) =>
  !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(t.type)));

const GAP_MS = 350; // longest pause between keystrokes still counted as the same scan
let buffer = '';
let lastKey = 0;

function onKeyDown(e) {
  unlockAudio();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t === el.input) return; // the scan box handles itself
  if (isTextEntry(t)) { buffer = ''; return; }

  const now = performance.now();
  if (now - lastKey > GAP_MS) buffer = '';
  lastKey = now;

  if (e.key === 'Enter' || (e.key === 'Tab' && buffer.length >= 2)) {
    if (buffer.length >= 2) {
      e.preventDefault();
      const code = buffer;
      buffer = '';
      submitScan(code);
    } else buffer = '';
    return;
  }
  if (e.key.length === 1) {
    if (e.key === ' ' && !buffer && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; // let Space press a focused button
    buffer += e.key;
    e.preventDefault(); // stops select-box type-ahead, page scroll, etc. while a scan is arriving
  }
}

/* ---------- init ---------- */
export function initScanner() {
  el.input = $('#sb-input');
  el.result = $('#sb-result');
  el.soundBtn = $('#sb-sound-btn');

  renderResult();
  renderSound();

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  $('#sb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitScan(el.input.value);
    el.input.value = '';
  });
  el.soundBtn.addEventListener('click', () => {
    setMuted(!isMuted());
    renderSound();
    if (!isMuted()) play('lookup');
  });
}
