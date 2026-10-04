/**
 * Unified document asset contract tests — every document kind (invoice,
 * payment receipt, payment statement) prepares through the SAME pipeline
 * and returns the SAME shape: a valid PDF, a valid JPEG thumbnail (within
 * the live-verified WhatsApp envelope), the correct filename, and the PDF
 * MIME type. Exercises the REAL renderers and the REAL thumbnail worker
 * (plain-Node canvas process) — not mocks.
 */
import { describe, expect, it } from 'bun:test';
import type { InvoiceData, ReceiptData, StatementData } from '../src/documents/types.js';
import { prepareInvoiceDocument, prepareReceiptDocument, prepareStatementDocument } from '../src/documents/prepare.js';

const STORE = {
  name: 'Fusion Gadgets',
  address: 'Shop 4, Main Road',
  phone: '9999999999',
  email: 'hello@fusiongadgets.in',
  gstin: '27AAAAA0000A1Z5',
};

const INVOICE: InvoiceData = {
  type: 'sale',
  store: STORE,
  bill_number: 'SAL-2026-27-0001',
  date: '2026-04-01',
  party: { name: 'Rahul Test Customer', number: '9998887776', address: '12 MG Road' },
  items: [
    { brand: 'Apple', model: 'iPhone 15', imei: '490154203237518', ram_rom: '8/256', color: 'Black', qty: 1, rate: 75000, discount: 5000, value: 70000 },
    { brand: 'Samsung', model: 'Galaxy S23', ram_rom: '8/128', color: 'Cream', qty: 1, rate: 60000, discount: 0, value: 60000 },
  ],
  subtotal: 135000,
  item_discount: 5000,
  additional_discount: 1000,
  discount: 6000,
  final_total: 129000,
  paid: 29000,
  due: 100000,
  trade_ins: [{ brand: 'OnePlus', model: '9 Pro', imei: '111111111111111', qty: 1, rate: 8000, credit_value: 8000 }],
};

const RECEIPT: ReceiptData = {
  kind: 'receipt',
  direction: 'in',
  store: STORE,
  receipt_number: 'RCP-IN-20260401-A1B2C3D4',
  date: '2026-04-01',
  party: { name: 'Rahul Test Customer', number: '9998887776' },
  amount: 29000,
  payment_mode: 'UPI',
  bank_account: 'HDFC Current',
  invoice_number: 'SAL-2026-27-0001',
  invoice_date: '2026-04-01',
  invoice_total: 129000,
  invoice_paid: 29000,
  invoice_due: 100000,
};

const STATEMENT: StatementData = {
  kind: 'statement',
  direction: 'in',
  store: STORE,
  statement_number: 'STM-IN-20260401-A1B2C3D4',
  date: '2026-04-01',
  party: { name: 'Rahul Test Customer', number: '9998887776' },
  invoice_number: 'SAL-2026-27-0001',
  invoice_date: '2026-04-01',
  invoice_total: 129000,
  payments: [
    { date: '2026-04-01', amount: 10000, payment_mode: 'Cash' },
    { date: '2026-04-03', amount: 19000, payment_mode: 'UPI' },
  ],
  total_paid: 29000,
  balance_due: 100000,
};

const isPdf = (b: Buffer): boolean => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isJpeg = (b: Buffer): boolean => b[0] === 0xff && b[1] === 0xd8;

/** The live-verified WhatsApp thumbnail envelope (documents/thumbnail.ts). */
const THUMBNAIL_WIDTH_PX = 444;
const THUMBNAIL_MAX_HEIGHT_PX = 250;

describe('the unified document asset contract (all kinds, one pipeline)', () => {
  it('invoice → PDF + thumbnail + filename + MIME type', async () => {
    const doc = await prepareInvoiceDocument(INVOICE);
    expect(isPdf(doc.pdf)).toBe(true);
    expect(doc.fileName).toBe('SAL-2026-27-0001.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.thumbnail).not.toBeNull();
    expect(isJpeg(doc.thumbnail!.jpeg)).toBe(true);
    expect(doc.thumbnail!.width).toBe(THUMBNAIL_WIDTH_PX);
    expect(doc.thumbnail!.height).toBeGreaterThan(0);
    expect(doc.thumbnail!.height).toBeLessThanOrEqual(THUMBNAIL_MAX_HEIGHT_PX);
  });

  it('payment receipt → PDF + thumbnail + filename + MIME type (no longer PDF-only)', async () => {
    const doc = await prepareReceiptDocument(RECEIPT);
    expect(isPdf(doc.pdf)).toBe(true);
    expect(doc.fileName).toBe('RCP-IN-20260401-A1B2C3D4.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.thumbnail).not.toBeNull();
    expect(isJpeg(doc.thumbnail!.jpeg)).toBe(true);
    expect(doc.thumbnail!.width).toBe(THUMBNAIL_WIDTH_PX);
    expect(doc.thumbnail!.height).toBeGreaterThan(0);
    expect(doc.thumbnail!.height).toBeLessThanOrEqual(THUMBNAIL_MAX_HEIGHT_PX);
  });

  it('payment statement → PDF + thumbnail + filename + MIME type (no longer PDF-only)', async () => {
    const doc = await prepareStatementDocument(STATEMENT);
    expect(isPdf(doc.pdf)).toBe(true);
    expect(doc.fileName).toBe('STM-IN-20260401-A1B2C3D4.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.thumbnail).not.toBeNull();
    expect(isJpeg(doc.thumbnail!.jpeg)).toBe(true);
    expect(doc.thumbnail!.width).toBe(THUMBNAIL_WIDTH_PX);
    expect(doc.thumbnail!.height).toBeGreaterThan(0);
    expect(doc.thumbnail!.height).toBeLessThanOrEqual(THUMBNAIL_MAX_HEIGHT_PX);
  });
});
