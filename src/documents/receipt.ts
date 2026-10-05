/**
 * Payment-receipt document builder — the Prestige receipt layout (payment
 * details, amount bar, amount in words) over the shared document rendering
 * primitives. The receipt represents the payment that actually occurred:
 * the amount is the payment record's amount; invoice figures are contextual
 * reference lines only. One page by construction. Pure rendering.
 */
import type { ReceiptData } from './types.js';
import { PRESTIGE_COLORS as C, PRESTIGE_LAYOUT as L, fmt } from './theme.js';
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

export async function buildReceipt(doc: PDFKit.PDFDocument, data: ReceiptData): Promise<void> {
  const branding = await loadBranding(data.store);

  const pageW = L.pageW;
  const marginX = L.marginX;
  const isIn = data.direction === 'in';

  drawPrestigeHeader(doc, data.store, branding);

  drawPartyMetaBlock(doc, {
    party: data.party,
    partyNameFallback: 'Customer',
    label: isIn ? 'RECEIVED FROM' : 'PAID TO',
    title: 'PAYMENT RECEIPT',
    titleSize: 21,
    metaRows: [
      { label: 'RECEIPT NO.', value: data.receipt_number },
      { label: 'DATE', value: data.date },
      ...(data.invoice_number ? [{ label: 'INVOICE NO.', value: data.invoice_number }] : []),
    ],
  });

  // ── Payment details ────────────────────────────────────────────────
  let y = L.billingBorderY + 24;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textSecondary);
  doc.text('PAYMENT DETAILS', marginX, y, { characterSpacing: 0.9 });
  y += 20;

  const detailRow = (label: string, value: string | null, bold = false): void => {
    if (value === null) return;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.25)
      .fillColor(bold ? C.textPrimary : C.textSecondary);
    doc.text(label, marginX, y);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(C.textPrimary);
    doc.text(value, marginX, y, { width: pageW - marginX * 2, align: 'right' });
    y += 17;
  };

  detailRow('Payment Amount', fmt(data.amount), true);
  detailRow('Payment Mode', data.payment_mode || 'Cash');
  detailRow('Account', data.bank_account);
  detailRow('Invoice Total', data.invoice_total !== null ? fmt(data.invoice_total) : null);
  detailRow(isIn ? 'Total Received on Invoice' : 'Total Paid on Invoice', data.invoice_paid !== null ? fmt(data.invoice_paid) : null);
  detailRow('Balance Due', data.invoice_due !== null ? fmt(data.invoice_due) : null);

  // Amount bar (black bar, gold value — the Prestige grand-total treatment).
  y += 6;
  drawAmountBar(doc, {
    x: marginX, w: pageW - marginX * 2, top: y,
    label: isIn ? 'AMOUNT RECEIVED' : 'AMOUNT PAID',
    value: fmt(data.amount),
    valueInset: 24,
  });
  y += L.gtBlockH;

  // ── Amount in words ────────────────────────────────────────────────
  y += 18;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textLight);
  doc.text('AMOUNT IN WORDS', marginX, y, { characterSpacing: 0.9 });
  doc.font('Helvetica-Oblique').fontSize(7.1).fillColor(C.textPrimary);
  doc.text(numberToWords(Math.round(data.amount)), marginX, y + 14, { width: 320 });

  // ── Signature ──────────────────────────────────────────────────────
  y = Math.max(y + 70, L.billingBorderY + 250);
  drawPrestigeSignature(doc, data.store, branding, y);

  drawPrestigeFooter(doc, data.store, 'payment receipt');
}

/** Generate a complete payment-receipt PDF buffer. */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return generatePdf((doc) => buildReceipt(doc, data));
}
