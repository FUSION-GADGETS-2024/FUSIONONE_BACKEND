/**
 * Invoice PDF renderer — PDFKit BROWSER build (client-side local download).
 *
 * The exact same template as the reference Next.js server renderer — every
 * coordinate, font size, color, and pagination rule preserved. Only the
 * execution environment changed (the rebuild spec: PDFKit runs IN THE
 * BROWSER; the output adapter collects bytes into a Blob instead of a Node
 * Buffer).
 *
 * The standalone build (pdfkit/js/pdfkit.standalone.js) bundles the standard
 * fonts and a stream shim; it is loaded via dynamic import so the ~1.5MB
 * chunk stays OUT of the initial bundle (loaded only when a PDF is requested).
 */
import type { InvoiceData, InvoiceLineItem, InvoiceTradeIn } from '../types'

// PDFKit's module type is its PDFDocument instance type (@types/pdfkit
// declares the global PDFKit namespace).
type PDFDocument = PDFKit.PDFDocument

// ── Formatting (ports of the proven Prestige helpers) ──────────────────────

const fmt = (n: number): string =>
  `${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Rs.`;

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

// ── Design tokens (Prestige) ───────────────────────────────────────────────

const C = {
  black: '#111111',
  gold: '#C9A227',
  white: '#FFFFFF',
  textPrimary: '#111111',
  textSecondary: '#6B7280',
  textLight: '#9CA3AF',
  border: '#E5E7EB',
  tradeInBg: '#F6FBF6',
  tradeInText: '#2D6A35',
  tradeInSub: '#4B8B55',
  tradeInBorder: '#D1EAD4',
};

// ── Layout constants (calibrated against the Prestige golden raster) ──────

const L = {
  pageW: 595.28,
  pageH: 841.89,
  marginX: 33,
  bottomMargin: 40,
  contentRight: 595.28 - 33, // 562.28
  // Header
  goldBarH: 2.25,
  headerStartY: 18.25, // goldBar + paddingTop 16
  headerBorderY: 71.3, // measured
  // Billing
  billingLabelY: 71.3 + 24, // 95.3 (paddingTop 24)
  billingBorderY: 190.7, // measured (label+name+address+contact present)
  // Items
  itemsLabelY: 190.7 + 15, // 205.7 (paddingTop 15)
  tableHeaderY: 225.3, // measured (label bottom + paddingBottom 7.5)
  tableHeaderH: 21.75,
  // Columns (Prestige percentages of the 511.28pt padded row box)
  col: {
    // row content box: [42, 553.28]
    idx: { x: 42, w: 25.56, align: 'left' as const },
    desc: { x: 67.56, w: 224.96, align: 'left' as const },
    qty: { x: 292.52, w: 46.02, align: 'center' as const },
    rate: { x: 330, w: 90.35, align: 'right' as const }, // right edge 420.35
    discount: { x: 395, w: 81.59, align: 'right' as const }, // right edge 476.59
    amount: { x: 465, w: 88.28, align: 'right' as const }, // right edge 553.28
  },
  rowPadV: 10.5,
  rowFudge: 8, // React-PDF line-height vs PDFKit heightOfString delta
  // Summary
  summaryPadTop: 21,
  totalsX: 329.4, // contentRight - 232.88
  totalsW: 232.88,
  totalsRowH: 18.5,
  gtBlockH: 30,
  // Signature
  sigBlockW: 142.5,
  // Footer
  footerH: 24,
  footerBarY: 841.89 - 24, // 817.89
};

// ── Branding images ────────────────────────────────────────────────────────

const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Uint8Array): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Fetch a logo/signature image URL and return bytes PDFKit can embed
 * (JPEG or PNG only). Returns null on any failure so the renderer falls
 * back to the imageless Prestige variant (initials box / signature line).
 */
