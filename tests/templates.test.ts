/**
 * Message template system tests — the ONE template resolution architecture
 * shared by invoice, receipt, statement and reminder messages.
 */
import { describe, expect, it } from 'bun:test';
import {
  getInvoiceMessageTemplate,
  getReceiptMessageTemplate,
  getReminderMessageTemplate,
  getStatementMessageTemplate,
  renderTemplate,
  invoiceTemplateValues,
  receiptTemplateValues,
  statementTemplateValues,
  type MessageSettingsRow,
} from '../src/messages/templates.js';
import type { InvoiceData, ReceiptData, StatementData } from '../src/documents/types.js';
import { AppError, ErrorCode } from '../src/errors/registry.js';

const FULL_SETTINGS: MessageSettingsRow = {
  auto_send_sale: true,
  auto_send_purchase: false,
  auto_send_proforma: false,
  auto_send_receipt_in: true,
  auto_send_receipt_out: false,
  sale_message_template: 'Sale {{invoice_number}} total {{grand_total}}',
  purchase_message_template: 'Purchase {{invoice_number}}',
  proforma_message_template: 'Quote {{invoice_number}}',
  payment_in_message_template: 'Received {{payment_amount}} from {{customer_name}}, balance {{balance_due}}',
  payment_out_message_template: 'Paid {{payment_amount}} to {{customer_name}}',
  reminder_message_template: 'Reminder {{invoice_number}} due {{balance_due}}',
  payment_statement_in_message_template: 'Statement {{invoice_number}} paid {{total_paid}} of {{grand_total}} ({{payment_count}})',
  payment_statement_out_message_template: 'Statement out {{invoice_number}}',
};

describe('template resolution (per message kind)', () => {
  it('resolves the invoice template per type', () => {
    expect(getInvoiceMessageTemplate(FULL_SETTINGS, 'sale')).toBe(FULL_SETTINGS.sale_message_template);
    expect(getInvoiceMessageTemplate(FULL_SETTINGS, 'purchase')).toBe(FULL_SETTINGS.purchase_message_template);
    expect(getInvoiceMessageTemplate(FULL_SETTINGS, 'proforma')).toBe(FULL_SETTINGS.proforma_message_template);
  });

  it('resolves the receipt template per direction', () => {
    expect(getReceiptMessageTemplate(FULL_SETTINGS, 'in')).toBe(FULL_SETTINGS.payment_in_message_template);
    expect(getReceiptMessageTemplate(FULL_SETTINGS, 'out')).toBe(FULL_SETTINGS.payment_out_message_template);
  });

  it('resolves the reminder template', () => {
    expect(getReminderMessageTemplate(FULL_SETTINGS)).toBe(FULL_SETTINGS.reminder_message_template);
  });

  it('resolves the statement template per direction', () => {
    expect(getStatementMessageTemplate(FULL_SETTINGS, 'in')).toBe(FULL_SETTINGS.payment_statement_in_message_template);
    expect(getStatementMessageTemplate(FULL_SETTINGS, 'out')).toBe(FULL_SETTINGS.payment_statement_out_message_template);
  });

  it('throws WHATSAPP_TEMPLATE_MISSING for a missing required template (no invented fallback)', () => {
    const empty: MessageSettingsRow | null = null;
    expect(() => getInvoiceMessageTemplate(empty, 'sale')).toThrow(AppError);
    try {
      getReceiptMessageTemplate({ ...FULL_SETTINGS, payment_in_message_template: '  ' }, 'in');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.WHATSAPP_TEMPLATE_MISSING);
    }
  });
});

describe('token rendering', () => {
  it('substitutes known tokens and resolves unknown tokens to empty strings', () => {
    expect(renderTemplate('Hello {{customer_name}}, {{unknown_token}}!', { customer_name: 'Rahul' }))
      .toBe('Hello Rahul, !');
  });

  it('renders en-IN money values', () => {
    const values = receiptTemplateValues({
      kind: 'receipt',
      direction: 'in',
      store: { name: 'Fusion Gadgets' },
      receipt_number: 'RCP-IN-20260303-A1B2C3D4',
      date: '2026-03-03',
      party: { name: 'Rahul' },
      amount: 1000,
      payment_mode: 'UPI',
      bank_account: 'Cash',
      invoice_number: 'SAL-1',
      invoice_date: '2026-03-01',
      invoice_total: 10000,
      invoice_paid: 5000,
      invoice_due: 5000,
    } satisfies ReceiptData);
    expect(values.payment_amount).toBe('1,000.00');
    expect(values.balance_due).toBe('5,000.00');
    expect(renderTemplate('{{payment_amount}}', values)).toBe('1,000.00');
  });

  it('builds the invoice value map (payment status + due date semantics)', () => {
    const base = {
      store: { name: 'Store' },
      bill_number: 'SAL-2026-27-0001',
      date: '2026-04-01',
      party: { name: 'Asha' },
      items: [],
      subtotal: 100,
      final_total: 90,
      paid: 40,
      due: 50,
    } as unknown as InvoiceData;
    const withDue = invoiceTemplateValues({ ...base, type: 'sale' });
    expect(withDue.payment_status).toBe('Balance due');
    expect(withDue.due_date).toBe('2026-04-01');
    const paidOff = invoiceTemplateValues({ ...base, type: 'sale', due: 0, paid: 90 });
    expect(paidOff.payment_status).toBe('Paid');
    expect(paidOff.due_date).toBe('');
    const quote = invoiceTemplateValues({ ...base, type: 'proforma' });
    expect(quote.payment_status).toBe('Quotation');
  });

  it('builds the statement value map from authoritative aggregates', () => {
    const values = statementTemplateValues({
      kind: 'statement',
      direction: 'in',
      store: null,
      statement_number: 'STM-IN-1',
      date: '2026-03-03',
      party: { name: 'Rahul' },
      invoice_number: 'SAL-1',
      invoice_date: '2026-03-01',
      invoice_total: 10000,
      payments: [{ date: '2026-03-02', amount: 2500, payment_mode: 'UPI' }, { date: '2026-03-03', amount: 7500, payment_mode: null }],
      total_paid: 10000,
      balance_due: 0,
    } satisfies StatementData);
    expect(values.total_paid).toBe('10,000.00');
    expect(values.balance_due).toBe('0.00');
    expect(values.payment_count).toBe('2');
  });
});
