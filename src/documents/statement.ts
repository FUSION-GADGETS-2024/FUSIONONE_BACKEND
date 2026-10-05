/**
 * Payment-statement document builder — the Prestige statement layout
 * (payment-history table with pagination, authoritative totals, balance
 * bar, PAID IN FULL badge) over the shared document rendering primitives.
 * A statement represents ALL payments against the invoice/bill (including
 * the initial creation-time payment); the aggregates come from the
 * authoritative invoice row. Pure rendering.
 */
import type { StatementData } from './types.js';
import { PRESTIGE_COLORS as C, PRESTIGE_LAYOUT as L, fmt } from './theme.js';
import {
  loadBranding,
  drawPrestigeHeader,
  drawPartyMetaBlock,
  drawPrestigeSignature,
  drawPrestigeFooter,
  drawAmountBar,
  fmtStatementDate,
  generatePdf,
} from './render.js';

export async function buildStatement(doc: PDFKit.PDFDocument, data: StatementData): Promise<void> {
  const branding = await loadBranding(data.store);

  const marginX = L.marginX;
  const isIn = data.direction === 'in';
  const paidInFull = (data.balance_due ?? 0) <= 0;

  drawPrestigeHeader(doc, data.store, branding);

  drawPartyMetaBlock(doc, {
    party: data.party,
    partyNameFallback: 'Customer',
    label: isIn ? 'RECEIVED FROM' : 'PAID TO',
    title: 'PAYMENT STATEMENT',
    titleSize: 19,
    metaRows: [
      { label: 'STATEMENT NO.', value: data.statement_number },
      { label: 'DATE', value: fmtStatementDate(data.date) },
      ...(data.invoice_number
        ? [{ label: isIn ? 'INVOICE NO.' : 'BILL NO.', value: data.invoice_number }]
        : []),
    ],
  });

  // ── Payment history table ──────────────────────────────────────────
  let y = L.billingBorderY + 24;
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textSecondary);
  doc.text('PAYMENT HISTORY', marginX, y, { characterSpacing: 0.9 });
  y += 20;

  const tableRight = L.contentRight;
  const colDateX = marginX + 12;
  const colModeX = marginX + 220;
  const rowH = 17;

  const drawTableHeader = (headerY: number): number => {
    doc.rect(marginX, headerY, tableRight - marginX, 18).fill(C.black);
    doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.white);
    doc.text('DATE', colDateX, headerY + 5.75, { characterSpacing: 0.5 });
    doc.text('PAYMENT MODE', colModeX, headerY + 5.75, { characterSpacing: 0.5 });
    doc.text('AMOUNT', marginX, headerY + 5.75, {
      width: tableRight - marginX - 12, align: 'right', characterSpacing: 0.5,
    });
    return headerY + 18;
  };

  y = drawTableHeader(y);

  if (data.payments.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(7.1).fillColor(C.textSecondary);
    doc.text('No payments recorded yet.', marginX + 12, y + 10);
    y += 30;
  } else {
    let stripe = false;
    for (const p of data.payments) {
      // Pagination: reserve the footer band; repeat the table header on a
      // fresh page (the buffered footer pass below numbers every page).
      if (y + rowH > L.footerBarY - 8) {
        doc.addPage();
        y = drawTableHeader(L.marginX + 6);
        stripe = false;
      }
      if (stripe) {
        doc.rect(marginX, y, tableRight - marginX, rowH).fill('#FAFAFA');
      }
      stripe = !stripe;
      doc.font('Helvetica').fontSize(7.6).fillColor(C.textSecondary);
      doc.text(fmtStatementDate(p.date), colDateX, y + 4.75);
      doc.text(p.payment_mode || 'Cash', colModeX, y + 4.75);
      doc.font('Helvetica-Bold').fontSize(7.6).fillColor(C.textPrimary);
      doc.text(fmt(p.amount), marginX, y + 4.75, {
        width: tableRight - marginX - 12, align: 'right',
      });
      doc.moveTo(marginX, y + rowH).lineTo(tableRight, y + rowH)
        .lineWidth(0.5).strokeColor(C.border).stroke();
      y += rowH;
    }
  }

  // ── Totals (right-aligned; authoritative invoice state) ────────────
  // Keep the totals + balance bar + signature clear of the footer band.
  if (y + 150 > L.footerBarY - 8) {
    doc.addPage();
    y = L.marginX + 6;
  } else {
    y += 14;
  }

  const totalsX = L.totalsX;
  doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.textSecondary);
  doc.text(isIn ? 'INVOICE AMOUNT' : 'BILL AMOUNT', totalsX, y, { width: 128, align: 'left', characterSpacing: 0.5 });
  doc.font('Helvetica').fontSize(8.25).fillColor(C.textPrimary);
  doc.text(data.invoice_total !== null ? fmt(data.invoice_total) : '—', totalsX, y, { width: L.totalsW - 128, align: 'right' });
  y += L.totalsRowH;

  doc.font('Helvetica-Bold').fontSize(6.75).fillColor(C.textSecondary);
  doc.text('TOTAL PAID', totalsX, y, { width: 128, align: 'left', characterSpacing: 0.5 });
  doc.font('Helvetica-Bold').fontSize(8.25).fillColor(C.textPrimary);
  doc.text(data.total_paid !== null ? fmt(data.total_paid) : '—', totalsX, y, { width: L.totalsW - 128, align: 'right' });
  y += L.totalsRowH;

  // Balance bar (black bar, gold value — the Prestige grand-total treatment).
  y += 4;
  drawAmountBar(doc, {
    x: totalsX, w: L.totalsW, top: y,
    label: 'BALANCE DUE',
    value: data.balance_due !== null ? fmt(data.balance_due) : '—',
    valueInset: 24,
  });
  y += L.gtBlockH;

  // PAID IN FULL badge — a fully settled invoice/bill states it plainly.
  if (paidInFull && data.total_paid !== null && data.total_paid > 0) {
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#2D6A35');
    doc.text('PAID IN FULL', totalsX, y, { width: L.totalsW, align: 'right', characterSpacing: 1.125 });
    y += 14;
  }

  // ── Signature ──────────────────────────────────────────────────────
  y = Math.max(y + 34, L.billingBorderY + 250);
  drawPrestigeSignature(doc, data.store, branding, y);

  drawPrestigeFooter(doc, data.store, 'payment statement');
}

/** Generate a complete payment-statement PDF buffer. */
export async function generateStatementPdf(data: StatementData): Promise<Buffer> {
  return generatePdf((doc) => buildStatement(doc, data));
}