async function fetchImageData(url: string | undefined | null): Promise<Uint8Array | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!isJpeg(buf) && !isPng(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

interface Branding {
  logo: Uint8Array | null;
  signature: Uint8Array | null;
}

// ── Prestige header icons (SVG paths, 24-unit viewBox scaled to 10pt) ─────

const ICON_PHONE = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';
const ICON_EMAIL = 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6 12 13 2 6';
const ICON_MAPPIN = 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z';

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

// ── Item text helpers (Prestige semantics) ─────────────────────────────────

function descriptionText(item: InvoiceLineItem | InvoiceTradeIn): string {
  return item.description || `${item.brand || ''} ${item.model || ''}`.trim();
}

/** Items: 'ram • color • IMEI: x'. Trade-ins: 'IMEI: x' only. */
function subLineText(item: InvoiceLineItem | InvoiceTradeIn, isTradeIn: boolean): string {
  if (isTradeIn) return item.imei ? `IMEI: ${item.imei}` : '';
  const line = item as InvoiceLineItem;
  const parts = [line.ram_rom, line.color, line.imei ? `IMEI: ${line.imei}` : ''].filter(Boolean);
  return parts.join(' \u2022 ');
}

function amountText(item: InvoiceLineItem | InvoiceTradeIn, isTradeIn: boolean): string {
  if (isTradeIn) {
    const qty = item.qty || 1;
    const rate = item.rate || (item as InvoiceTradeIn).credit_value || 0;
    return fmt(qty * rate);
  }
  const line = item as InvoiceLineItem;
  return fmt(line.value || line.price || 0);
}

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
      doc.image(branding.logo as unknown as Buffer, marginX, L.headerStartY, { fit: [36, 36], align: 'center' });
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
    if (data.store?.phone) contactLine(data.store.phone, ICON_PHONE, 110);
    if (data.store?.email) contactLine(data.store.email, ICON_EMAIL, 110);
    if (data.store?.address) {
      // Prestige renders the address as ONE unwrapped right-aligned line.
      contactLine(data.store.address.split('\n').join(', '), ICON_MAPPIN, 240);
    }

    // Header bottom border (1.5 black — spans the FULL page width, like Prestige)
    doc.moveTo(0, L.headerBorderY).lineTo(pageW, L.headerBorderY)
      .lineWidth(1.5).stroke(C.black);
  };

  // ── Billing + invoice meta ──────────────────────────────────────────────
  const drawBilling = (): void => {
    const labelY = L.billingLabelY;

    doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.gold);
    doc.text(data.type === 'purchase' ? 'RECEIVED FROM' : 'BILL TO', marginX, labelY, { characterSpacing: 0.9 });

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
    const title = data.type === 'proforma' ? 'QUOTATION' : data.type === 'sale' ? 'TAX INVOICE' : 'PURCHASE BILL';
    doc.font('Helvetica-Bold').fontSize(21).fillColor(C.black);
    doc.text(title, metaX, labelY - 5);

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
    doc.text('#', L.col.idx.x, currentY + 7.5, { width: L.col.idx.w, align: L.col.idx.align, characterSpacing: 0.6 });
    doc.text('ITEM DESCRIPTION', L.col.desc.x, currentY + 7.5, { width: L.col.desc.w, align: L.col.desc.align, characterSpacing: 0.6 });
    doc.text('QTY', L.col.qty.x, currentY + 7.5, { width: L.col.qty.w, align: L.col.qty.align, characterSpacing: 0.6 });
    doc.text('RATE (MRP)', L.col.rate.x, currentY + 7.5, { width: L.col.rate.w, align: L.col.rate.align, characterSpacing: 0.6 });
    doc.text('DISCOUNT', L.col.discount.x, currentY + 7.5, { width: L.col.discount.w, align: L.col.discount.align, characterSpacing: 0.6 });
    doc.text('AMOUNT', L.col.amount.x, currentY + 7.5, { width: L.col.amount.w, align: L.col.amount.align, characterSpacing: 0.6 });
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
    doc.text('#', L.col.idx.x, currentY + 7.5, { width: L.col.idx.w, align: L.col.idx.align, characterSpacing: 0.6 });
    doc.text('DESCRIPTION', L.col.desc.x, currentY + 7.5, { width: L.col.desc.w, align: L.col.desc.align, characterSpacing: 0.6 });
    doc.text('QTY', L.col.qty.x, currentY + 7.5, { width: L.col.qty.w, align: L.col.qty.align, characterSpacing: 0.6 });
    doc.text('AMOUNT', L.col.amount.x, currentY + 7.5, { width: L.col.amount.w, align: L.col.amount.align, characterSpacing: 0.6 });
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

  // Grand total (black bar, gold value).
  // Vertical centering: PDFKit anchors the first line's baseline at
  // y + ascender·size/1000 and, for the standard Helvetica faces, the
  // ascender (718/1000 em) equals the cap height — the visible box of these
  // all-caps/digit strings therefore spans [y, y + 0.718·size]. Anchoring
  // that box on the bar's midline (instead of pinning its top edge with a
  // fixed offset) keeps the top/bottom gaps balanced for both font sizes
  // and every amount width.
  totY += 4.5;
  const gtMidY = totY + L.gtBlockH / 2;
  doc.rect(rightCol, totY, totalsW, L.gtBlockH).fill(C.black);
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.white);
  doc.text('GRAND TOTAL', rightCol + 12, gtMidY - (718 / 2000) * 8.25, { characterSpacing: 0.75 });
  doc.font('Helvetica-Bold').fontSize(11.25).fillColor(C.gold);
  doc.text(fmt(data.final_total), rightCol, gtMidY - (718 / 2000) * 11.25, { width: totalsW - 12, align: 'right', characterSpacing: 0.375 });
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
    // The signature image occupies the SAME centered column as the line and
    // the texts below it: the 75×30 fit box (aspect preserved for any asset
    // dimensions) is centered over the block, and align/valign center the
    // scaled image inside that box.
    doc.image(branding.signature as unknown as Buffer, sigX + (L.sigBlockW - 75) / 2, sigCursorY, {
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
 * Generate a complete invoice PDF as a Blob (browser download).
 *
 * Wrapper responsibility (kept separate from the renderer):
 *   dynamic-import the PDFKit BROWSER build (code-split) →
 *   create PDFDocument → A4 + buffered pages → buildInvoice(...) →
 *   end → collect chunks into a Blob.
 *
 * The renderer receives only InvoiceData; it never touches the database.
 */
export async function generateInvoicePdf(data: InvoiceData): Promise<Blob> {
  // pdfkit's exports map resolves to the dedicated BROWSER ESM build
  // (js/pdfkit.browser.mjs — self-contained: no fs, bundled fontkit).
  // The browser build requires the standard fonts to be registered
  // explicitly — the three faces this template uses (the exact same AFM
  // metric data the Node build loads from disk).
  const [pdfkitModule, helv, helvBold, helvOblique] = await Promise.all([
    import('pdfkit'),
    import('pdfkit/standard-fonts/Helvetica'),
    import('pdfkit/standard-fonts/HelveticaBold'),
    import('pdfkit/standard-fonts/HelveticaOblique'),
  ])
  // registerStdFonts exists on the browser build's module (not in the Node types).
  const register = (pdfkitModule as unknown as { registerStdFonts: (...fonts: unknown[]) => void }).registerStdFonts
  register(helv.default, helvBold.default, helvOblique.default)
  const PDFDocument = pdfkitModule.default;

  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    bufferPages: true,
    autoFirstPage: true,
  });

  const chunks: Uint8Array[] = [];
  doc.on('data', (c: unknown) => {
    if (c instanceof Uint8Array) chunks.push(c)
    else if (c && typeof c === 'object' && 'buffer' in (c as Record<string, unknown>)) {
      // The standalone build may hand out Buffer-like objects.
      const b = c as unknown as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number }
      chunks.push(new Uint8Array(b.buffer, b.byteOffset ?? 0, b.byteLength ?? (b.buffer as ArrayBuffer).byteLength))
    } else if (typeof c === 'string') {
      chunks.push(new TextEncoder().encode(c))
    }
  });
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  try {
    await buildInvoice(doc, data);
    doc.end();
    await done;

    const blob = new Blob(chunks as BlobPart[], { type: 'application/pdf' })
    if (blob.size === 0) {
      throw new Error('Invoice PDF generation produced invalid output (0 bytes).')
    }
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer())
    const magic = String.fromCharCode(...head)
    if (magic !== '%PDF-') {
      throw new Error('Invoice PDF generation produced invalid output.')
    }
    return blob
  } catch (err) {
    try { doc.end() } catch { /* already ended */ }
    if (err instanceof Error) throw err
    throw new Error('Invoice PDF generation failed.')
  }
}
