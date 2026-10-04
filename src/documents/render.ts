/**
 * Shared Prestige PDF rendering infrastructure — the mechanics every
 * document renderer (invoice / receipt / statement) builds on: the PDF
 * lifecycle wrapper, branding image loading, and the common visual blocks
 * (header, party+meta, signature, footer, amount bar). Document-specific
 * builders own only their truly specific composition.
 */
import { AppError, ErrorCode } from '../errors/registry.js';
import type { InvoiceParty, InvoiceStore } from './types.js';
import {
  PRESTIGE_COLORS as C,
  PRESTIGE_LAYOUT as L,
  PRESTIGE_ICONS,
} from './theme.js';

// PDFKit namespace is globally declared by @types/pdfkit.
type PDFDocument = PDFKit.PDFDocument;

// ── Branding images ────────────────────────────────────────────────────────

const isJpeg = (b: Buffer): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Fetch a logo/signature image URL and return a Buffer PDFKit can embed
 * (JPEG or PNG only). Returns null on any failure so the renderer falls
 * back to the imageless Prestige variant (initials box / signature line).
 */
async function fetchImageData(url: string | undefined | null): Promise<Buffer | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isJpeg(buf) && !isPng(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

export interface Branding {
  logo: Buffer | null;
  signature: Buffer | null;
}

/** Load the store's logo + signature images (null on any failure). */
export async function loadBranding(store: InvoiceStore | null): Promise<Branding> {
  const [logo, signature] = await Promise.all([
    fetchImageData(store?.logo_url),
    fetchImageData(store?.signature_url),
  ]);
  return { logo, signature };
}

// ── Shared drawing primitives ──────────────────────────────────────────────

/** Gold contact icon: 24-unit viewBox path scaled to 10pt, stroked. */
export function drawIcon(doc: PDFKit.PDFDocument, path: string, x: number, y: number): void {
  const s = 10 / 24;
  doc.save();
  doc.translate(x, y);
  doc.scale(s, s);
  doc.lineWidth(2);
  doc.strokeColor(C.gold);
  doc.path(path);
  doc.stroke();
  doc.restore();
}

/** Number-to-words (en-IN: lakh/crore) for amount-in-words lines. */
export function numberToWords(num: number): string {
  if (num === 0) return 'Zero Rupees Only';
  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const inWords = (n: number): string => {
    let str = '';
    if (n > 99) {
      str += a[Math.floor(n / 100)] + 'Hundred ';
      n = n % 100;
    }
    if (n > 19) {
      str += b[Math.floor(n / 10)] + ' ';
      n = n % 10;
    }
    str += a[n];
    return str;
  };

  let result = '';
  if (num > 9999999) {
    result += inWords(Math.floor(num / 10000000)) + 'Crore ';
    num %= 10000000;
  }
  if (num > 99999) {
    result += inWords(Math.floor(num / 100000)) + 'Lakh ';
    num %= 100000;
  }
  if (num > 999) {
    result += inWords(Math.floor(num / 1000)) + 'Thousand ';
    num %= 1000;
  }
  result += inWords(num);
  return result.trim() + ' Rupees Only';
}

/** Format a YYYY-MM-DD date as the payment documents' display form (04 Oct 2026). */
export function fmtStatementDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── The shared Prestige header (identical on every document) ───────────────

export function drawPrestigeHeader(doc: PDFDocument, store: InvoiceStore | null, branding: Branding): void {
  const pageW = L.pageW;
  const marginX = L.marginX;
  const storeName = store?.name || 'FUSION GADGETS';

  doc.rect(0, 0, pageW, L.goldBarH).fill(C.gold);

  // Left: logo box (image or initials) + store name + GSTIN
  doc.rect(marginX, L.headerStartY, 36, 36).lineWidth(1.1).stroke(C.black);
  if (branding.logo) {
    doc.image(branding.logo, marginX, L.headerStartY, { fit: [36, 36], align: 'center' });
  } else {
    doc.font('Helvetica-Bold').fontSize(15).fillColor(C.black);
    const initials = storeName.substring(0, 2).toUpperCase();
    const initH = doc.heightOfString(initials);
    doc.text(initials, marginX, L.headerStartY + (36 - initH) / 2, {
      width: 36, align: 'center',
    });
  }

  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.black);
  doc.text(storeName, marginX + 46, L.headerStartY + 8);
  if (store?.gstin) {
    doc.font('Helvetica').fontSize(6.75).fillColor(C.textSecondary);
    doc.text(`GSTIN: ${store.gstin}`, marginX + 46, L.headerStartY + 26);
  }

  // Right: contact lines with gold icons (right-aligned column; icons hug
  // their text — each line is a flex row [icon(10) + 4 margin + text]).
  const rightX = L.contentRight;
  let contactY = L.headerStartY + 2.5;
  const contactLine = (text: string, icon: string, wrapWidth: number): void => {
    doc.font('Helvetica').fontSize(6.75).fillColor(C.textSecondary);
    const h = doc.heightOfString(text, { width: wrapWidth });
    const textW = doc.widthOfString(text);
    drawIcon(doc, icon, rightX - Math.min(textW, wrapWidth) - 14, contactY - 1);
    doc.text(text, rightX - wrapWidth, contactY, { width: wrapWidth, align: 'right' });
    contactY += h + 6.6;
  };
  if (store?.phone) contactLine(store.phone, PRESTIGE_ICONS.phone, 110);
  if (store?.email) contactLine(store.email, PRESTIGE_ICONS.email, 110);
  if (store?.address) {
    // The address renders as ONE unwrapped right-aligned line.
    contactLine(store.address.split('\n').join(', '), PRESTIGE_ICONS.mapPin, 240);
  }

  // Header bottom border (1.5 black — spans the FULL page width).
  doc.moveTo(0, L.headerBorderY).lineTo(pageW, L.headerBorderY)
    .lineWidth(1.5).stroke(C.black);
}

