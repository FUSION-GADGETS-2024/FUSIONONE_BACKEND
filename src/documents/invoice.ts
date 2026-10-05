/**
 * Invoice document builder — the Prestige invoice layout (items table,
 * trade-ins, summary/totals) over the shared document rendering primitives.
 * Pure rendering: receives InvoiceData, never touches the database.
 */
import type { InvoiceData, InvoiceLineItem, InvoiceTradeIn } from './types.js';
import {
  PRESTIGE_COLORS as C,
  PRESTIGE_LAYOUT as L,
  PRESTIGE_TABLE_HEADERS,
  PRESTIGE_TRADE_IN_HEADERS,
  fmt,
  descriptionText,
  subLineText,
  amountText,
  invoiceTitle,
  billingLabel,
} from './theme.js';
import {
  loadBranding,
  drawPrestigeHeader,
  drawPartyMetaBlock,
  drawPrestigeSignature,
  drawPrestigeFooter,
  drawAmountBar,
  numberToWords,
  generatePdf,
} from './render.js';

export async function buildInvoice(doc: PDFKit.PDFDocument, data: InvoiceData): Promise<void> {
  const branding = await loadBranding(data.store);

  let currentY = 0;
  const pageW = L.pageW;
  const pageH = L.pageH;
  const marginX = L.marginX;

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
  drawPrestigeHeader(doc, data.store, branding);
  drawPartyMetaBlock(doc, {
    party: data.party,
    partyNameFallback: 'Cash Customer',
    label: billingLabel(data.type),
    title: invoiceTitle(data.type),
    titleSize: 21,
    metaRows: [
      { label: 'INVOICE NO.', value: data.bill_number },
      { label: 'DATE', value: data.date },
    ],
  });

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

  // Grand total (black bar, gold value).
  totY += 4.5;
  drawAmountBar(doc, {
    x: rightCol, w: totalsW, top: totY,
    label: 'GRAND TOTAL', value: fmt(data.final_total), valueInset: 12,
  });
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
  drawPrestigeSignature(doc, data.store, branding, currentY);

  // ── Footer on ALL buffered pages ────────────────────────────────────────
  drawPrestigeFooter(doc, data.store, 'invoice');
}

/** Generate a complete invoice PDF buffer. */
export async function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return generatePdf((doc) => buildInvoice(doc, data));
}
