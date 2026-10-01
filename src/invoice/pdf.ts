/**
 * Invoice PDF renderer — PDFKit implementation (backend).
 *
 * TECHNICAL source of truth: the supplied PDFKit template
 * (`pdf-template-ref/invoice-pdf-template.ts`) — pure imperative drawing,
 * explicit coordinates, a single `currentY` cursor, `checkPageBreak`,
 * explicit `doc.addPage()`, repeated table headers after page breaks,
 * totals-block page reservation, buffered page footers, page numbering.
 *
 * VISUAL source of truth: the existing Prestige invoice design
 * (`frontend/domains/invoice/templates/Prestige.tsx`). All geometry below
 * was calibrated against rasterized output of that production template
 * (see pdf-template-ref/golden/). Notable Prestige behaviors reproduced:
 *   - gold top accent bar, 36×36 bordered logo box (logo image or initials)
 *   - gold contact icons in the header
 *   - 'RECEIVED FROM' label for purchases, 'BILL TO' otherwise
 *   - ' • ' item sub-line separator
 *   - discount cell '– amount' / '—' (en/em dash — U+2212 is not encodable
 *     in WinAnsi Helvetica; the en dash is the closest renderable minus)
 *   - trade-in rows: IMEI-only sub-line, qty rendered only when set,
 *     amount = (qty||1) × (rate || credit_value)
 *   - 'Product Discount' totals row only when BOTH additional and item
 *     discounts exist
 *   - totals box flush to the right margin
 *   - signature block flush right, optional signature image
 *
 * Do NOT reintroduce React-PDF here. Do not add a layout framework.
 */
/** PDFKit's module type is its PDFDocument instance type (@types/pdfkit exports `var doc`). */
// PDFKit namespace is globally declared by @types/pdfkit.
type PDFDocument = PDFKit.PDFDocument;
import type { InvoiceData, InvoiceLineItem, InvoiceTradeIn } from './types.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import {
  PRESTIGE_COLORS as C,
  PRESTIGE_LAYOUT as L,
  PRESTIGE_TABLE_HEADERS,
  PRESTIGE_TRADE_IN_HEADERS,
  PRESTIGE_ICONS,
  fmt,
  descriptionText,
  subLineText,
  amountText,
  invoiceTitle,
  billingLabel,
} from './prestige.js';

// ── Number-to-words (summary section only — not used by the thumbnail) ────────