// ── The shared party + document-meta block ─────────────────────────────────

export interface MetaRow {
  label: string;
  value: string;
}

/**
 * The two-column billing composition every document shares: party block on
 * the left (gold label, name, address, contact), vertical divider, and the
 * document meta column on the right (big title + label/value rows).
 */
export function drawPartyMetaBlock(
  doc: PDFDocument,
  opts: {
    party: InvoiceParty | null;
    partyNameFallback: string;
    label: string;
    title: string;
    titleSize: number;
    metaRows: MetaRow[];
  },
): void {
  const pageW = L.pageW;
  const marginX = L.marginX;
  const labelY = L.billingLabelY;
  const partyName = opts.party?.name || opts.partyNameFallback;

  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.gold);
  doc.text(opts.label, marginX, labelY, { characterSpacing: 0.9 });

  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.textPrimary);
  doc.text(partyName, marginX, labelY + 17);

  let cursorY = labelY + 37;
  if (opts.party?.address) {
    doc.font('Helvetica').fontSize(7.1).fillColor(C.textSecondary);
    doc.text(opts.party.address.split('\n').join(', '), marginX, cursorY, { width: 254 });
    cursorY += 17.5;
  }
  if (opts.party?.number) {
    doc.font('Helvetica-Bold').fontSize(7.1).fillColor(C.textPrimary);
    doc.text('Contact No.', marginX, cursorY);
    doc.font('Helvetica').fillColor(C.textSecondary);
    doc.text(opts.party.number, marginX + 54, cursorY);
  }

  doc.moveTo(pageW / 2, labelY).lineTo(pageW / 2, L.billingBorderY - 24)
    .lineWidth(0.75).stroke(C.border);

  const metaX = pageW / 2 + 12;
  doc.font('Helvetica-Bold').fontSize(opts.titleSize).fillColor(C.black);
  doc.text(opts.title, metaX, labelY - 5);

  // Meta rows sit at fixed offsets (labelY + 22 / +32 / +42).
  opts.metaRows.forEach((row, i) => {
    const y = labelY + 22 + i * 10;
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.textPrimary);
    doc.text(row.label, metaX, y, { characterSpacing: 0.375 });
    doc.font('Helvetica').fontSize(7.1).fillColor(C.textSecondary);
    doc.text(row.value, metaX + 67.5, y);
  });

  doc.moveTo(0, L.billingBorderY).lineTo(pageW, L.billingBorderY)
    .lineWidth(0.75).stroke(C.border);
}

// ── The shared amount bar (black bar, gold value — the Prestige total) ─────

/**
 * The emphasized total bar. Vertical centering: PDFKit anchors the first
 * line's baseline at y + ascender·size/1000 and, for the standard Helvetica
 * faces, the ascender (718/1000 em) equals the cap height — the visible box
 * of these all-caps/digit strings therefore spans [y, y + 0.718·size].
 * Anchoring that box on the bar's midline keeps the top/bottom gaps
 * balanced for both font sizes and every amount width.
 */
