import PDFDocument from 'pdfkit';

/*
 * Item labels: one label per PDF page, black on white, sized to the label roll (Settings page; 62 x 29 mm by default).
 * Each carries the item's name, model, serial number and MAC address in small print, and a Code 128 barcode of its
 * inventory code. Scanning that barcode opens the item, with the price paid and everything else recorded about it —
 * the price itself is deliberately not printed, since the label stays on the item when it is sold.
 */

/* ---------- Code 128 (subset B: every printable ASCII character) ---------- */

// The 107 symbols: 103 data, 3 start codes (A / B / C) and the stop. '1' = bar module, '0' = space module.
const PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '1100011101011',
];
const START_B = 104;
const STOP = 106;

// Returns the barcode as a string of modules, e.g. "11010010000…", including start, checksum and stop.
export function code128B(text) {
  const s = String(text ?? '');
  if (!s.length) throw new Error('Nothing to encode');
  let sum = START_B;
  let out = PATTERNS[START_B];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code > 126) throw new Error(`The character "${s[i]}" cannot be printed in a barcode`);
    const value = code - 32;
    sum += value * (i + 1);
    out += PATTERNS[value];
  }
  return out + PATTERNS[sum % 103] + PATTERNS[STOP];
}

/* ---------- the label ---------- */

export const DEFAULT_LABEL = { w: 62, h: 29 }; // mm
const QUIET = 10; // blank modules a scanner needs either side of the bars
const pt = (mm) => (mm * 72) / 25.4;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function drawLabel(doc, item, W, H) {
  const bits = code128B(item.barcode);
  const M = Math.max(4, Math.min(W, H) * 0.06);
  const w = W - 2 * M;
  const scale = Math.min(1.6, Math.max(0.75, H / pt(DEFAULT_LABEL.h)));
  const small = 6.5 * scale;
  const codeSize = 9 * scale;

  const lines = [{ text: clean(item.name), font: 'Helvetica-Bold', size: 8 * scale }];
  const model = clean([item.brand, item.model].filter(Boolean).join(' '));
  if (model) lines.push({ text: model, font: 'Helvetica', size: small });
  if (clean(item.serial)) lines.push({ text: `S/N ${clean(item.serial)}`, font: 'Helvetica', size: small });
  if (clean(item.mac)) lines.push({ text: `MAC ${clean(item.mac)}`, font: 'Helvetica', size: small });

  // The bars need a usable height; on a short label the bottom lines of text give way to them
  const textHeight = () => lines.reduce((n, l) => n + l.size * 1.18, 0);
  const minBars = 20 * scale;
  while (lines.length > 1 && textHeight() > H - 2 * M - codeSize * 1.25 - minBars) lines.pop();

  doc.fillColor('#000000');
  let y = M;
  for (const l of lines) {
    doc.font(l.font).fontSize(l.size).text(l.text, M, y, { width: w, height: l.size * 1.2, ellipsis: true });
    y += l.size * 1.18;
  }

  const barsTop = y + 2;
  const barsHeight = Math.max(8, H - M - codeSize * 1.25 - barsTop);
  const mod = Math.min(2, w / (bits.length + 2 * QUIET));
  const bx = (W - bits.length * mod) / 2;
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== '1') { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === '1') j++;
    doc.rect(bx + i * mod, barsTop, (j - i) * mod, barsHeight).fill();
    i = j;
  }
  doc.font('Helvetica-Bold').fontSize(codeSize)
    .text(String(item.barcode), M, barsTop + barsHeight + codeSize * 0.2, { width: w, align: 'center', lineBreak: false });
}

export function writeLabelsPdf(res, items, { widthMm = DEFAULT_LABEL.w, heightMm = DEFAULT_LABEL.h } = {}) {
  for (const it of items) code128B(it.barcode); // throws before anything is written if a barcode can't be printed
  const size = [pt(widthMm), pt(heightMm)];
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, info: { Title: items.length === 1 ? `Label ${items[0].barcode}` : `${items.length} labels` } });
  doc.pipe(res);
  for (const it of items) {
    doc.addPage({ size, margin: 0 });
    drawLabel(doc, it, size[0], size[1]);
  }
  doc.end();
}