function numberToWords(num: number): string {
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

interface Branding {
  logo: Buffer | null;
  signature: Buffer | null;
}

// ── Prestige header icons (SVG paths, 24-unit viewBox scaled to 10pt) ─────
// Path data lives in prestige.ts (shared with the thumbnail worker).

function drawIcon(doc: PDFKit.PDFDocument, path: string, x: number, y: number): void {
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

// ── Item text helpers live in prestige.ts (shared with the thumbnail) ────

// ── The renderer ───────────────────────────────────────────────────────────

export async function buildInvoice(doc: PDFDocument, data: InvoiceData): Promise<void> {
  // Branding first (Prestige embeds logo + signature when available).
  const [logo, signature] = await Promise.all([
    fetchImageData(data.store?.logo_url),
    fetchImageData(data.store?.signature_url),
  ]);
  const branding: Branding = { logo, signature };

  let currentY = 0;
  const pageW = L.pageW;
  const pageH = L.pageH;
  const marginX = L.marginX;

  const storeName = data.store?.name || 'FUSION GADGETS';
  const storeNameSig = data.store?.name || 'Fusion Gadgets';
  const partyName = data.party?.name || 'Cash Customer';

  // ── Header ──────────────────────────────────────────────────────────────
  const drawHeader = (): void => {
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
    if (data.store?.gstin) {
      doc.font('Helvetica').fontSize(6.75).fillColor(C.textSecondary);
      doc.text(`GSTIN: ${data.store.gstin}`, marginX + 46, L.headerStartY + 26);
    }

    // Right: contact lines with gold icons (right-aligned column).
    // Prestige renders each line as a flex row [icon(10) + 4 margin + text]
    // right-aligned at the content margin — icons hug their text.
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
    if (data.store?.phone) contactLine(data.store.phone, PRESTIGE_ICONS.phone, 110);
    if (data.store?.email) contactLine(data.store.email, PRESTIGE_ICONS.email, 110);
    if (data.store?.address) {
      // Prestige renders the address as ONE unwrapped right-aligned line.
      contactLine(data.store.address.split('\n').join(', '), PRESTIGE_ICONS.mapPin, 240);
    }

    // Header bottom border (1.5 black — spans the FULL page width, like Prestige)
    doc.moveTo(0, L.headerBorderY).lineTo(pageW, L.headerBorderY)
      .lineWidth(1.5).stroke(C.black);
  };

  // ── Billing + invoice meta ──────────────────────────────────────────────
  const drawBilling = (): void => {
    const labelY = L.billingLabelY;

    doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.gold);
    doc.text(billingLabel(data.type), marginX, labelY, { characterSpacing: 0.9 });

    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.textPrimary);
    doc.text(partyName, marginX, labelY + 17);

    let cursorY = labelY + 37;
    if (data.party?.address) {
      doc.font('Helvetica').fontSize(7.1).fillColor(C.textSecondary);
      doc.text(data.party.address.split('\n').join(', '), marginX, cursorY, { width: 254 });
      cursorY += 17.5;
    }
    if (data.party?.number) {
      doc.font('Helvetica-Bold').fontSize(7.1).fillColor(C.textPrimary);
      doc.text('Contact No.', marginX, cursorY);
      doc.font('Helvetica').fillColor(C.textSecondary);
      doc.text(data.party.number, marginX + 54, cursorY);
    }

    // Vertical divider between billing and meta columns
    doc.moveTo(pageW / 2, labelY).lineTo(pageW / 2, L.billingBorderY - 24)
      .lineWidth(0.75).stroke(C.border);

    // Meta column: title, invoice no., date
    const metaX = pageW / 2 + 12;
    doc.font('Helvetica-Bold').fontSize(21).fillColor(C.black);
    doc.text(invoiceTitle(data.type), metaX, labelY - 5);

    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.textPrimary);
    doc.text('INVOICE NO.', metaX, labelY + 22, { characterSpacing: 0.375 });
    doc.font('Helvetica').fontSize(7.1).fillColor(C.textSecondary);
    doc.text(data.bill_number, metaX + 67.5, labelY + 22);

    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.textPrimary);
    doc.text('DATE', metaX, labelY + 32, { characterSpacing: 0.375 });
    doc.font('Helvetica').fontSize(7.1).fillColor(C.textSecondary);
    doc.text(data.date, metaX + 67.5, labelY + 32);

    // Billing bottom border (spans the FULL page width, like Prestige)
    doc.moveTo(0, L.billingBorderY).lineTo(pageW, L.billingBorderY)
      .lineWidth(0.75).stroke(C.border);
  };

  // ── Pagination ──────────────────────────────────────────────────────────
  const checkPageBreak = (neededHeight: number): boolean => {
    if (currentY + neededHeight > pageH - L.bottomMargin) {
      const remainingSpace = pageH - L.bottomMargin - currentY;
      if (remainingSpace > 20) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(C.textLight);
        doc.text('Continued on next page...', marginX, currentY + 15, {
          width: pageW - marginX * 2, align: 'center',
        });
      }
      doc.addPage();
      currentY = marginX;
      return true;
    }
    return false;
  };

  // ── Items table ─────────────────────────────────────────────────────────
  const drawTableHeader = (): void => {
    checkPageBreak(30);
    doc.rect(marginX, currentY, pageW - marginX * 2, L.tableHeaderH).fill(C.black);
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.white);
    doc.text(PRESTIGE_TABLE_HEADERS.idx, L.col.idx.x, currentY + 7.5, { width: L.col.idx.w, align: L.col.idx.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TABLE_HEADERS.desc, L.col.desc.x, currentY + 7.5, { width: L.col.desc.w, align: L.col.desc.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TABLE_HEADERS.qty, L.col.qty.x, currentY + 7.5, { width: L.col.qty.w, align: L.col.qty.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TABLE_HEADERS.rate, L.col.rate.x, currentY + 7.5, { width: L.col.rate.w, align: L.col.rate.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TABLE_HEADERS.discount, L.col.discount.x, currentY + 7.5, { width: L.col.discount.w, align: L.col.discount.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TABLE_HEADERS.amount, L.col.amount.x, currentY + 7.5, { width: L.col.amount.w, align: L.col.amount.align, characterSpacing: 0.6 });
    currentY += L.tableHeaderH;
  };

  const drawRow = (item: InvoiceLineItem | InvoiceTradeIn, idx: number, isLast: boolean, isTradeIn = false): void => {
    const descText = descriptionText(item);
    const subText = subLineText(item, isTradeIn);
    const txtColor = isTradeIn ? C.tradeInText : C.textPrimary;

    doc.font('Helvetica-Bold').fontSize(7.1);
    const descHeight = doc.heightOfString(descText, { width: L.col.desc.w });
    const subHeight = subText
      ? doc.font('Helvetica').fontSize(6.375).heightOfString(subText, { width: L.col.desc.w })
      : 0;
    const rowHeight = Math.max(30, descHeight + subHeight + (subText ? 2.25 : 0) + L.rowPadV * 2 + L.rowFudge);

    if (checkPageBreak(rowHeight)) {
      drawTableHeader();
    }

    if (isTradeIn) {
      doc.rect(marginX, currentY, pageW - marginX * 2, rowHeight).fill(C.tradeInBg);
    }

    const yOffset = currentY + L.rowPadV;

    doc.font('Helvetica').fontSize(7.1).fillColor(txtColor);
    doc.text(String(idx + 1), L.col.idx.x, yOffset, { width: L.col.idx.w, align: L.col.idx.align });

    doc.font('Helvetica-Bold').fillColor(txtColor);
    doc.text(descText, L.col.desc.x, yOffset, { width: L.col.desc.w, align: L.col.desc.align });
    if (subText) {
      doc.font('Helvetica').fontSize(6.375).fillColor(isTradeIn ? C.tradeInSub : C.textSecondary);
      doc.text(subText, L.col.desc.x, yOffset + descHeight + 2.25, { width: L.col.desc.w, align: L.col.desc.align });
    }

    doc.font('Helvetica').fontSize(7.1).fillColor(txtColor);
    // Trade-in qty renders only when set (Prestige: item.qty ? item.qty : '')
    doc.text(isTradeIn && !item.qty ? '' : String(item.qty || 1), L.col.qty.x, yOffset, {
      width: L.col.qty.w, align: L.col.qty.align,
    });

    if (!isTradeIn) {
      const line = item as InvoiceLineItem;
      doc.text(fmt(line.rate || line.price || 0), L.col.rate.x, yOffset, { width: L.col.rate.w, align: L.col.rate.align });
      doc.text(
        Number(line.discount) > 0 ? `\u2013 ${fmt(line.discount || 0)}` : '\u2014',
        L.col.discount.x, yOffset, { width: L.col.discount.w, align: L.col.discount.align },
      );
    }
    doc.text(amountText(item, isTradeIn), L.col.amount.x, yOffset, { width: L.col.amount.w, align: L.col.amount.align });

    currentY += rowHeight;
    if (!isLast) {
      doc.moveTo(marginX, currentY).lineTo(L.contentRight, currentY)
        .lineWidth(0.75).stroke(isTradeIn ? C.tradeInBorder : C.border);
    }
  };

  // ── Page 1: header + billing ────────────────────────────────────────────
  drawHeader();
  drawBilling();

  // ── Items ───────────────────────────────────────────────────────────────
  currentY = L.itemsLabelY;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textSecondary);
  doc.text('ITEMS PURCHASED', marginX, currentY, { characterSpacing: 0.9 });
  currentY = L.tableHeaderY;

  drawTableHeader();
  data.items.forEach((item, idx) => drawRow(item, idx, idx === data.items.length - 1));

  // ── Trade-ins ───────────────────────────────────────────────────────────
  if (data.trade_ins && data.trade_ins.length > 0) {
    currentY += 12;
    checkPageBreak(40);
    doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.tradeInText);
    doc.text('TRADE-IN', marginX, currentY, { characterSpacing: 0.9 });
    currentY += 18;

    doc.rect(marginX, currentY, pageW - marginX * 2, L.tableHeaderH).fill(C.tradeInBg);
    doc.moveTo(marginX, currentY).lineTo(L.contentRight, currentY).lineWidth(1.125).stroke(C.tradeInText);
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.tradeInText);
    doc.text(PRESTIGE_TRADE_IN_HEADERS.idx, L.col.idx.x, currentY + 7.5, { width: L.col.idx.w, align: L.col.idx.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TRADE_IN_HEADERS.desc, L.col.desc.x, currentY + 7.5, { width: L.col.desc.w, align: L.col.desc.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TRADE_IN_HEADERS.qty, L.col.qty.x, currentY + 7.5, { width: L.col.qty.w, align: L.col.qty.align, characterSpacing: 0.6 });
    doc.text(PRESTIGE_TRADE_IN_HEADERS.amount, L.col.amount.x, currentY + 7.5, { width: L.col.amount.w, align: L.col.amount.align, characterSpacing: 0.6 });
    currentY += L.tableHeaderH;

    data.trade_ins.forEach((item, idx) =>
      drawRow(item, idx, idx === data.trade_ins!.length - 1, true),
    );
  }

  // ── Summary (notes left, totals right) ──────────────────────────────────
  // Reserve space so the totals block + signature are never cut off.
  checkPageBreak(250);

  currentY += 15;
  const summaryTopY = currentY;
  doc.moveTo(0, summaryTopY).lineTo(pageW, summaryTopY).lineWidth(0.75).stroke(C.border);
  currentY = summaryTopY + L.summaryPadTop;

  // Left column — amount in words + terms
  const notesW = 240;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textLight);
  doc.text('AMOUNT IN WORDS', marginX, currentY, { characterSpacing: 0.9 });
  doc.font('Helvetica-Oblique').fontSize(7.1).fillColor(C.textPrimary);
  const wordsText = numberToWords(Math.round(data.final_total));
  doc.text(wordsText, marginX, currentY + 14, { width: notesW });
  const wordsH = doc.heightOfString(wordsText, { width: notesW });

  let termsY = currentY + 14 + wordsH + 15;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textLight);
  doc.text('TERMS & CONDITIONS', marginX, termsY, { characterSpacing: 0.9 });
  termsY += 12;
  doc.font('Helvetica').fontSize(6.375).fillColor(C.textSecondary);
  doc.text('1. Goods once sold will not be taken back or exchanged.', marginX, termsY);
  doc.text('2. Warranty as per manufacturer terms.', marginX, termsY + 10.8);
  doc.text('3. Thank you for doing business with us.', marginX, termsY + 21.6);

  // Right column — totals box (flush to the right margin)
  const rightCol = L.totalsX;
  const totalsW = L.totalsW;
  let totY = currentY + 4.5;

  const addTotal = (label: string, val: string, bold = false): void => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.1)
      .fillColor(bold ? C.textPrimary : C.textSecondary);
    doc.text(label, rightCol, totY);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(C.textPrimary);
    doc.text(val, rightCol, totY, { width: totalsW, align: 'right' });
    totY += L.totalsRowH;
  };

  // Prestige: 'Product Discount' only when BOTH additional and item discounts exist
  const itemDiscount = Number(data.item_discount) || 0;
  const additionalDiscount = Number(data.additional_discount) || 0;

  addTotal('Subtotal', fmt(data.subtotal));
  if (additionalDiscount > 0 && itemDiscount > 0) addTotal('Product Discount', `\u2013 ${fmt(itemDiscount)}`);
  if (additionalDiscount > 0) addTotal('Additional Discount', `\u2013 ${fmt(additionalDiscount)}`);
  if (Number(data.discount) > 0) addTotal('Total Discount', `\u2013 ${fmt(Number(data.discount))}`, true);
  if (Number(data.trade_in_credit) > 0) addTotal('Trade-In Deduction', `\u2013 ${fmt(Number(data.trade_in_credit))}`);

  // Grand total (black bar, gold value)
  totY += 4.5;
  doc.rect(rightCol, totY, totalsW, L.gtBlockH).fill(C.black);
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.white);
  doc.text('GRAND TOTAL', rightCol + 12, totY + 10.5, { characterSpacing: 0.75 });
  doc.font('Helvetica-Bold').fontSize(11.25).fillColor(C.gold);
  doc.text(fmt(data.final_total), rightCol, totY + 8.5, { width: totalsW - 12, align: 'right', characterSpacing: 0.375 });
  totY += L.gtBlockH;

  if (data.type !== 'proforma') {
    totY += 6;
    doc.moveTo(rightCol, totY).lineTo(rightCol + totalsW, totY).lineWidth(0.75).stroke(C.border);
    totY += 6;
    addTotal('Amount Received', fmt(data.paid));
    addTotal('Balance Due', fmt(data.due), true);
  }

  // ── Signature ───────────────────────────────────────────────────────────
  currentY = Math.max(currentY + 110, totY + 20);
  checkPageBreak(60);

  const sigX = L.contentRight - L.sigBlockW;
  doc.font('Helvetica-Oblique').fontSize(6.75).fillColor(C.textSecondary);
  doc.text(`For ${storeNameSig}`, sigX, currentY);
  let sigCursorY = currentY + 31.5;
  if (branding.signature) {
    doc.image(branding.signature, sigX, sigCursorY, { fit: [75, 30], align: 'center' });
    sigCursorY += 33.75;
  } else {
    sigCursorY += 8;
  }
  doc.moveTo(sigX, sigCursorY).lineTo(sigX + L.sigBlockW, sigCursorY).lineWidth(0.75).stroke(C.black);
  doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.black);
  doc.text(storeNameSig.toUpperCase(), sigX, sigCursorY + 5.25, { width: L.sigBlockW, align: 'center', characterSpacing: 0.6 });
  doc.font('Helvetica').fontSize(6).fillColor(C.textSecondary);
  doc.text('Authorized Signatory', sigX, sigCursorY + 16.5, { width: L.sigBlockW, align: 'center' });

  // ── Footer on ALL buffered pages ────────────────────────────────────────
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.rect(0, L.footerBarY, pageW, L.footerH).fill(C.black);
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.gold);
    doc.text(storeNameSig.toUpperCase(), marginX, L.footerBarY + 8.5, { characterSpacing: 0.75 });
    doc.font('Helvetica').fontSize(6).fillColor('#6B7280');
    doc.text(
      'This is a computer-generated invoice. No signature required if digitally authenticated.',
      marginX + 130, L.footerBarY + 9.5, { width: 300, align: 'right' },
    );
    doc.font('Helvetica').fontSize(6.75).fillColor(C.white);
    doc.text(`Page ${i + 1} of ${pages.count}`, marginX, L.footerBarY + 9.5, {
      width: pageW - marginX * 2, align: 'right',
    });
  }
}

/**
 * Generate a complete invoice PDF buffer.
 *
 * Wrapper responsibility (kept separate from the renderer):
 *   create PDFDocument → A4 + buffered pages → buildInvoice(...) →
 *   end → collect Buffer.
 *
 * The renderer receives only InvoiceData; it never touches the database.
 */
export async function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
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
    await buildInvoice(doc, data);
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
