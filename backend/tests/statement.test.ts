/**
 * Payment Statement — unit tests for the NEW behavior introduced with the
 * automatic-receipts + payment-statement feature set:
 *   - buildPaymentStatementData composes the document from the authoritative
 *     invoice row + the full payment list (initial payment included,
 *     aggregates never recomputed from the list);
 *   - statementTemplateValues exposes the extended token vocabulary
 *     (total_paid / payment_count) with en-IN money formatting;
 *   - getStatementMessageTemplate fails closed on a missing template
 *     (WHATSAPP_TEMPLATE_MISSING — no invented fallback);
 *   - the shared Prestige renderer produces a valid PDF for the statement
 *     document model (multi-payment history).
 */
import { describe, test, expect } from 'bun:test';
import {
  buildStatementNumber,
  buildPaymentStatementData,
} from '../src/documents/builders.js';
import {
  getStatementMessageTemplate,
  statementTemplateValues,
  resolveStatementMessage,
} from '../src/messages/templates.js';
import { generateStatementPdf } from '../src/documents/statement.js';
import type { PaymentStatementRows } from '../src/documents/repository.js';
import { AppError } from '../src/errors/registry.js';

const ROWS: PaymentStatementRows = {
  invoice: {
    id: 'a1b2c3d4-1111-2222-3333-444455556666',
    bill_number: 'SAL-2026-27-0042',
    date: '2026-10-01',
    final_total: 10000,
    total: 10000,
    paid: 7000,
    due: 3000,
    status: 'active',
    parties: { id: 'p1', name: 'Rahul Sharma', number: '9876543210', address: 'MG Road' },
  },
  payments: [
    { id: 'pay-1', amount: '4000', date: '2026-10-01', payment_modes: { name: 'UPI' } },
    { id: 'pay-2', amount: '2000', date: '2026-10-05', payment_modes: null },
    { id: 'pay-3', amount: '1000', date: '2026-10-08', payment_modes: { name: 'Cash' } },
  ],
  store: { name: 'FUSION GADGETS', phone: '+91 90000 00000' },
};

describe('buildPaymentStatementData', () => {
  test('carries ALL payments (initial included), oldest first', () => {
    const data = buildPaymentStatementData('in', ROWS);
    expect(data.kind).toBe('statement');
    expect(data.direction).toBe('in');
    expect(data.payments.length).toBe(3);
    expect(data.payments[0]).toEqual({ date: '2026-10-01', amount: 4000, payment_mode: 'UPI' });
    expect(data.payments[1]).toEqual({ date: '2026-10-05', amount: 2000, payment_mode: null });
    expect(data.payments[2]).toEqual({ date: '2026-10-08', amount: 1000, payment_mode: 'Cash' });
  });

  test('aggregates come from the AUTHORITATIVE invoice row — never recomputed', () => {
    const data = buildPaymentStatementData('in', ROWS);
    expect(data.total_paid).toBe(7000);
    expect(data.balance_due).toBe(3000);
    expect(data.invoice_total).toBe(10000);
    expect(data.invoice_number).toBe('SAL-2026-27-0042');
  });

  test('purchase direction maps the purchase total and terminology', () => {
    const data = buildPaymentStatementData('out', ROWS);
    expect(data.direction).toBe('out');
    expect(data.invoice_total).toBe(10000); // purchases.total for the Out direction
    expect(data.statement_number.startsWith('STM-OUT-')).toBe(true);
  });

  test('statement number is deterministic per invoice + date', () => {
    const number = buildStatementNumber(ROWS.invoice.id, 'in', '2026-10-04');
    expect(number).toBe(`STM-IN-20261004-A1B2C3D4`);
  });
});

describe('statement message resolution', () => {
  const data = buildPaymentStatementData('in', ROWS);

  test('token values: en-IN money, payment_count, authoritative aggregates', () => {
    const values = statementTemplateValues(data);
    expect(values.customer_name).toBe('Rahul Sharma');
    expect(values.invoice_number).toBe('SAL-2026-27-0042');
    expect(values.grand_total).toBe('10,000.00');
    expect(values.total_paid).toBe('7,000.00');
    expect(values.balance_due).toBe('3,000.00');
    expect(values.payment_count).toBe('3');
  });

  test('resolveStatementMessage substitutes every token, unknown tokens → empty', () => {
    const message = resolveStatementMessage(
      data,
      'Statement for {{invoice_number}}: paid {{total_paid}}, due {{balance_due}}, payments {{payment_count}}, extra {{unknown_token}}',
    );
    expect(message).toBe('Statement for SAL-2026-27-0042: paid 7,000.00, due 3,000.00, payments 3, extra ');
  });

  test('missing statement template fails closed (WHATSAPP_TEMPLATE_MISSING)', () => {
    expect(() => getStatementMessageTemplate(null, 'in')).toThrow(AppError);
    expect(() => getStatementMessageTemplate({ payment_statement_in_message_template: '   ' } as any, 'in')).toThrow();
    // A present template resolves per direction.
    expect(getStatementMessageTemplate({ payment_statement_out_message_template: 'x' } as any, 'out')).toBe('x');
  });
});

describe('statement PDF (shared Prestige renderer)', () => {
  test('produces a valid %PDF- document for a multi-payment history', async () => {
    const buffer = await generateStatementPdf(buildPaymentStatementData('in', ROWS));
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('paid-in-full and zero-payment variants render too', async () => {
    const paidFull = buildPaymentStatementData('in', {
      ...ROWS,
      invoice: { ...ROWS.invoice, paid: 10000, due: 0 },
    });
    const empty = buildPaymentStatementData('out', { ...ROWS, payments: [] });
    for (const data of [paidFull, empty]) {
      const buffer = await generateStatementPdf(data);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });
});
