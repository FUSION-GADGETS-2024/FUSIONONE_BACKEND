/**
 * Prestige shared document theme — the single source of truth for the visual
 * design of every FUSION ONE document (Invoice, Payment Receipt, Payment
 * Statement), consumed by the PDF renderers and the thumbnail worker.
 *
 * Rules:
 *   - Pure data + pure functions only. No I/O, no business calculations.
 *   - The thumbnail worker (a separate plain-Node process) cannot import
 *     TypeScript modules; thumbnail.ts serializes PRESTIGE_COLORS +
 *     PRESTIGE_LAYOUT into the worker's environment. Keep both objects
 *     JSON-serializable.
 */
import type { InvoiceLineItem, InvoiceTradeIn, InvoiceType } from './types.js';

// ── Design tokens (Prestige) ───────────────────────────────────────────────

export const PRESTIGE_COLORS = {
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
} as const;

// ── Layout constants (calibrated against the Prestige golden raster) ──────

export const PRESTIGE_LAYOUT = {
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
} as const;

// ── Prestige header icons (SVG paths, 24-unit viewBox scaled to 10pt) ─────
// Consumed by the PDF renderer and injected into the thumbnail worker via
// THUMB_SPEC so both draw identical gold contact icons.

export const PRESTIGE_ICONS = {
  phone:
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  email: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6 12 13 2 6',
  mapPin:
    'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
} as const;

// ── Section labels (identical strings in the PDF and the thumbnail) ───────

export const PRESTIGE_TABLE_HEADERS = {
  idx: '#',
  desc: 'ITEM DESCRIPTION',
  qty: 'QTY',
  rate: 'RATE (MRP)',
  discount: 'DISCOUNT',
  amount: 'AMOUNT',
} as const;

export const PRESTIGE_TRADE_IN_HEADERS = {
  idx: '#',
  desc: 'DESCRIPTION',
  qty: 'QTY',
  amount: 'AMOUNT',
} as const;

/** The big title in the billing meta column, per invoice type (Prestige). */
export function invoiceTitle(type: InvoiceType): string {
  return type === 'proforma' ? 'QUOTATION' : type === 'sale' ? 'TAX INVOICE' : 'PURCHASE BILL';
}

/** The party column label, per invoice type (Prestige). */
export function billingLabel(type: InvoiceType): string {
  return type === 'purchase' ? 'RECEIVED FROM' : 'BILL TO';
}

// ── Formatting (ports of the proven Prestige helpers) ──────────────────────

export const fmt = (n: number): string =>
  `${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Rs.`;

// ── Item text helpers (Prestige semantics) ─────────────────────────────────

export function descriptionText(item: InvoiceLineItem | InvoiceTradeIn): string {
  return item.description || `${item.brand || ''} ${item.model || ''}`.trim();
}

/** Items: 'ram • color • IMEI: x'. Trade-ins: 'IMEI: x' only. */
export function subLineText(item: InvoiceLineItem | InvoiceTradeIn, isTradeIn: boolean): string {
  if (isTradeIn) return item.imei ? `IMEI: ${item.imei}` : '';
  const line = item as InvoiceLineItem;
  const parts = [line.ram_rom, line.color, line.imei ? `IMEI: ${line.imei}` : ''].filter(Boolean);
  return parts.join(' \u2022 ');
}

export function amountText(item: InvoiceLineItem | InvoiceTradeIn, isTradeIn: boolean): string {
  if (isTradeIn) {
    const qty = item.qty || 1;
    const rate = item.rate || (item as InvoiceTradeIn).credit_value || 0;
    return fmt(qty * rate);
  }
  const line = item as InvoiceLineItem;
  return fmt(line.value || line.price || 0);
}