export function drawAmountBar(
  doc: PDFDocument,
  opts: { x: number; w: number; top: number; label: string; value: string; valueInset: number },
): void {
  const barMidY = opts.top + L.gtBlockH / 2;
  doc.rect(opts.x, opts.top, opts.w, L.gtBlockH).fill(C.black);
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.white);
  doc.text(opts.label, opts.x + 12, barMidY - (718 / 2000) * 8.25, { characterSpacing: 0.75 });
  doc.font('Helvetica-Bold').fontSize(11.25).fillColor(C.gold);
  doc.text(opts.value, opts.x, barMidY - (718 / 2000) * 11.25, {
    width: opts.w - opts.valueInset, align: 'right', characterSpacing: 0.375,
  });
}

// ── The shared signature block (flush right) ────────────────────────────────

/** Draws the "For <store>" + signature image/line + name block at `y`.
 *  Returns the y of the block's bottom edge. */
export function drawPrestigeSignature(
  doc: PDFDocument,
  store: InvoiceStore | null,
  branding: Branding,
  y: number,
): number {
  const storeNameSig = store?.name || 'Fusion Gadgets';
  const sigX = L.contentRight - L.sigBlockW;
  doc.font('Helvetica-Oblique').fontSize(6.75).fillColor(C.textSecondary);
  doc.text(`For ${storeNameSig}`, sigX, y);
  let sigCursorY = y + 31.5;
  if (branding.signature) {
    // The signature image occupies the SAME centered column as the line and
    // the texts below it: the 75×30 fit box (aspect preserved for any asset
    // dimensions) is centered over the block.
    doc.image(branding.signature, sigX + (L.sigBlockW - 75) / 2, sigCursorY, {
      fit: [75, 30], align: 'center', valign: 'center',
    });
    sigCursorY += 33.75;
  } else {
    sigCursorY += 8;
  }
  doc.moveTo(sigX, sigCursorY).lineTo(sigX + L.sigBlockW, sigCursorY).lineWidth(0.75).stroke(C.black);
  doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.black);
  doc.text(storeNameSig.toUpperCase(), sigX, sigCursorY + 5.25, { width: L.sigBlockW, align: 'center', characterSpacing: 0.6 });
  doc.font('Helvetica').fontSize(6).fillColor(C.textSecondary);
  doc.text('Authorized Signatory', sigX, sigCursorY + 16.5, { width: L.sigBlockW, align: 'center' });
  return sigCursorY + 16.5;
}

// ── The shared footer band (buffered pages, page numbering) ────────────────

/** Draws the black footer band on EVERY buffered page. `wording` is the
 *  document noun used in the computer-generated line. */
export function drawPrestigeFooter(doc: PDFDocument, store: InvoiceStore | null, wording: string): void {
  const pageW = L.pageW;
  const marginX = L.marginX;
  const storeNameSig = (store?.name || 'Fusion Gadgets').toUpperCase();
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.rect(0, L.footerBarY, pageW, L.footerH).fill(C.black);
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.gold);
    doc.text(storeNameSig, marginX, L.footerBarY + 8.5, { characterSpacing: 0.75 });
    doc.font('Helvetica').fontSize(6).fillColor('#6B7280');
    doc.text(
      `This is a computer-generated ${wording}. No signature required if digitally authenticated.`,
      marginX + 130, L.footerBarY + 9.5, { width: 300, align: 'right' },
    );
    doc.font('Helvetica').fontSize(6.75).fillColor(C.white);
    doc.text(`Page ${i + 1} of ${pages.count}`, marginX, L.footerBarY + 9.5, {
      width: pageW - marginX * 2, align: 'right',
    });
  }
}

// ── The shared PDF lifecycle wrapper ───────────────────────────────────────

/** Create an A4 PDFDocument, run the renderer, and collect the Buffer.
 *  Validates the output starts with %PDF-. */
export async function generatePdf(render: (doc: PDFDocument) => Promise<void>): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    bufferPages: true,
    autoFirstPage: true,
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  try {
    await render(doc);
    doc.end();
    const buffer = await done;

    if (!buffer || buffer.length === 0 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new AppError(ErrorCode.INVOICE_PDF_GENERATION_FAILED, {
        internalDetails: { reason: 'empty or non-PDF output', bytes: buffer?.length ?? 0 },
      });
    }
    return buffer;
  } catch (err) {
    // Ensure the document is terminated so the promise settles even on failure.
    try { doc.end(); } catch { /* already ended */ }
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCode.INVOICE_PDF_GENERATION_FAILED, {
      cause: err,
      internalDetails: { errorType: err instanceof Error ? err.constructor.name : 'unknown' },
    });
  }
}
